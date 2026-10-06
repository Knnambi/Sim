"""Comfort vECU: a service-oriented (Adaptive AUTOSAR style) ECU on SOME/IP.

It knows nothing about VSS or Kuksa. It *offers* two services and *consumes* one:

  WindowControl (server)  SetPosition / Stop methods; window motors move at 20 %/s and report
                          WindowStatus every 100 ms while running.
  WiperControl  (server)  SetMode method; WiperStatus reports the effective wiping frequency.
  Environment   (client)  RainStatus events drive the RAIN_SENSOR wiper mode.

Needs a running someipy daemon (`someipyd`) on this host, see run_with_daemon.sh.

    python comfort_ecu.py --ip 127.0.0.1
"""

from __future__ import annotations

import argparse
import asyncio
import logging
from typing import Tuple

from someipy import (ClientServiceInstance, MessageType, MethodResult, ReturnCode, ServerServiceInstance,
                     connect_to_someipy_daemon)
from someipy.someipy_logging import set_someipy_log_level

import interfaces as itf
from interfaces import Result, WiperMode

MOTOR_SPEED = 20.0  # % per second
TICK = 0.05
FREQUENCY_CPM = {WiperMode.OFF: 0, WiperMode.SLOW: 40, WiperMode.MEDIUM: 55, WiperMode.FAST: 70, WiperMode.INTERVAL: 12}

log = logging.getLogger("comfort-ecu")


def rain_sensor_frequency(intensity: int) -> int:
    if intensity < 5:
        return 0
    if intensity < 30:
        return FREQUENCY_CPM[WiperMode.INTERVAL]
    if intensity < 60:
        return FREQUENCY_CPM[WiperMode.SLOW]
    if intensity < 85:
        return FREQUENCY_CPM[WiperMode.MEDIUM]
    return FREQUENCY_CPM[WiperMode.FAST]


def response(result: Result) -> MethodResult:
    r = MethodResult()
    r.message_type = MessageType.RESPONSE
    r.return_code = ReturnCode.E_OK
    r.payload = itf.ResultResponse(result).serialize()
    return r


def malformed() -> MethodResult:
    r = MethodResult()
    r.message_type = MessageType.ERROR
    r.return_code = ReturnCode.E_MALFORMED_MESSAGE
    return r


