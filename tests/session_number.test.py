#!/usr/bin/env python3
"""The SHIFT NUMBER of a cash session is the SERVER's (cash_register#49).

Opening the drawer by any door that is not this module's screen — the assistant, the installable
app, an integration — left the turn named after a UUID:

    S-898dbda8-39d7-4a13-b1c5-6d1a71b85b6a

38 characters, in the very column the manager talks about a shift by and searches the list with.
The fallback in `open_session.sql` (`'S-' || :session_id`) was deliberate — it solved the NOT NULL —
but it left the BUSINESS identifier in the caller's hands, and the schema declared `session_number`
as a free string, so nothing even pushed a caller to send a good one. The screen's own
`S-YYMMDD-HHMMSS` had its own hole: two terminals opening in the same second collide.

`sales` (`YYYYMMDD-NNNN`) and `payments` (`PAY-YYYYMMDD-NNNN`) already mint theirs with an atomic
per-(hub, day) counter. `cash_register` was the only one of the three without one. Now it has it,
and this file proves against a REAL Postgres:

  1. Manifest: `_bump_counter` exists as an internal SQL command and `session.open` no longer takes
     a caller-supplied number (the schema documents it as ignored).
  2. The minimum payload produces `S-YYMMDD-NNNN` — no UUID.
  3. Two opens the same day are correlative and different; a new day restarts at 0001.
  4. Two hubs do not share the series (the counter is keyed by hub).
  5. `sessions.list` finds a session by its number, which is what the manager types.

Usage: tests/session_number.test.py   (exit 0 = green)
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
DB = f"cash_register_session_number_test_{os.getpid()}"
HUB = "hub-a"
OTHER_HUB = "hub-b"
USER = "u-cashier"
PATTERN = re.compile(r"^S-\d{6}-\d{4,}$")

failures: list[str] = []


def fail(m: str) -> None:
    failures.append(m)
    print(f"  FAIL: {m}")


def ok(m: str) -> None:
    print(f"  ok: {m}")


def psql(args: list[str], db: str | None = None, stdin: str | None = None) -> str:
    cmd = ["docker", "exec", "-i", CONTAINER, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres"]
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
    return re.sub(r"(?<!:):([a-z_][a-z0-9_]*)",
                  lambda m: literal(params.get(m.group(1))), sql, flags=re.IGNORECASE)


def sys_params(payload: dict) -> dict:
    p = dict(payload)
    p.setdefault("hub_id", HUB)
    p.setdefault("current_user_id", USER)
    p.setdefault("now", "2026-08-21T19:45:46+00:00")
    p.setdefault("new_id", str(uuid.uuid4()))
    return p


def run_sql_command(name: str, payload: dict) -> None:
    cmd = MANIFEST["commands"][name]
    p = sys_params(payload)
    psql([], db=DB, stdin="\n".join(
        ["BEGIN;"] + [bind((MODULE_DIR / r).read_text(), p) for r in cmd["sql"]] + ["COMMIT;"]))


def run_query(name: str, payload: dict | None = None) -> list[dict]:
    q = MANIFEST["queries"][name]
    sql = bind((MODULE_DIR / q["sql"]).read_text(), sys_params(payload or {})).rstrip().rstrip(";")
    out = psql(["-tA", "-c", f"SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM ({sql}) t"], db=DB)
    return json.loads(out.strip() or "[]")


def open_session(day: str, session_day: str, hub: str = HUB, **extra) -> str:
    """What the WASM handler emits for one `cash_register.session.open`: bump the counter, then
    insert reading it back — both in the SAME transaction, which is what makes the number safe."""
    sid = str(uuid.uuid4())
    cmd_bump = MANIFEST["commands"]["cash_register._bump_counter"]
    cmd_ins = MANIFEST["commands"]["cash_register._open_session_insert"]
    p = sys_params({"session_id": sid, "day": day, "session_day": session_day,
                    "opening_balance": 5000, "register_id": None, "opening_notes": "",
                    "hub_id": hub, **extra})
    psql([], db=DB, stdin="\n".join(
        ["BEGIN;"]
        + [bind((MODULE_DIR / r).read_text(), sys_params({**p, "new_id": str(uuid.uuid4())}))
           for r in cmd_bump["sql"] + cmd_ins["sql"]]
        + ["COMMIT;"]))
    return sid


def number_of(sid: str) -> str | None:
    out = psql(["-tA", "-c", f"SELECT session_number FROM cash_register_session WHERE id = '{sid}'"],
               db=DB).strip()
    return out or None


def close_all(hub: str = HUB) -> None:
    """The partial unique index allows ONE open session per hub; closing frees the drawer for the
    next open, which is the real sequence a shift change produces."""
    psql(["-c", f"UPDATE cash_register_session SET status = 'closed' WHERE hub_id = '{hub}'"], db=DB)


def check_manifest() -> None:
    cmd = MANIFEST["commands"].get("cash_register._bump_counter")
    if not cmd or not cmd.get("sql"):
        fail("cash_register._bump_counter must exist as an internal SQL command")
    else:
        ok("cash_register._bump_counter is declared")
    schema = json.loads((MODULE_DIR / MANIFEST["commands"]["cash_register.session.open"]["schema"]).read_text())
    sn = schema.get("properties", {}).get("session_number")
    if sn is not None and not sn.get("deprecated"):
        fail("open_session.json still offers `session_number` as a live field: the number is the "
             "server's, so it must be gone or marked deprecated/ignored")
    else:
        ok("the payload no longer offers a live `session_number`")
    if ":session_number" in (MODULE_DIR / "commands/open_session.sql").read_text():
        fail("open_session.sql still binds :session_number — the caller can still name the shift")
    else:
        ok("open_session.sql does not bind a caller-supplied number")


def check_against_postgres() -> None:
    if subprocess.run(["docker", "inspect", CONTAINER], capture_output=True).returncode != 0:
        fail(f"container `{CONTAINER}` is not running")
        return
    psql(["-c", f'CREATE DATABASE "{DB}"'])
    try:
        for rel in MANIFEST["migrations"]["postgres"]:
            psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())

        first = number_of(open_session("20260821", "260821"))
        if first != "S-260821-0001":
            fail(f"the minimum payload must produce S-260821-0001, got {first!r}")
        else:
            ok("opening by command produces S-YYMMDD-NNNN — no UUID")
        if first and not PATTERN.match(first):
            fail(f"{first!r} does not match the canonical shape")

        close_all()
        second = number_of(open_session("20260821", "260821"))
        if second != "S-260821-0002":
            fail(f"the second open of the day must be S-260821-0002, got {second!r}")
        else:
            ok("two opens the same day are correlative and different")

        close_all()
        next_day = number_of(open_session("20260822", "260822"))
        if next_day != "S-260822-0001":
            fail(f"a new day must restart the series, got {next_day!r}")
        else:
            ok("a new day restarts at 0001")

        # Tenancy: the counter is keyed by hub, so the neighbour's shifts do not advance ours.
        # (A LIVE neighbour, not an empty one — an isolation test without a neighbour proves nothing.)
        other = number_of(open_session("20260822", "260822", hub=OTHER_HUB))
        if other != "S-260822-0001":
            fail(f"another hub must have its OWN series, got {other!r}")
        else:
            ok("two hubs do not share the series")
        close_all()
        close_all(OTHER_HUB)
        ours = number_of(open_session("20260822", "260822"))
        if ours != "S-260822-0002":
            fail(f"the neighbour's open must not advance our counter, expected S-260822-0002, got {ours!r}")
        else:
            ok("the neighbour's shift does not advance our counter")

        # What the manager actually does: types the number into the list.
        rows = run_query("cash_register.sessions.list")
        numbers = [r["session_number"] for r in rows]
        uuidish = [n for n in numbers if not PATTERN.match(n)]
        if uuidish:
            fail(f"sessions.list still shows numbers nobody can type: {uuidish}")
        else:
            ok(f"every session in the list is searchable by its number ({len(numbers)} rows)")
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'])


def main() -> int:
    print("[session number] manifest")
    check_manifest()
    print("[session number] real Postgres")
    check_against_postgres()
    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print("\nOK — the server mints the shift number, one series per hub and day")
    return 0


if __name__ == "__main__":
    sys.exit(main())
