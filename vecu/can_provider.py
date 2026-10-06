"""CAN provider: connects a CAN bus to Kuksa Databroker (kuksa.val.v2).

Modelled on Eclipse Kuksa's CAN provider (DBC file + VSS<->DBC mapping with the same
`dbc2vss` / `vss2dbc` blocks and `mapping` transforms), but using the v2 API so that it can
act as the actuation *provider*:

  vss2dbc, actuators  Kuksa routes Actuate() calls here (OpenProviderStream). Each request is
                      encoded into its command signal, the message's *Counter signal is bumped
                      and the frame is sent at once, then repeated with its cycle time.
  vss2dbc, sensors    Subscribed in Kuksa; latest value is sent cyclically (e.g. ESP_Status).
  dbc2vss             Frames received from ECUs are decoded and published with PublishValue.

    python can_provider.py --kuksa 127.0.0.1:55555 --interface udp_multicast
"""

from __future__ import annotations

import argparse
import json
import logging
import queue
import threading
import time
from dataclasses import dataclass, field

import grpc
from kuksa.val.v2 import types_pb2, val_pb2, val_pb2_grpc

from canbus import DEFAULT_MAPPING, add_bus_arguments, default_values, encode, load_dbc, open_bus

NODE = "GW"
log = logging.getLogger("can-provider")

# kuksa.val.v2 DataType -> Value oneof field
VALUE_FIELD = {
    types_pb2.DATA_TYPE_BOOLEAN: "bool", types_pb2.DATA_TYPE_STRING: "string",
    types_pb2.DATA_TYPE_INT8: "int32", types_pb2.DATA_TYPE_INT16: "int32", types_pb2.DATA_TYPE_INT32: "int32",
    types_pb2.DATA_TYPE_INT64: "int64",
    types_pb2.DATA_TYPE_UINT8: "uint32", types_pb2.DATA_TYPE_UINT16: "uint32", types_pb2.DATA_TYPE_UINT32: "uint32",
    types_pb2.DATA_TYPE_UINT64: "uint64",
    types_pb2.DATA_TYPE_FLOAT: "float", types_pb2.DATA_TYPE_DOUBLE: "double",
}


def apply_transform(spec: dict, value):
    """Applies a mapping transform ({"mapping": [{"from": a, "to": b}]}); identity without one."""
    transform = spec.get("transform")
    if not transform:
        return value
    for entry in transform.get("mapping", []):
        if entry["from"] == value or str(entry["from"]) == str(value):
            return entry["to"]
    raise ValueError(f"no mapping for {value!r} in {spec['signal']}")


class StreamEnded(Exception):
    """A Kuksa stream finished without an error, e.g. because the databroker shut down gracefully."""


@dataclass
class Signal:
    path: str
    id: int
    data_type: int
    entry_type: int

    def to_value(self, v) -> types_pb2.Value:
        kind = VALUE_FIELD[self.data_type]
        if kind in ("int32", "int64", "uint32", "uint64"):
            v = int(round(float(v)))
        elif kind in ("float", "double"):
            v = float(v)
        return types_pb2.Value(**{kind: v})


def from_value(value: types_pb2.Value):
    kind = value.WhichOneof("typed_value")
    return getattr(value, kind) if kind else None


@dataclass
class TxMessage:
    message: object
    values: dict
    counter: str | None
    next_due: float = 0.0
    lock: threading.Lock = field(default_factory=threading.Lock)


