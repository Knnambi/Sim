"""Minimal COM layer for virtual ECUs: signal-level read/write over CAN frames.

The static half of an AUTOSAR-style COM stack. The per-ECU half (which frames this ECU sends and
receives, signal names, value tables) is generated from ARXML by arxml2vecu.py. Application
code then works with signals only:

    com = BcmCom(bus)                       # generated subclass
    com.on_receive(handler)                 # handler(message_name, {signal: value})
    com.write("BCM_HazardStatus", 1)        # updates the Tx buffer, sent on change and cyclically
    com.read("ESP_VehicleSpeed")            # latest received value
    com.start()                             # Rx thread + cyclic Tx thread
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable

import can
import cantools
from cantools.database.can import Database, Message

log = logging.getLogger("com")

ReceiveHandler = Callable[[str, dict], None]


class Com:
    """Signal-level CAN communication for one ECU (node) of a DBC database."""

    NODE: str = ""          # set by the generated subclass
    DBC_PATH: str = ""      # set by the generated subclass

    def __init__(self, bus: can.BusABC, dbc_path: str | None = None):
        db = cantools.database.load_file(dbc_path or self.DBC_PATH)
        assert isinstance(db, Database)
        self.db = db
        self.bus = bus
        self.tx: dict[str, Message] = {m.name: m for m in db.messages if self.NODE in m.senders}
        self.rx: dict[str, Message] = {m.name: m for m in db.messages if self.NODE not in m.senders
                                       and any(self.NODE in s.receivers for s in m.signals)}
        self._tx_values: dict[str, dict] = {name: self._defaults(m) for name, m in self.tx.items()}
        self._signal_to_tx = {s.name: m.name for m in self.tx.values() for s in m.signals}
        self._rx_values: dict[str, object] = {}
        self._handlers: list[ReceiveHandler] = []
        self._lock = threading.Lock()
        self._running = False

    @staticmethod
    def _defaults(message: Message) -> dict:
        return {s.name: (s.choices[0] if s.choices and 0 in s.choices else 0) for s in message.signals}

    # --- application API ------------------------------------------------------------------

    def on_receive(self, handler: ReceiveHandler) -> None:
        self._handlers.append(handler)

    def read(self, signal: str, default=None):
        with self._lock:
            return self._rx_values.get(signal, default)

    def write(self, signal: str, value, send_on_change: bool = True) -> None:
        """Sets a Tx signal. Sends its frame immediately when the value changed (event + cyclic)."""
        message = self._signal_to_tx[signal]
        with self._lock:
            values = self._tx_values[message]
            changed = str(values.get(signal)) != str(value)
            values[signal] = value
        if changed and send_on_change and self._running:
            self.send(message)

    def send(self, message: str) -> None:
        with self._lock:
            values = dict(self._tx_values[message])
        m = self.tx[message]
        data = m.encode({k: str(v) if hasattr(v, "value") else v for k, v in values.items()})
        self.bus.send(can.Message(arbitration_id=m.frame_id, data=data, is_extended_id=m.is_extended_frame))

    # --- runtime ------------------------------------------------------------------------

    def start(self) -> None:
        self._running = True
        threading.Thread(target=self._rx_loop, daemon=True, name=f"{self.NODE}-rx").start()
        threading.Thread(target=self._tx_loop, daemon=True, name=f"{self.NODE}-tx").start()
        log.info("%s COM up: Tx %s, Rx %s", self.NODE, sorted(self.tx), sorted(self.rx))

    def stop(self) -> None:
        self._running = False

    def _rx_loop(self) -> None:
        by_id = {m.frame_id: m for m in self.rx.values()}
        while self._running:
            frame = self.bus.recv(timeout=0.5)
            if frame is None or frame.arbitration_id not in by_id:
                continue  # not for this ECU, or our own frame looped back
            message = by_id[frame.arbitration_id]
            values = message.decode(bytes(frame.data))
            with self._lock:
                self._rx_values.update(values)
            for handler in self._handlers:
                try:
                    handler(message.name, values)
                except Exception:  # noqa: BLE001 - an application bug must not stop COM
                    log.exception("receive handler failed for %s", message.name)

    def _tx_loop(self) -> None:
        due = {name: 0.0 for name, m in self.tx.items() if m.cycle_time}
        while self._running:
            now = time.monotonic()
            for name, at in due.items():
                if now >= at:
                    self.send(name)
                    due[name] = now + self.tx[name].cycle_time / 1000
            time.sleep(0.005)
