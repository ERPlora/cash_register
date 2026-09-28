#!/usr/bin/env python3
"""Payload contract of the till's money amounts — what a caller may send (pm#521).

WHY. The till's screens read what a person types or pastes with the toolkit's `money-input`, which
KEEPS the sign: a pasted «-1.250,50» becomes -125050. The screens refuse a negative opening float
or count (`ui.errNegativeAmount`), but the screen is not the only caller: the assistant and the
public API reach the same commands, and the command schema — validated by the runtime before the
handler runs — is the only door in front of all of them. `session.open` had no floor at all: a
negative opening float was stored and every expected balance of the shift started below zero.
Without this file, dropping a `minimum` (or letting a float in) left every suite green.

Rules under test, against the schema the manifest REALLY points each command at:
  - `session.open`  `opening_balance`: absent is valid (the default is 0); 0 and a positive integer
    are accepted; a negative number or a non-integer (minor units, ADR-0123) is refused.
  - `count.add`     `total`: same floor — nobody counts minus cash in a drawer.
  - `movement.add`  `amount`: 0 and non-integers are refused; the SIGN is not the schema's business
    (the handler signs it from `movement_type`, cash_register#48).

Usage: tests/money_amounts.contract.test.py   (exit 0 = green)
"""

import json
import pathlib
import sys

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text(encoding="utf-8"))

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)
    print(f"  FAIL: {msg}")


def ok(msg: str) -> None:
    print(f"  ok: {msg}")


ABSENT = object()

CASES = {
    "cash_register.session.open": (
        {},
        "opening_balance",
        [
            ("absent (the default 0)", ABSENT, True),
            ("0", 0, True),
            ("125050 minor units", 125050, True),
            ("-125050 (a pasted «-1.250,50»)", -125050, False),
            ("-1", -1, False),
            ("12.5 (not minor units)", 12.5, False),
        ],
    ),
    "cash_register.count.add": (
        {"session_id": "s1", "count_type": "closing"},
        "total",
        [
            ("0", 0, True),
            ("125050 minor units", 125050, True),
            ("-125050 (a pasted «-1.250,50»)", -125050, False),
            ("-1", -1, False),
            ("12.5 (not minor units)", 12.5, False),
        ],
    ),
    "cash_register.movement.add": (
        {"session_id": "s1", "movement_type": "in", "payment_method": "cash"},
        "amount",
        [
            ("125050 minor units", 125050, True),
            ("0", 0, False),
            ("12.5 (not minor units)", 12.5, False),
            # A magnitude: legacy callers signed it themselves and the handler takes abs() and
            # applies the sign of movement_type (cash_register#48). The screen refuses a typed
            # negative before it gets here.
            ("-3000 (a legacy signed out)", -3000, True),
        ],
    ),
}


def main() -> int:
    try:
        import jsonschema  # type: ignore
    except ImportError:
        fail(
            "`jsonschema` is not importable: this layer REFUSES to skip (run with ERPLORA_PYTHON)"
        )
        return 1
    checked = 0
    for command, (base, field, cases) in CASES.items():
        print(f"· {command}: the `{field}` the schema lets through")
        schema_path = MANIFEST["commands"][command].get("schema")
        if not schema_path:
            fail(
                f"{command} declares no schema: the runtime would pass any {field} to the handler"
            )
            continue
        validator = jsonschema.Draft202012Validator(
            json.loads((MODULE_DIR / schema_path).read_text(encoding="utf-8"))
        )
        for label, value, expected in cases:
            payload = dict(base)
            if value is not ABSENT:
                payload[field] = value
            accepted = not list(validator.iter_errors(payload))
            verdict = "accepted" if expected else "refused"
            checked += 1
            if accepted == expected:
                ok(f"{field} {label} is {verdict}")
            else:
                fail(f"{field} {label} must be {verdict}")
    # Positive control: a run that compared nothing is not green.
    if checked == 0:
        fail("no case was checked")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
