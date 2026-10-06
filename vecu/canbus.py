"""Shared CAN helpers for the virtual ECU and the CAN provider.

Bus selection (flags override environment variables):
  CAN_INTERFACE=socketcan     CAN_CHANNEL=vcan0          real/virtual SocketCAN (Linux)
  CAN_INTERFACE=udp_multicast CAN_CHANNEL=239.74.163.2   CAN frames over UDP multicast (any OS, Docker)
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import can
import cantools
from cantools.database.can import Database, Message

HERE = Path(__file__).resolve().parent
DEFAULT_DBC = HERE / "dbc" / "sim_body.dbc"
DEFAULT_MAPPING = HERE / "mapping" / "vss_dbc.json"


def add_bus_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--interface", default=os.environ.get("CAN_INTERFACE", "udp_multicast"),
                        help="python-can interface: socketcan, udp_multicast, ... (env CAN_INTERFACE)")
    parser.add_argument("--channel", default=os.environ.get("CAN_CHANNEL"),
                        help="CAN channel, e.g. vcan0 or 239.74.163.2 (env CAN_CHANNEL)")
    parser.add_argument("--dbc", default=str(DEFAULT_DBC), help="DBC file describing the bus")


def open_bus(interface: str, channel: str | None) -> can.BusABC:
    if channel is None:
        channel = "vcan0" if interface == "socketcan" else "239.74.163.2"
    return can.Bus(interface=interface, channel=channel)


def load_dbc(path: str) -> Database:
    db = cantools.database.load_file(path)
    assert isinstance(db, Database)
    return db


def sent_by(db: Database, node: str) -> list[Message]:
    return [m for m in db.messages if node in m.senders]


def default_values(message: Message) -> dict[str, object]:
    """Raw value 0 for every signal, as its value-table name where one exists (e.g. NO_REQUEST)."""
    values: dict[str, object] = {}
    for sig in message.signals:
        values[sig.name] = sig.choices[0] if sig.choices and 0 in sig.choices else 0
    return values


def encode(message: Message, values: dict[str, object]) -> can.Message:
    data = message.encode({k: str(v) if hasattr(v, "value") else v for k, v in values.items()})
    return can.Message(arbitration_id=message.frame_id, data=data, is_extended_id=message.is_extended_frame)
