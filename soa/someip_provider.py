"""SOME/IP provider: connects the comfort services on SOME/IP to Kuksa Databroker (kuksa.val.v2).

  Kuksa -> SOME/IP   Registers as provider for the window and wiper actuators. Actuate() calls
                     become WindowControl.SetPosition / WiperControl.SetMode method calls.
  SOME/IP -> Kuksa   WindowStatus / WiperStatus events are published as VSS values.
  Kuksa -> SOME/IP   Vehicle.Body.Raindetection.Intensity is offered as the Environment service
                     (RainStatus event), which the comfort ECU consumes for its rain-sensor mode.

Needs a running someipy daemon (`someipyd`) on this host, see run_with_daemon.sh.

    python someip_provider.py --kuksa 127.0.0.1:55555 --ip 127.0.0.1
"""

from __future__ import annotations

import argparse
import asyncio
import logging

import grpc
from kuksa.val.v2 import types_pb2, val_pb2, val_pb2_grpc
from someipy import ClientServiceInstance, MessageType, ReturnCode, ServerServiceInstance, connect_to_someipy_daemon
from someipy.someipy_logging import set_someipy_log_level

import interfaces as itf
from interfaces import Result, WiperMode

WINDOW_POSITION = [f"Vehicle.Cabin.Door.{w}.Window.Position" for w in itf.WINDOWS]
WIPER_MODE = "Vehicle.Body.Windshield.Front.Wiping.Mode"
WIPER_FREQUENCY = "Vehicle.Body.Windshield.Front.Wiping.System.Frequency"
WIPER_IS_WIPING = "Vehicle.Body.Windshield.Front.Wiping.System.IsWiping"
RAIN = "Vehicle.Body.Raindetection.Intensity"
PROVIDED = [*WINDOW_POSITION, WIPER_MODE]

log = logging.getLogger("someip-provider")


class StreamEnded(Exception):
    """A Kuksa stream finished without an error, e.g. because the databroker shut down gracefully."""


def vss_value(path: str, value) -> types_pb2.Value:
    if path == WIPER_MODE:
        return types_pb2.Value(string=value)
    if path == WIPER_IS_WIPING:
        return types_pb2.Value(bool=bool(value))
    return types_pb2.Value(uint32=int(value))  # uint8 signals travel as uint32


def from_value(value: types_pb2.Value):
    kind = value.WhichOneof("typed_value")
    return getattr(value, kind) if kind else None