class CanProvider:
    def __init__(self, args):
        self.args = args
        self.db = load_dbc(args.dbc)
        self.mapping: dict[str, dict] = json.load(open(args.mapping))
        self.bus = open_bus(args.interface, args.channel)
        self.signals: dict[str, Signal] = {}
        self.by_id: dict[int, str] = {}
        self.published: dict[str, object] = {}
        self.stub: val_pb2_grpc.VALStub | None = None  # current Kuksa connection, None while offline

        # Messages this node transmits, with their current signal values.
        self.tx: dict[str, TxMessage] = {}
        for message in self.db.messages:
            if NODE in message.senders:
                counter = next((s.name for s in message.signals if s.name.endswith("Counter")), None)
                self.tx[message.name] = TxMessage(message, default_values(message), counter)
        # dbc signal name -> (vss path, spec) for the receive direction
        self.rx_map: dict[str, list[tuple[str, dict]]] = {}
        for path, spec in self.mapping.items():
            if "dbc2vss" in spec:
                self.rx_map.setdefault(spec["dbc2vss"]["signal"], []).append((path, spec["dbc2vss"]))

    def message_of(self, signal_name: str) -> TxMessage:
        for tx in self.tx.values():
            if any(s.name == signal_name for s in tx.message.signals):
                return tx
        raise KeyError(f"{signal_name} is not in a message sent by {NODE}")

    # --- Kuksa --------------------------------------------------------------------------

    def load_metadata(self, stub) -> None:
        for m in stub.ListMetadata(val_pb2.ListMetadataRequest(root="Vehicle")).metadata:
            if m.path in self.mapping:
                self.signals[m.path] = Signal(m.path, m.id, m.data_type, m.entry_type)
                self.by_id[m.id] = m.path
        missing = set(self.mapping) - set(self.signals)
        if missing:
            raise SystemExit(f"Mapped paths missing in Kuksa: {sorted(missing)}")

    def publish(self, stub, path: str, value) -> None:
        if self.published.get(path) == value:
            return
        sig = self.signals[path]
        stub.PublishValue(val_pb2.PublishValueRequest(
            signal_id=types_pb2.SignalID(path=path),
            data_point=types_pb2.Datapoint(value=sig.to_value(value)),
        ))
        self.published[path] = value
        log.debug("CAN -> VSS %s = %s", path, value)

    def actuators(self) -> list[str]:
        return [p for p, spec in self.mapping.items()
                if "vss2dbc" in spec and self.signals[p].entry_type == types_pb2.ENTRY_TYPE_ACTUATOR]

    def sensors_to_can(self) -> list[str]:
        return [p for p, spec in self.mapping.items()
                if "vss2dbc" in spec and self.signals[p].entry_type != types_pb2.ENTRY_TYPE_ACTUATOR]

    def run_provider(self, stub) -> None:
        """Claims the mapped actuators and turns actuation requests into CAN commands."""
        requests: queue.Queue = queue.Queue()
        requests.put(val_pb2.OpenProviderStreamRequest(provide_actuation_request=val_pb2.ProvideActuationRequest(
            actuator_identifiers=[types_pb2.SignalID(path=p) for p in self.actuators()])))
        for response in stub.OpenProviderStream(iter(requests.get, None)):
            if response.HasField("provide_actuation_response"):
                log.info("providing %d actuators via CAN", len(self.actuators()))
            elif response.HasField("batch_actuate_stream_request"):
                self.on_actuate(response.batch_actuate_stream_request.actuate_requests)

    def on_actuate(self, actuate_requests) -> None:
        touched: dict[str, dict[str, object]] = {}
        for req in actuate_requests:
            path = req.signal_id.path or self.by_id.get(req.signal_id.id)
            if path not in self.mapping:
                log.warning("actuation for unmapped signal %s", path)
                continue
            spec = self.mapping[path]["vss2dbc"]
            value = from_value(req.value)
            try:
                raw = apply_transform(spec, value)
            except ValueError as err:
                log.warning("%s", err)
                continue
            tx = self.message_of(spec["signal"])
            touched.setdefault(tx.message.name, {})[spec["signal"]] = raw
            log.info("VSS -> CAN %s = %s  =>  %s = %s", path, value, spec["signal"], raw)

        for name, cmds in touched.items():
            tx = self.tx[name]
            with tx.lock:
                # A new command set: everything else back to its default (NO_REQUEST).
                counter = tx.values.get(tx.counter, 0) if tx.counter else 0
                tx.values = default_values(tx.message)
                tx.values.update(cmds)
                if tx.counter:
                    tx.values[tx.counter] = (int(counter) + 1) % 16
                tx.next_due = 0.0  # send now, then keep the cycle
            self.send(tx)

    def run_sensor_feed(self, stub) -> None:
        """Mirrors VSS sensors that the ECUs need onto the bus (e.g. speed, brake pedal)."""
        paths = self.sensors_to_can()
        if not paths:
            threading.Event().wait()  # nothing to mirror; never ends
        for response in stub.Subscribe(val_pb2.SubscribeRequest(signal_paths=paths)):
            for path, dp in response.entries.items():
                value = from_value(dp.value)
                if value is None:
                    continue
                spec = self.mapping[path]["vss2dbc"]
                tx = self.message_of(spec["signal"])
                with tx.lock:
                    tx.values[spec["signal"]] = apply_transform(spec, value)

    # --- CAN ----------------------------------------------------------------------------

    def send(self, tx: TxMessage) -> None:
        with tx.lock:
            frame = encode(tx.message, tx.values)
            tx.next_due = time.monotonic() + (tx.message.cycle_time or 100) / 1000
        self.bus.send(frame)

    def run_cyclic_tx(self) -> None:
        while True:
            now = time.monotonic()
            for tx in self.tx.values():
                if now >= tx.next_due:
                    self.send(tx)
            time.sleep(0.005)

    def run_rx(self) -> None:
        """One permanent receive loop; publishes through whichever Kuksa connection is current."""
        while True:
            frame = self.bus.recv(timeout=1.0)
            if frame is None:
                continue
            try:
                message = self.db.get_message_by_frame_id(frame.arbitration_id)
            except KeyError:
                continue
            stub = self.stub
            if NODE in message.senders or stub is None:
                continue  # our own frame looped back by the bus, or Kuksa offline
            for name, raw in message.decode(frame.data).items():
                for path, spec in self.rx_map.get(name, []):
                    try:
                        self.publish(stub, path, apply_transform(spec, raw if not hasattr(raw, "name") else raw.name))
                    except ValueError as err:
                        log.warning("%s", err)
                    except grpc.RpcError as err:
                        log.debug("publish %s failed: %s", path, err.code().name)

    # --- main loop ----------------------------------------------------------------------

    def run(self) -> None:
        threading.Thread(target=self.run_cyclic_tx, daemon=True, name="tx").start()
        threading.Thread(target=self.run_rx, daemon=True, name="rx").start()
        while True:
            try:
                with grpc.insecure_channel(self.args.kuksa) as channel:
                    stub = val_pb2_grpc.VALStub(channel)
                    info = stub.GetServerInfo(val_pb2.GetServerInfoRequest())
                    log.info("connected to %s %s at %s; CAN %s %s", info.name, info.version, self.args.kuksa,
                             self.args.interface, self.args.channel or "default channel")
                    self.load_metadata(stub)
                    self.published.clear()
                    self.stub = stub
                    errors: queue.Queue = queue.Queue()

                    def guard(fn):
                        def wrapper():
                            try:
                                fn(stub)
                                errors.put(StreamEnded(f"{fn.__name__} stream closed by the databroker"))
                            except Exception as err:  # noqa: BLE001 - surface to the main loop
                                errors.put(err)
                        return threading.Thread(target=wrapper, daemon=True, name=fn.__name__)

                    for fn in (self.run_provider, self.run_sensor_feed):
                        guard(fn).start()
                    raise errors.get()  # block until a stream fails, then reconnect
            except grpc.RpcError as err:
                self.stub = None
                log.warning("kuksa %s: %s; reconnecting in 2 s", err.code().name, err.details())
                time.sleep(2)
            except StreamEnded as err:
                self.stub = None
                log.warning("%s; reconnecting in 2 s", err)
                time.sleep(2)


def main() -> None:
    parser = argparse.ArgumentParser(description="CAN <-> Kuksa Databroker provider (kuksa.val.v2)")
    parser.add_argument("--kuksa", default="127.0.0.1:55555", help="Kuksa Databroker address")
    parser.add_argument("--mapping", default=str(DEFAULT_MAPPING), help="VSS <-> DBC mapping (JSON)")
    parser.add_argument("-v", "--verbose", action="store_true", help="log every CAN -> VSS update")
    add_bus_arguments(parser)
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(name)s: %(message)s", datefmt="%H:%M:%S")
    try:
        CanProvider(args).run()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
