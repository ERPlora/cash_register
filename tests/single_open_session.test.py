#!/usr/bin/env python3
"""One open cash session per hub — the invariant lives in the DATABASE (cash_register#11).

QA 2026-08-10 opened S-260810-194927, kept it open, pressed "Open session" again and got
S-260810-194937: two sessions `open` at once for the same hub. Every reader of "the open session"
(`current_session`, `_movement_for_open_session`, the POS guard) picks ONE of them by
`ORDER BY opened_at DESC LIMIT 1`, so sales landed in a drawer nobody would ever count. The UI is
not the place to fix that: two tabs, two devices or a retried request all get past a button.

What this file proves, against a REAL Postgres built from the module's own migrations:

  1. The schema carries a partial UNIQUE index on `(hub_id) WHERE status = 'open' AND is_deleted = 0`
     — the rule belongs to the engine, so a raw INSERT of a second open session is refused too.
  2. `cash_register.session.open` run twice for the same hub leaves exactly ONE open session, and the
     second run touches 0 rows without raising (so the declared `expect_rows` gate turns it into the
     domain error `cash_register.session_already_open` instead of a 500).
  3. Another hub is not affected (the invariant is per hub), and once the session is CLOSED the hub
     can open again (the index is partial, history is not blocked).
  4. The manifest declares the gate: `expect_rows {min 1, error cash_register.session_already_open}`
     on the open command, and both locales translate the error the UI shows.

Usage: tests/single_open_session.test.py   (exit 0 = green)
  Uses the `erplora-test-pg-5433` container (override: CASH_REGISTER_TEST_PG_CONTAINER) and drops
  its scratch database at the end, pass or fail.
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
DB = f"cash_register_open_session_test_{os.getpid()}"
HUB = "hub-a"
OTHER_HUB = "hub-b"
USER = "u-cashier"
ERROR_CODE = "cash_register.session_already_open"

failures: list[str] = []


def fail(message: str) -> None:
    failures.append(message)
    print(f"  FAIL: {message}")


def ok(label: str) -> None:
    print(f"  ok: {label}")


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


def literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def bind(sql: str, params: dict) -> str:
    return re.sub(
        r":([a-z_][a-z0-9_]*)",
        lambda m: literal(params.get(m.group(1))),
        sql,
        flags=re.IGNORECASE,
    )


def run_command(name: str, payload: dict, hub: str = HUB) -> int:
    """The command's `sql[]` in one transaction with the system params bound, like the runtime.
    Returns the number of rows the statements affected (what `expect_rows` gates on)."""
    cmd = MANIFEST["commands"][name]
    params = dict(payload)
    params.setdefault("hub_id", hub)
    params.setdefault("current_user_id", USER)
    params.setdefault("now", "2026-08-18T10:00:00Z")
    params.setdefault("new_id", str(uuid.uuid4()))
    affected = 0
    script = ["BEGIN;"]
    for rel in cmd["sql"]:
        script.append(bind((MODULE_DIR / rel).read_text(), params))
    script.append("COMMIT;")
    out = psql([], db=DB, stdin="\n".join(script))
    # psql prints one `INSERT 0 n` / `UPDATE n` tag per statement.
    for m in re.finditer(r"^(?:INSERT \d+|UPDATE|DELETE) (\d+)$", out, re.MULTILINE):
        affected += int(m.group(1))
    return affected


def open_sessions(hub: str) -> int:
    out = psql(
        [
            "-tAc",
            f"SELECT count(*) FROM cash_register_session WHERE hub_id = '{hub}' AND status = 'open' AND is_deleted = 0",
        ],
        db=DB,
    )
    return int(out.strip())


def open_session_id(hub: str) -> str:
    return psql(
        [
            "-tAc",
            f"SELECT id FROM cash_register_session WHERE hub_id = '{hub}' AND status = 'open' AND is_deleted = 0",
        ],
        db=DB,
    ).strip()


# ── Manifest: the gate and its translations ─────────────────────────────────────────────


def check_manifest() -> None:
    cmd = MANIFEST["commands"]["cash_register.session.open"]
    gate = cmd.get("expect_rows")
    if not isinstance(gate, dict):
        fail(
            "cash_register.session.open declares no `expect_rows` — a refused open would be a silent success"
        )
        return
    if gate.get("op") != "min" or gate.get("n") != 1:
        fail(f"expect_rows must be {{op: min, n: 1}}, got {gate}")
    if gate.get("error") != ERROR_CODE:
        fail(f"expect_rows.error must be {ERROR_CODE!r}, got {gate.get('error')!r}")
    else:
        ok(f"session.open is gated with {ERROR_CODE}")
    for lang in ("en", "es"):
        ui = json.loads((MODULE_DIR / "locales" / f"{lang}.json").read_text()).get(
            "ui", {}
        )
        if not ui.get("errSessionAlreadyOpen"):
            fail(
                f"locales/{lang}.json: ui.errSessionAlreadyOpen missing — the UI could not translate the refusal"
            )
    en = (
        json.loads((MODULE_DIR / "locales" / "en.json").read_text())
        .get("ui", {})
        .get("errSessionAlreadyOpen")
    )
    es = (
        json.loads((MODULE_DIR / "locales" / "es.json").read_text())
        .get("ui", {})
        .get("errSessionAlreadyOpen")
    )
    if en and es and en == es:
        fail("locales/es.json: ui.errSessionAlreadyOpen is still the English string")


# ── Real Postgres ────────────────────────────────────────────────────────────────────────


def check_against_postgres() -> None:
    if (
        subprocess.run(["docker", "inspect", CONTAINER], capture_output=True).returncode
        != 0
    ):
        fail(
            f"container `{CONTAINER}` is not running — this invariant can only be proven against Postgres"
        )
        return

    psql(["-c", f'CREATE DATABASE "{DB}"'])
    try:
        for rel in MANIFEST["migrations"]["postgres"]:
            psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
        ok("migrations apply on a clean Postgres")

        # 1. The rule is in the schema: a raw second open row is refused by the engine itself.
        first = run_command(
            "cash_register.session.open",
            {"opening_balance": 1000, "session_number": "S-1"},
        )
        if first != 1 or open_sessions(HUB) != 1:
            fail(
                f"first open should insert exactly one row (affected={first}, open={open_sessions(HUB)})"
            )
        raw = (
            "INSERT INTO cash_register_session (id, hub_id, user_id, session_number, status, is_deleted) "
            f"VALUES ('raw-2', '{HUB}', '{USER}', 'S-RAW', 'open', 0)"
        )
        try:
            psql(["-c", raw], db=DB)
            fail(
                "a raw INSERT of a SECOND open session for the same hub was accepted — no unique invariant in the schema"
            )
        except RuntimeError as e:
            if "unique" in str(e).lower() or "duplicate key" in str(e).lower():
                ok(
                    "the schema refuses a second open session for the same hub (partial unique index)"
                )
            else:
                fail(f"raw second open failed for the wrong reason: {e}")

        # 2. The command run again touches 0 rows without raising → the gate turns it into a domain error.
        second = run_command(
            "cash_register.session.open",
            {"opening_balance": 500, "session_number": "S-2"},
        )
        if second != 0:
            fail(
                f"second session.open on the same hub affected {second} row(s); it must affect 0 (ON CONFLICT DO NOTHING)"
            )
        elif open_sessions(HUB) != 1:
            fail(
                f"after two opens the hub has {open_sessions(HUB)} open sessions, expected 1"
            )
        else:
            ok(
                "session.open twice → still ONE open session, second run affects 0 rows (gate → domain error)"
            )

        # 3. Per hub: another hub opens fine; after closing, the same hub opens again.
        if (
            run_command(
                "cash_register.session.open",
                {"opening_balance": 0, "session_number": "S-B"},
                hub=OTHER_HUB,
            )
            != 1
        ):
            fail(
                "another hub could not open its own session — the invariant leaked across hubs"
            )
        else:
            ok("another hub opens its own session (invariant is per hub)")
        sid = open_session_id(HUB)
        run_command(
            "cash_register.session.close",
            {"session_id": sid, "closing_balance": 1000, "closing_notes": ""},
        )
        if open_sessions(HUB) != 0:
            fail("close did not close the open session")
        reopened = run_command(
            "cash_register.session.open",
            {"opening_balance": 200, "session_number": "S-3"},
        )
        if reopened != 1 or open_sessions(HUB) != 1:
            fail(
                f"after closing, reopening affected {reopened} row(s) (open={open_sessions(HUB)}), expected 1"
            )
        else:
            ok("after closing, the hub can open a new session (index is partial)")
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'])


def check_migration_heals_existing_duplicates() -> None:
    """Hubs that already hit the bug have two `open` rows. The migration must keep the MOST RECENT
    one open (the drawer the cashier is using) and close the older, so the index can be built."""
    if subprocess.run(["docker", "inspect", CONTAINER], capture_output=True).returncode != 0:
        return
    db = f"{DB}_dups"
    psql(["-c", f'CREATE DATABASE "{db}"'])
    try:
        migrations = MANIFEST["migrations"]["postgres"]
        for rel in migrations[:-1]:
            psql([], db=db, stdin=(MODULE_DIR / rel).read_text())
        seed = (
            "INSERT INTO cash_register_session (id, hub_id, user_id, session_number, status, opened_at, is_deleted) VALUES "
            f"('old', '{HUB}', '{USER}', 'S-OLD', 'open', '2026-08-10T19:49:27Z', 0), "
            f"('new', '{HUB}', '{USER}', 'S-NEW', 'open', '2026-08-10T19:49:37Z', 0), "
            f"('other', '{OTHER_HUB}', '{USER}', 'S-B', 'open', '2026-08-10T19:00:00Z', 0)"
        )
        psql(["-c", seed], db=db)
        psql([], db=db, stdin=(MODULE_DIR / migrations[-1]).read_text())
        rows = psql(["-tAc", "SELECT id || ':' || status FROM cash_register_session ORDER BY id"], db=db).split()
        if rows != ["new:open", "old:closed", "other:open"]:
            fail(f"migration on a hub with duplicate open sessions left {rows}; expected the newest open, the older closed, other hubs untouched")
        else:
            ok("the migration heals existing duplicates: newest stays open, older gets closed, other hubs untouched")
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{db}" WITH (FORCE)'])


def main() -> int:
    print("[single open session] manifest gate")
    check_manifest()
    print("[single open session] real Postgres")
    check_against_postgres()
    check_migration_heals_existing_duplicates()
    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print("\nOK — one open session per hub, enforced by the database")
    return 0


if __name__ == "__main__":
    sys.exit(main())
