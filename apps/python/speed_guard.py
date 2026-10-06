"""Speed Guard: an external vehicle app talking to Kuksa Databroker over kuksa.val.v2 gRPC.

It knows nothing about the browser simulator. It subscribes to `Vehicle.Speed` and, above
the limit, actuates the hazard lights; the simulator (registered in Kuksa as the provider for
that actuator) makes them blink on the 3D car. Point it at a real vehicle's databroker and the
same code would drive real hazard lights.

    pip install -r requirements.txt
    python speed_guard.py --limit 100 --kuksa 127.0.0.1:55555
"""

from __future__ import annotations

import argparse
import logging
import time

import grpc
from kuksa.val.v2 import types_pb2, val_pb2, val_pb2_grpc

SPEED = "Vehicle.Speed"
HAZARD = "Vehicle.Body.Lights.Hazard.IsSignaling"
HYSTERESIS_KMH = 10

log = logging.getLogger("speed-guard")


def actuate_hazard(stub: val_pb2_grpc.VALStub, on: bool) -> None:
    stub.Actuate(
        val_pb2.ActuateRequest(
            signal_id=types_pb2.SignalID(path=HAZARD),
            value=types_pb2.Value(bool=on),
        )
    )


def run(stub: val_pb2_grpc.VALStub, limit: float) -> None:
    info = stub.GetServerInfo(val_pb2.GetServerInfoRequest())
    log.info("connected to %s %s, warning above %.0f km/h", info.name, info.version, limit)

    warning = False
    for response in stub.Subscribe(val_pb2.SubscribeRequest(signal_paths=[SPEED])):
        datapoint = response.entries.get(SPEED)
        if datapoint is None or not datapoint.value.HasField("float"):
            continue
        speed = datapoint.value.float

        if not warning and speed > limit:
            warning = True
            log.info("%.1f km/h > %.0f km/h: hazards ON", speed, limit)
        elif warning and speed < limit - HYSTERESIS_KMH:
            warning = False
            log.info("%.1f km/h: back under the limit, hazards OFF", speed)
        else:
            continue

        try:
            actuate_hazard(stub, warning)
        except grpc.RpcError as err:
            # UNAVAILABLE means no provider (the simulator) has claimed the actuator.
            log.warning("actuate failed: %s %s", err.code().name, err.details())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--kuksa", default="127.0.0.1:55555", help="Kuksa Databroker address (host:port)")
    parser.add_argument("--limit", type=float, default=100.0, help="speed limit in km/h")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s", datefmt="%H:%M:%S")

    while True:
        try:
            with grpc.insecure_channel(args.kuksa) as channel:
                run(val_pb2_grpc.VALStub(channel), args.limit)
        except grpc.RpcError as err:
            log.warning("kuksa %s: %s, retrying in 2 s", err.code().name, err.details())
            time.sleep(2)
        except KeyboardInterrupt:
            return


if __name__ == "__main__":
    main()
