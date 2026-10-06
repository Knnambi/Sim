"""SOME/IP service interfaces of the comfort domain (the "ARXML" of this simulator).

Shared by the comfort vECU (server) and the SOME/IP provider (client), so both sides agree on
IDs and payload layouts. Payloads use someipy's SOME/IP serialization (big endian, packed).

  WindowControl  0x6001  offered by comfort_ecu.py
      method 0x0001 SetPosition(SetPositionRequest) -> ResultResponse
      method 0x0002 Stop(WindowRequest)             -> ResultResponse
      event  0x8001 WindowStatus  (eventgroup 0x0001) every 100 ms while a motor runs, else 1 s
  WiperControl   0x6002  offered by comfort_ecu.py
      method 0x0001 SetMode(SetModeRequest)         -> ResultResponse
      event  0x8001 WiperStatus   (eventgroup 0x0001) on change, else 1 s
  Environment    0x6003  offered by someip_provider.py (fed from VSS)
      event  0x8001 RainStatus    (eventgroup 0x0001) on change, else 1 s
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum

from someipy import Event, EventGroup, Method, ServiceBuilder, TransportLayerProtocol
from someipy.serialization import SomeIpPayload, Uint8

UDP = TransportLayerProtocol.UDP
INSTANCE_ID = 0x0001
MAJOR_VERSION = 1
EVENTGROUP_ID = 0x0001

WINDOW_SERVICE_ID = 0x6001
WINDOW_SET_POSITION = 0x0001
WINDOW_STOP = 0x0002
WINDOW_STATUS_EVENT = 0x8001

WIPER_SERVICE_ID = 0x6002
WIPER_SET_MODE = 0x0001
WIPER_STATUS_EVENT = 0x8001

ENVIRONMENT_SERVICE_ID = 0x6003
RAIN_STATUS_EVENT = 0x8001

# Window index on the wire -> VSS door position
WINDOWS = ("Row1.DriverSide", "Row1.PassengerSide", "Row2.DriverSide", "Row2.PassengerSide")


class Result(IntEnum):
    OK = 0
    INVALID_ARGUMENT = 1
    REJECTED = 2


class WiperMode(IntEnum):
    """Matches the allowed values of VSS Vehicle.Body.Windshield.Front.Wiping.Mode."""
    OFF = 0
    SLOW = 1
    MEDIUM = 2
    FAST = 3
    INTERVAL = 4
    RAIN_SENSOR = 5


@dataclass
class WindowRequest(SomeIpPayload):
    window: Uint8

    def __init__(self, window: int = 0):
        self.window = Uint8(window)


@dataclass
class SetPositionRequest(SomeIpPayload):
    window: Uint8
    position: Uint8  # percent, 0 = closed, 100 = fully open

    def __init__(self, window: int = 0, position: int = 0):
        self.window = Uint8(window)
        self.position = Uint8(position)


@dataclass
class SetModeRequest(SomeIpPayload):
    mode: Uint8  # WiperMode

    def __init__(self, mode: int = 0):
        self.mode = Uint8(mode)


@dataclass
class ResultResponse(SomeIpPayload):
    result: Uint8  # Result

    def __init__(self, result: int = 0):
        self.result = Uint8(result)


@dataclass
class WindowStatus(SomeIpPayload):
    front_left: Uint8
    front_right: Uint8
    rear_left: Uint8
    rear_right: Uint8
    moving_mask: Uint8  # bit n set = motor of window n running

    def __init__(self, positions=(0, 0, 0, 0), moving_mask: int = 0):
        self.front_left, self.front_right, self.rear_left, self.rear_right = (Uint8(int(p)) for p in positions)
        self.moving_mask = Uint8(moving_mask)

    def positions(self) -> list[int]:
        return [self.front_left.value, self.front_right.value, self.rear_left.value, self.rear_right.value]


@dataclass
class WiperStatus(SomeIpPayload):
    mode: Uint8  # WiperMode
    is_wiping: Uint8  # 0/1
    frequency: Uint8  # wipe cycles per minute actually running

    def __init__(self, mode: int = 0, is_wiping: int = 0, frequency: int = 0):
        self.mode = Uint8(mode)
        self.is_wiping = Uint8(is_wiping)
        self.frequency = Uint8(frequency)


@dataclass
class RainStatus(SomeIpPayload):
    intensity: Uint8  # percent, 0 = dry

    def __init__(self, intensity: int = 0):
        self.intensity = Uint8(intensity)


def _service(service_id: int, methods=(), events=()):
    builder = ServiceBuilder().with_service_id(service_id).with_major_version(MAJOR_VERSION)
    for method_id, handler in methods:
        builder = builder.with_method(Method(id=method_id, protocol=UDP, method_handler=handler))
    eventgroup = None
    if events:
        eventgroup = EventGroup(id=EVENTGROUP_ID, events=[Event(id=e, protocol=UDP) for e in events])
        builder = builder.with_eventgroup(eventgroup)
    return builder.build(), eventgroup


def window_service(set_position=None, stop=None):
    return _service(WINDOW_SERVICE_ID, [(WINDOW_SET_POSITION, set_position), (WINDOW_STOP, stop)], [WINDOW_STATUS_EVENT])


def wiper_service(set_mode=None):
    return _service(WIPER_SERVICE_ID, [(WIPER_SET_MODE, set_mode)], [WIPER_STATUS_EVENT])


def environment_service():
    return _service(ENVIRONMENT_SERVICE_ID, events=[RAIN_STATUS_EVENT])
