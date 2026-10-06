"""CAN monitor: prints frames on the bus decoded with the DBC (like `candump | cantools decode`).

By default only frames whose content changed are shown, so the cyclic traffic doesn't drown
the interesting bits. Use --all to see every frame.

    python canmon.py                 # udp_multicast
    python canmon.py --interface socketcan --channel vcan0 --all
"""

from __future__ import annotations

import argparse
import time

from canbus import add_bus_arguments, load_dbc, open_bus


def main() -> None:
    parser = argparse.ArgumentParser(description="Decode and print CAN traffic")
    add_bus_arguments(parser)
    parser.add_argument("--all", action="store_true", help="print every frame, including unchanged cyclic ones")
    args = parser.parse_args()

    db = load_dbc(args.dbc)
    bus = open_bus(args.interface, args.channel)
    last: dict[int, bytes] = {}
    start = time.monotonic()
    try:
        while True:
            frame = bus.recv(timeout=1.0)
            if frame is None:
                continue
            data = bytes(frame.data)
            if not args.all and last.get(frame.arbitration_id) == data:
                continue
            last[frame.arbitration_id] = data
            try:
                message = db.get_message_by_frame_id(frame.arbitration_id)
                decoded = message.decode(data)
                fields = " ".join(f"{k.split('_', 1)[-1]}={v}" for k, v in decoded.items()
                                  if args.all or str(v) not in ("0", "NO_REQUEST"))
                print(f"{time.monotonic() - start:8.3f}  {frame.arbitration_id:03X}  {data.hex(' ')}  "
                      f"{message.name:<15} {'/'.join(message.senders):>3} -> {fields}", flush=True)
            except KeyError:
                print(f"{time.monotonic() - start:8.3f}  {frame.arbitration_id:03X}  {data.hex(' ')}  (not in DBC)", flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        bus.shutdown()


if __name__ == "__main__":
    main()