class ComfortEcu:
    def __init__(self):
        self.position = [0.0] * 4
        self.target = [0.0] * 4
        self.wiper_mode = WiperMode.OFF
        self.rain = 0
        self.status_dirty = True

    # --- WindowControl ------------------------------------------------------------------

    async def on_set_position(self, payload: bytes, addr: Tuple[str, int]) -> MethodResult:
        try:
            req = itf.SetPositionRequest().deserialize(payload)
        except Exception:  # noqa: BLE001 - any decoding problem is a malformed request
            return malformed()
        window, position = req.window.value, req.position.value
        if window >= len(itf.WINDOWS) or position > 100:
            return response(Result.INVALID_ARGUMENT)
        log.info("SetPosition(%s, %d %%) from %s:%d", itf.WINDOWS[window], position, *addr)
        self.target[window] = float(position)
        return response(Result.OK)

    async def on_stop(self, payload: bytes, addr: Tuple[str, int]) -> MethodResult:
        try:
            window = itf.WindowRequest().deserialize(payload).window.value
        except Exception:  # noqa: BLE001
            return malformed()
        if window >= len(itf.WINDOWS):
            return response(Result.INVALID_ARGUMENT)
        log.info("Stop(%s) at %.0f %%", itf.WINDOWS[window], self.position[window])
        self.target[window] = self.position[window]
        return response(Result.OK)

    def moving_mask(self) -> int:
        return sum(1 << i for i in range(4) if abs(self.target[i] - self.position[i]) > 1e-6)

    def step_motors(self, dt: float) -> None:
        for i in range(4):
            delta = self.target[i] - self.position[i]
            step = MOTOR_SPEED * dt
            self.position[i] = self.target[i] if abs(delta) <= step else self.position[i] + step * (1 if delta > 0 else -1)

    def window_status(self) -> itf.WindowStatus:
        return itf.WindowStatus([round(p) for p in self.position], self.moving_mask())

    # --- WiperControl -------------------------------------------------------------------

    async def on_set_mode(self, payload: bytes, addr: Tuple[str, int]) -> MethodResult:
        try:
            mode = itf.SetModeRequest().deserialize(payload).mode.value
            mode = WiperMode(mode)
        except Exception:  # noqa: BLE001
            return response(Result.INVALID_ARGUMENT)
        log.info("SetMode(%s) from %s:%d", mode.name, *addr)
        self.wiper_mode = mode
        self.status_dirty = True
        return response(Result.OK)

    def wiper_status(self) -> itf.WiperStatus:
        if self.wiper_mode == WiperMode.RAIN_SENSOR:
            frequency = rain_sensor_frequency(self.rain)
        else:
            frequency = FREQUENCY_CPM[self.wiper_mode]
        return itf.WiperStatus(self.wiper_mode, int(frequency > 0), frequency)

    # --- Environment (consumed) ---------------------------------------------------------

    def on_environment_event(self, event_id: int, payload: bytes) -> None:
        if event_id != itf.RAIN_STATUS_EVENT:
            return
        rain = itf.RainStatus().deserialize(payload).intensity.value
        if rain != self.rain:
            log.info("rain intensity %d %%", rain)
            self.rain = rain
            self.status_dirty = True

    # --- main loop ----------------------------------------------------------------------

    async def run(self, ip: str, socket_path: str | None) -> None:
        daemon = await connect_to_someipy_daemon({"socket_path": socket_path} if socket_path else None)
        window_svc, window_eg = itf.window_service(self.on_set_position, self.on_stop)
        wiper_svc, wiper_eg = itf.wiper_service(self.on_set_mode)
        windows = ServerServiceInstance(daemon=daemon, service=window_svc, instance_id=itf.INSTANCE_ID,
                                        endpoint_ip=ip, endpoint_port=30511, ttl=5, cyclic_offer_delay_ms=1000)
        wipers = ServerServiceInstance(daemon=daemon, service=wiper_svc, instance_id=itf.INSTANCE_ID,
                                       endpoint_ip=ip, endpoint_port=30512, ttl=5, cyclic_offer_delay_ms=1000)
        env_svc, env_eg = itf.environment_service()
        environment = ClientServiceInstance(daemon=daemon, service=env_svc, instance_id=itf.INSTANCE_ID,
                                            endpoint_ip=ip, endpoint_port=30513)
        environment.register_callback(self.on_environment_event)
        environment.subscribe_eventgroup(env_eg, 5)
        await windows.start_offer()
        await wipers.start_offer()
        log.info("offering WindowControl 0x%04x and WiperControl 0x%04x on %s", itf.WINDOW_SERVICE_ID,
                 itf.WIPER_SERVICE_ID, ip)

        loop = asyncio.get_running_loop()
        last_window_tx = last_wiper_tx = 0.0
        last_wiper = None
        try:
            while True:
                await asyncio.sleep(TICK)
                now = loop.time()
                was_moving = self.moving_mask()
                self.step_motors(TICK)
                moving = self.moving_mask()
                # 100 ms while a motor runs, once more when it stops, 1 s otherwise
                if (moving and now - last_window_tx >= 0.1) or (was_moving and not moving) or now - last_window_tx >= 1.0:
                    windows.send_event(itf.EVENTGROUP_ID, itf.WINDOW_STATUS_EVENT, self.window_status().serialize())
                    last_window_tx = now
                wiper = self.wiper_status()
                key = (wiper.mode.value, wiper.frequency.value)
                if key != last_wiper or now - last_wiper_tx >= 1.0:
                    if key != last_wiper:
                        log.info("wipers: mode %s, %d cycles/min", WiperMode(key[0]).name, key[1])
                    wipers.send_event(itf.EVENTGROUP_ID, itf.WIPER_STATUS_EVENT, wiper.serialize())
                    last_wiper, last_wiper_tx = key, now
        finally:
            await windows.stop_offer()
            await wipers.stop_offer()
            await daemon.disconnect_from_daemon()


def main() -> None:
    parser = argparse.ArgumentParser(description="Comfort vECU (SOME/IP window and wiper services)")
    parser.add_argument("--ip", default="127.0.0.1", help="IP address this ECU's services are reachable on")
    parser.add_argument("--socket", default=None, help="someipy daemon socket path (default /tmp/someipyd.sock)")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s", datefmt="%H:%M:%S")
    set_someipy_log_level(logging.WARNING)
    try:
        asyncio.run(ComfortEcu().run(args.ip, args.socket))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