class SomeIpProvider:
    def __init__(self, kuksa: str, ip: str, socket_path: str | None):
        self.kuksa_addr = kuksa
        self.ip = ip
        self.socket_path = socket_path
        self.stub: val_pb2_grpc.VALStub | None = None
        self.by_id: dict[int, str] = {}
        self.published: dict[str, object] = {}
        self.outbox: asyncio.Queue = asyncio.Queue()  # (path, value), published in order
        self.rain = 0
        # someipy 2.1 matches daemon replies to FindService requests by arrival order only, so
        # concurrent calls from different client instances can pick up each other's service
        # endpoint (a window request then lands on the wiper service). One call at a time.
        self.call_lock = asyncio.Lock()

    # --- SOME/IP ------------------------------------------------------------------------

    async def setup_someip(self) -> None:
        daemon = await connect_to_someipy_daemon({"socket_path": self.socket_path} if self.socket_path else None)
        window_svc, window_eg = itf.window_service()
        wiper_svc, wiper_eg = itf.wiper_service()
        env_svc, _ = itf.environment_service()
        self.windows = ClientServiceInstance(daemon=daemon, service=window_svc, instance_id=itf.INSTANCE_ID,
                                             endpoint_ip=self.ip, endpoint_port=30521)
        self.wipers = ClientServiceInstance(daemon=daemon, service=wiper_svc, instance_id=itf.INSTANCE_ID,
                                            endpoint_ip=self.ip, endpoint_port=30522)
        self.environment = ServerServiceInstance(daemon=daemon, service=env_svc, instance_id=itf.INSTANCE_ID,
                                                 endpoint_ip=self.ip, endpoint_port=30523, ttl=5,
                                                 cyclic_offer_delay_ms=1000)
        self.windows.register_callback(self.on_window_event)
        self.wipers.register_callback(self.on_wiper_event)
        self.windows.subscribe_eventgroup(window_eg, 5)
        self.wipers.subscribe_eventgroup(wiper_eg, 5)
        await self.environment.start_offer()
        log.info("SOME/IP: consuming WindowControl/WiperControl, offering Environment on %s", self.ip)

    def on_window_event(self, event_id: int, payload: bytes) -> None:
        if event_id == itf.WINDOW_STATUS_EVENT:
            for path, pos in zip(WINDOW_POSITION, itf.WindowStatus().deserialize(payload).positions()):
                self.outbox.put_nowait((path, pos))

    def on_wiper_event(self, event_id: int, payload: bytes) -> None:
        if event_id == itf.WIPER_STATUS_EVENT:
            status = itf.WiperStatus().deserialize(payload)
            self.outbox.put_nowait((WIPER_MODE, WiperMode(status.mode.value).name))
            self.outbox.put_nowait((WIPER_FREQUENCY, status.frequency.value))
            self.outbox.put_nowait((WIPER_IS_WIPING, bool(status.is_wiping.value)))

    async def call(self, client: ClientServiceInstance, method_id: int, payload: bytes, what: str) -> None:
        async with self.call_lock:
            try:
                if not await client.is_available():
                    log.warning("%s: service not available (is the comfort ECU running?)", what)
                    return
                result = await client.call_method(method_id, payload)
            except (asyncio.TimeoutError, ConnectionError) as err:
                log.warning("%s: no response (%s)", what, type(err).__name__)
                return
        if result.message_type != MessageType.RESPONSE or result.return_code != ReturnCode.E_OK:
            log.warning("%s: SOME/IP error %s", what, result.return_code)
            return
        code = Result(itf.ResultResponse().deserialize(result.payload).result.value)
        log.info("%s -> %s", what, code.name)

    async def rain_cycle(self) -> None:
        """Cyclic RainStatus (1 s); changes are sent immediately from the Kuksa subscription."""
        while True:
            self.environment.send_event(itf.EVENTGROUP_ID, itf.RAIN_STATUS_EVENT, itf.RainStatus(self.rain).serialize())
            await asyncio.sleep(1.0)

    # --- Kuksa --------------------------------------------------------------------------

    async def publisher(self) -> None:
        while True:
            path, value = await self.outbox.get()
            stub = self.stub
            if stub is None or self.published.get(path) == value:
                continue
            try:
                await stub.PublishValue(val_pb2.PublishValueRequest(
                    signal_id=types_pb2.SignalID(path=path),
                    data_point=types_pb2.Datapoint(value=vss_value(path, value))))
                self.published[path] = value
            except grpc.RpcError as err:
                log.debug("publish %s failed: %s", path, err.code().name)

    async def provide(self, stub) -> None:
        requests: asyncio.Queue = asyncio.Queue()
        await requests.put(val_pb2.OpenProviderStreamRequest(provide_actuation_request=val_pb2.ProvideActuationRequest(
            actuator_identifiers=[types_pb2.SignalID(path=p) for p in PROVIDED])))

        async def request_iter():
            while True:
                yield await requests.get()

        async for response in stub.OpenProviderStream(request_iter()):
            if response.HasField("provide_actuation_response"):
                log.info("providing %d actuators via SOME/IP", len(PROVIDED))
            elif response.HasField("batch_actuate_stream_request"):
                for req in response.batch_actuate_stream_request.actuate_requests:
                    path = req.signal_id.path or self.by_id.get(req.signal_id.id)
                    asyncio.create_task(self.on_actuate(path, from_value(req.value)))
        raise StreamEnded("provider stream closed by the databroker")

    async def on_actuate(self, path: str, value) -> None:
        if path in WINDOW_POSITION:
            window = WINDOW_POSITION.index(path)
            await self.call(self.windows, itf.WINDOW_SET_POSITION,
                            itf.SetPositionRequest(window, int(value)).serialize(),
                            f"WindowControl.SetPosition({itf.WINDOWS[window]}, {value})")
        elif path == WIPER_MODE:
            try:
                mode = WiperMode[value]
            except KeyError:
                log.warning("unknown wiper mode %r", value)
                return
            await self.call(self.wipers, itf.WIPER_SET_MODE, itf.SetModeRequest(mode).serialize(),
                            f"WiperControl.SetMode({mode.name})")

    async def follow_rain(self, stub) -> None:
        async for response in stub.Subscribe(val_pb2.SubscribeRequest(signal_paths=[RAIN])):
            value = from_value(response.entries[RAIN].value) if RAIN in response.entries else None
            if value is not None and int(value) != self.rain:
                self.rain = int(value)
                self.environment.send_event(itf.EVENTGROUP_ID, itf.RAIN_STATUS_EVENT,
                                            itf.RainStatus(self.rain).serialize())
        raise StreamEnded("rain subscription closed by the databroker")

    async def run(self) -> None:
        await self.setup_someip()
        asyncio.create_task(self.publisher())
        asyncio.create_task(self.rain_cycle())
        while True:
            try:
                async with grpc.aio.insecure_channel(self.kuksa_addr) as channel:
                    stub = val_pb2_grpc.VALStub(channel)
                    info = await stub.GetServerInfo(val_pb2.GetServerInfoRequest())
                    log.info("connected to %s %s at %s", info.name, info.version, self.kuksa_addr)
                    metadata = await stub.ListMetadata(val_pb2.ListMetadataRequest(root="Vehicle"))
                    self.by_id = {m.id: m.path for m in metadata.metadata}
                    self.published.clear()
                    self.stub = stub
                    tasks = [asyncio.create_task(self.provide(stub)), asyncio.create_task(self.follow_rain(stub))]
                    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
                    for t in pending:
                        t.cancel()
                    for t in done:
                        t.result()  # re-raise
            except grpc.RpcError as err:
                log.warning("kuksa %s: %s; reconnecting in 2 s", err.code().name, err.details())
            except StreamEnded as err:
                log.warning("%s; reconnecting in 2 s", err)
            self.stub = None
            await asyncio.sleep(2)


def main() -> None:
    parser = argparse.ArgumentParser(description="SOME/IP <-> Kuksa Databroker provider (kuksa.val.v2)")
    parser.add_argument("--kuksa", default="127.0.0.1:55555", help="Kuksa Databroker address")
    parser.add_argument("--ip", default="127.0.0.1", help="IP address of this node on the SOME/IP network")
    parser.add_argument("--socket", default=None, help="someipy daemon socket path (default /tmp/someipyd.sock)")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s", datefmt="%H:%M:%S")
    set_someipy_log_level(logging.WARNING)
    try:
        asyncio.run(SomeIpProvider(args.kuksa, args.ip, args.socket).run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
