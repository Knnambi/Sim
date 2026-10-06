"""Builds sim_body.arxml, a sample AUTOSAR 4 system description of the simulator's CAN bus.

Stand-in for what an AUTOSAR authoring tool (e.g. ETAS ISOLAR-A/AB) exports: the bus is
exported from ../dbc/sim_body.dbc with canmatrix, then completed with what such tools always
write but canmatrix's exporter leaves out:
  * BASE-TYPE-ENCODING on the base types (NONE = unsigned, 2C = signed)
  * I-PDU cycle timing (I-PDU-TIMING-SPECIFICATIONS / CYCLIC-TIMING / TIME-PERIOD, seconds)

    python make_sample_arxml.py        # writes sim_body.arxml next to this script
"""

from __future__ import annotations

import io
import re
from pathlib import Path

import canmatrix.formats

HERE = Path(__file__).resolve().parent
DBC = HERE.parent / "dbc" / "sim_body.dbc"
OUT = HERE / "sim_body.arxml"

TIMING = """<I-PDU-TIMING-SPECIFICATIONS>
            <I-PDU-TIMING>
              <TRANSMISSION-MODE-DECLARATION>
                <TRANSMISSION-MODE-TRUE-TIMING>
                  <CYCLIC-TIMING>
                    <TIME-PERIOD>
                      <VALUE>{seconds}</VALUE>
                    </TIME-PERIOD>
                  </CYCLIC-TIMING>
                </TRANSMISSION-MODE-TRUE-TIMING>
              </TRANSMISSION-MODE-DECLARATION>
            </I-PDU-TIMING>
          </I-PDU-TIMING-SPECIFICATIONS>
          """


def main() -> None:
    matrix = next(iter(canmatrix.formats.loadp(str(DBC)).values()))
    cycles = {f.name: f.cycle_time for f in matrix.frames}
    buf = io.BytesIO()
    canmatrix.formats.dump({"CAN": matrix}, buf, "arxml")
    xml = buf.getvalue().decode("ascii")

    xml, n_enc = re.subn(
        r"(<SHORT-NAME>([us])int\d+</SHORT-NAME>\s*<CATEGORY>FIXED_LENGTH</CATEGORY>\s*<BASE-TYPE-SIZE>\d+</BASE-TYPE-SIZE>)(\s*)",
        lambda m: f"{m.group(1)}{m.group(3)}<BASE-TYPE-ENCODING>{'2C' if m.group(2) == 's' else 'NONE'}</BASE-TYPE-ENCODING>{m.group(3)}",
        xml,
    )

    def add_timing(m: re.Match) -> str:
        cycle = cycles.get(m.group(2), 0)
        timing = TIMING.format(seconds=cycle / 1000) if cycle else ""
        return f"{m.group(1)}{timing}<I-SIGNAL-TO-PDU-MAPPINGS>"

    # Schema order inside I-SIGNAL-I-PDU: ... I-PDU-TIMING-SPECIFICATIONS, I-SIGNAL-TO-PDU-MAPPINGS
    xml, n_timing = re.subn(
        r"(<I-SIGNAL-I-PDU>\s*<SHORT-NAME>PDU_(\w+)</SHORT-NAME>\s*<LENGTH>\d+</LENGTH>\s*)<I-SIGNAL-TO-PDU-MAPPINGS>",
        add_timing,
        xml,
    )
    OUT.write_text(xml, encoding="ascii")
    print(f"wrote {OUT.name}: {len(matrix.frames)} frames, {n_enc} base-type encodings, {n_timing} PDU timings")


if __name__ == "__main__":
    main()
