"""Virtual Body Control Module (BCM): a classic, signal-based ECU on CAN.

It knows nothing about VSS or Kuksa. Like a real classic ECU it
  * receives ESP_Status (speed, brake pedal) and BCM_Request (commands with a rolling counter),
  * applies its body rules,
  * sends BCM_LampStatus and BCM_DoorStatus cyclically (100 ms) and immediately on change.

Rules:
  * brake lamps follow the brake pedal (> 5 %)
  * high beam needs low beam: high ON switches low ON, low OFF switches high OFF
  * left and right turn signals are mutually exclusive
  * doors and trunk refuse to open above 5 km/h

    python bcm.py --interface udp_multicast           # or: --interface socketcan --channel vcan0
"""

from __future__ import annotations

import argparse
import logging
import threading
import time

from canbus import add_bus_arguments, encode, load_dbc, open_bus, sent_by

NODE = "BCM"
DOOR_LOCKOUT_KMH = 5.0
BRAKE_LAMP_THRESHOLD = 5

log = logging.getLogger("bcm")


class BodyControlModule:
    def __init__(self, bus, db):
        self.bus = bus
        self.db = db
        self.lock = threading.Lock()
        self.speed = 0.0
        self.brake = 0
        self.last_counter: int | None = None
        self.lamps = {"LowBeam": 0, "HighBeam": 0, "TurnLeft": 0, "TurnRight": 0, "Hazard": 0}
        self.doors = {"FL": 0, "FR": 0, "RL": 0, "RR": 0}
        self.trunk_open = False
        self.tx_messages = sent_by(db, NODE)

    # --- inputs -------------------------------------------------------------------------

    def on_frame(self, frame) -> None:
        try:
            message = self.db.get_message_by_frame_id(frame.arbitration_id)
        except KeyError:
            return
        if NODE in message.senders:
            return  # our own frame looped back by the bus
        values = message.decode(frame.data)
        with self.lock:
            before = self.status_values()
            if message.name == "ESP_Status":
                self.speed = float(values["ESP_VehicleSpeed"])
                self.brake = int(values["ESP_BrakePedalPos"])
            elif message.name == "BCM_Request":
                counter = int(values["BCM_RequestCounter"])
                if counter == self.last_counter:
                    return  # cyclic repetition of a command set we already handled
                self.last_counter = counter
                self.apply_commands({k: str(v) for k, v in values.items() if k.endswith("Cmd")})
            changed = self.status_values() != before
        if changed:
            self.send_status()  # event-triggered transmission on top of the cycle

    def apply_commands(self, cmds: dict[str, str]) -> None:
        for name, cmd in cmds.items():
            if cmd == "NO_REQUEST":
                continue
            function = name.removeprefix("BCM_").removesuffix("Cmd")
            on = cmd in ("ON", "OPEN")
            log.info("command %s=%s (counter %s, %.1f km/h)", function, cmd, self.last_counter, self.speed)

            if function in self.lamps:
                self.lamps[function] = int(on)
                if function == "HighBeam" and on:
                    self.lamps["LowBeam"] = 1
                if function == "LowBeam" and not on:
                    self.lamps["HighBeam"] = 0
                if function in ("TurnLeft", "TurnRight") and on:
                    self.lamps["TurnRight" if function == "TurnLeft" else "TurnLeft"] = 0
            elif function.startswith("Door") or function == "Trunk":
                if on and self.speed > DOOR_LOCKOUT_KMH:
                    log.warning("rejected %s OPEN: vehicle moving at %.1f km/h", function, self.speed)
                    continue
                if function == "Trunk":
                    self.trunk_open = on
                else:
                    self.doors[function.removeprefix("Door")] = int(on)

    # --- outputs ------------------------------------------------------------------------

    def status_values(self) -> dict[str, dict[str, object]]:
        brake_lamp = "LIGHT_ON" if self.brake > BRAKE_LAMP_THRESHOLD else "LIGHT_OFF"
        return {
            "BCM_LampStatus": {
                **{f"BCM_{k}Status": v for k, v in self.lamps.items()},
                "BCM_BrakeLampStatus": brake_lamp,
            },
            "BCM_DoorStatus": {
                **{f"BCM_Door{k}Status": v for k, v in self.doors.items()},
                "BCM_TrunkLatchStatus": "LATCH_OPENED" if self.trunk_open else "LATCH_CLOSED",
            },
        }

    def send_status(self) -> None:
        with self.lock:
            values = self.status_values()
        for message in self.tx_messages:
            self.bus.send(encode(message, values[message.name]))

    def run(self) -> None:
        def receiver():
            while True:
                frame = self.bus.recv(timeout=1.0)
                if frame is not None:
                    self.on_frame(frame)

        threading.Thread(target=receiver, daemon=True).start()
        cycle = min(m.cycle_time or 100 for m in self.tx_messages) / 1000
        log.info("BCM online, sending %s every %.0f ms", ", ".join(m.name for m in self.tx_messages), cycle * 1000)
        while True:
            self.send_status()
            time.sleep(cycle)


def main() -> None:
    parser = argparse.ArgumentParser(description="Virtual Body Control Module on CAN")
    add_bus_arguments(parser)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s", datefmt="%H:%M:%S")
    bus = open_bus(args.interface, args.channel)
    try:
        BodyControlModule(bus, load_dbc(args.dbc)).run()
    except KeyboardInterrupt:
        pass
    finally:
        bus.shutdown()


if __name__ == "__main__":
    main()
