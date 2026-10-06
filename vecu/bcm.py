"""Virtual Body Control Module (BCM): a classic, signal-based ECU on CAN.

It knows nothing about VSS or Kuksa. Its communication layer is generated from the AUTOSAR
system description (arxml/sim_body.arxml -> arxml2vecu.py -> generated/bcm_com.py), so this
file holds only the application logic, like a software component on top of an AUTOSAR RTE/COM:

  receives  ESP_Status (speed, brake pedal) and BCM_Request (commands with a rolling counter)
  sends     BCM_LampStatus and BCM_DoorStatus, cyclically (100 ms) and immediately on change

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

from canbus import add_bus_arguments, open_bus
from generated.bcm_com import (BCM_BrakeLampStatus, BCM_RequestCounter, BCM_TrunkLatchStatus, BcmBrakeLampStatus,
                               BcmCom, BcmTrunkLatchStatus, ESP_BrakePedalPos, ESP_VehicleSpeed)

DOOR_LOCKOUT_KMH = 5.0
BRAKE_LAMP_THRESHOLD = 5
LAMPS = ("LowBeam", "HighBeam", "TurnLeft", "TurnRight", "Hazard")

log = logging.getLogger("bcm")


class BodyControlModule:
    def __init__(self, com: BcmCom):
        self.com = com
        self.lock = threading.Lock()
        self.last_counter: int | None = None
        self.lamps = dict.fromkeys(LAMPS, 0)
        com.on_receive(self.on_receive)

    def on_receive(self, message: str, values: dict) -> None:
        with self.lock:
            if message == "ESP_Status":
                lamp = BcmBrakeLampStatus.LIGHT_ON if values[ESP_BrakePedalPos] > BRAKE_LAMP_THRESHOLD else BcmBrakeLampStatus.LIGHT_OFF
                self.com.write(BCM_BrakeLampStatus, lamp.name)
            elif message == "BCM_Request":
                counter = int(values[BCM_RequestCounter])
                if counter == self.last_counter:
                    return  # cyclic repetition of a command set we already handled
                self.last_counter = counter
                self.apply_commands({k: str(v) for k, v in values.items() if k.endswith("Cmd")})

    def apply_commands(self, cmds: dict[str, str]) -> None:
        speed = float(self.com.read(ESP_VehicleSpeed, 0.0))
        for name, cmd in cmds.items():
            if cmd == "NO_REQUEST":
                continue
            function = name.removeprefix("BCM_").removesuffix("Cmd")
            on = cmd in ("ON", "OPEN")
            log.info("command %s=%s (counter %s, %.1f km/h)", function, cmd, self.last_counter, speed)

            if function in self.lamps:
                self.set_lamp(function, on)
                if function == "HighBeam" and on:
                    self.set_lamp("LowBeam", True)
                if function == "LowBeam" and not on:
                    self.set_lamp("HighBeam", False)
                if function in ("TurnLeft", "TurnRight") and on:
                    self.set_lamp("TurnRight" if function == "TurnLeft" else "TurnLeft", False)
            elif function.startswith("Door") or function == "Trunk":
                if on and speed > DOOR_LOCKOUT_KMH:
                    log.warning("rejected %s OPEN: vehicle moving at %.1f km/h", function, speed)
                    continue
                if function == "Trunk":
                    latch = BcmTrunkLatchStatus.LATCH_OPENED if on else BcmTrunkLatchStatus.LATCH_CLOSED
                    self.com.write(BCM_TrunkLatchStatus, latch.name)
                else:
                    self.com.write(f"BCM_{function}Status", int(on))

    def set_lamp(self, lamp: str, on: bool) -> None:
        self.lamps[lamp] = int(on)
        self.com.write(f"BCM_{lamp}Status", int(on))


def main() -> None:
    parser = argparse.ArgumentParser(description="Virtual Body Control Module on CAN")
    add_bus_arguments(parser)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s", datefmt="%H:%M:%S")
    bus = open_bus(args.interface, args.channel)
    com = BcmCom(bus)
    BodyControlModule(com)
    com.start()
    log.info("BCM online (%s)", ", ".join(f"{m} every {com.tx[m].cycle_time} ms" for m in com.tx))
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        com.stop()
        bus.shutdown()


if __name__ == "__main__":
    main()
