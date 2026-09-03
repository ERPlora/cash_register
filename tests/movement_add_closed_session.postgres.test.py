#!/usr/bin/env python3
"""A manual movement (`movement.add`) does not land in a CLOSED session (cash_register#78).

`commands/add_movement.sql` resolved its session with

    WHERE s.id = :session_id AND s.hub_id = :hub_id AND s.is_deleted = 0

— no `AND s.status = 'open'`. The WASM handler (`add_movement_pure`) had no guard of its own
either: it only checked that `cash_register.session.summary` returned a row, and since
cash_register#77 that query answers for a CLOSED session too (the audited, frozen figure). So a
manual `in`/`out` movement typed against an already-counted-and-signed shift went straight in, by
the ONE door of the three ("open_session", "_record_refund", "movement.add") that checked nothing.

It desarms its own guard in the process: `allow_negative_balance` reads `expected_cash` from that
same `session.summary` row, which for a closed session is the FROZEN figure — so the guard could
neither see nor stop the write it was supposed to police.

THE FIX, pinned here at the SQL layer (`handler/src/lib.rs::add_movement_pure` carries the loud,
translated half — `cash_register.session_not_open` — pinned by `cargo test`): `add_movement.sql`
now filters `AND s.status = 'open'`, the same defence in depth `_refund_movement_for_open_session`
and `_reverse_movement_for_open_session` already had.

Usage: tests/movement_add_closed_session.postgres.test.py   (exit 0 = green)
  Uses the `erplora-test-pg-5433` container by default (override:
  CASH_REGISTER_TEST_PG_CONTAINER). Creates a scratch database and DROPS it at the end, pass or
  fail. It NEVER skips itself: a battery that goes green because it could not reach Postgres is
  worse than no battery at all.
"""

import json
import os
import pathlib
import re
import subprocess
import sys
import uuid

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text())
CONTAINER = os.environ.get("CASH_REGISTER_TEST_PG_CONTAINER", "erplora-test-pg-5433")
DB = f"cash_register_movement_add_closed_test_{os.getpid()}"
HUB = "hub-a"
USER = "u-cashier"

MOVEMENT_COMMAND = "cash_register._movement_insert"
OPENING_FLOAT = 10000  # 100,00 €

failures: list[str] = []


def fail(m: str) -> None:
    failures.append(m)
    print(f"  ✗ {m}")


def ok(m: str) -> None:
    print(f"  ✓ {m}")


def check(label: str, got, want) -> None:
    if got != want:
        fail(f"{label}: got {got!r}, want {want!r}")
    else:
        ok(label)


# ── Postgres plumbing (same shape as tests/void_after_shift_closed.postgres.test.py) ────────────


def psql(args: list[str], db: str | None = None, stdin: str | None = None) -> str:
    cmd = [
        "docker",
        "exec",
        "-i",
        CONTAINER,
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
    ]
    if db:
        cmd += ["-d", db]
    res = subprocess.run(cmd + args, input=stdin, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(res.stderr.strip() or res.stdout.strip())
    return res.stdout


def literal(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def bind(sql: str, params: dict) -> str:
    return re.sub(
        r"(?<!:):([a-z_][a-z0-9_]*)",
        lambda m: literal(params.get(m.group(1))),
        sql,
        flags=re.IGNORECASE,
    )


def sys_params(payload: dict, hub: str = HUB) -> dict:
    p = dict(payload)
    p.setdefault("hub_id", hub)
    p.setdefault("current_user_id", USER)
    p.setdefault("now", "2026-09-03T10:00:00+00:00")
    p.setdefault("new_id", str(uuid.uuid4()))
    return p


def run_sql_command(name: str, payload: dict, hub: str = HUB) -> None:
    cmd = MANIFEST["commands"][name]
    p = sys_params(payload, hub)
    if name == "cash_register._open_session_insert":
        p.setdefault("day", "20260903")
        p.setdefault("session_day", "260903")
        cmd = {
            "sql": MANIFEST["commands"]["cash_register._bump_counter"]["sql"]
            + cmd["sql"]
        }
    psql(
        [],
        db=DB,
        stdin="\n".join(
            ["BEGIN;"]
            + [bind((MODULE_DIR / r).read_text(), p) for r in cmd["sql"]]
            + ["COMMIT;"]
        ),
    )


def open_session(session_id: str, when: str, hub: str = HUB) -> None:
    run_sql_command(
        "cash_register._open_session_insert",
        {
            "session_id": session_id,
            "opening_balance": OPENING_FLOAT,
            "register_id": None,
            "opening_notes": "",
            "now": when,
        },
        hub,
    )


def close_session(session_id: str, counted: int, when: str, hub: str = HUB) -> None:
    run_sql_command(
        "cash_register._close_session_apply",
        {
            "session_id": session_id,
            "closing_balance": counted,
            "closing_notes": "",
            "now": when,
        },
        hub,
    )


def add_movement(session_id: str, amount: int, when: str, hub: str = HUB) -> str:
    """The write half of `movement.add`, exactly what `add_movement_pure` emits once it has
    checked the settings and (since cash_register#78) that the session is open."""
    movement_id = str(uuid.uuid4())
    run_sql_command(
        MOVEMENT_COMMAND,
        {
            "movement_id": movement_id,
            "session_id": session_id,
            "movement_type": "in" if amount > 0 else "out",
            "amount": amount,
            "payment_method": "cash",
            "payment_method_type": "cash",
            "sale_reference": "",
            "description": "manual movement",
            "now": when,
        },
        hub,
    )
    return movement_id


def movement_count(session_id: str) -> int:
    return int(
        psql(
            [
                "-tA",
                "-c",
                "SELECT COUNT(*) FROM cash_register_movement"
                f" WHERE session_id = '{session_id}' AND is_deleted = 0",
            ],
            db=DB,
        ).strip()
    )


def run_cases() -> None:
    # ── 1. THE ISSUE ────────────────────────────────────────────────────────────────────────────
    print("\n1 · a manual movement typed against an already-CLOSED session")
    closed = str(uuid.uuid4())
    open_session(closed, "2026-09-03T08:00:00+00:00")
    close_session(closed, OPENING_FLOAT, "2026-09-03T14:00:00+00:00")
    check("the shift is closed and counted square", movement_count(closed), 0)

    add_movement(closed, -5000, "2026-09-03T16:00:00+00:00")
    check("no row is written into the closed session", movement_count(closed), 0)

    # ── 2. THE CONTROL: an OPEN session still takes the movement ────────────────────────────────
    print("\n2 · the control: the same door still writes into an OPEN session")
    open_id = str(uuid.uuid4())
    open_session(open_id, "2026-09-03T09:00:00+00:00")
    add_movement(open_id, -5000, "2026-09-03T09:30:00+00:00")
    check("the movement lands in the open session", movement_count(open_id), 1)


def main() -> int:
    print(f"[movement-add-closed-session] real Postgres · container {CONTAINER}")
    if (
        subprocess.run(["docker", "inspect", CONTAINER], capture_output=True).returncode
        != 0
    ):
        print(f"  ✗ container `{CONTAINER}` is not running")
        return 1
    psql(["-c", f'CREATE DATABASE "{DB}"'])
    try:
        for rel in MANIFEST["migrations"]["postgres"]:
            psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
        run_cases()
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'])

    print()
    if failures:
        print(f"✗ {len(failures)} failure(s)")
        return 1
    print("✓ a manual movement never lands in a session that is not open")
    return 0


if __name__ == "__main__":
    sys.exit(main())
