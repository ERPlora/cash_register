#!/usr/bin/env python3
"""Automatic daily close of the cash session (cash_register#23) — the Z cut-off at a fixed hour.

The market (Toast: every open drawer is closed at the business-day cut-off, 4:00 AM by default;
Lightspeed Restaurant: automatic Z report at closing time; Odoo: auto-close-session apps driven by
a cron) closes what nobody closed at a configured LOCAL hour. Nobody opens a session "on login" or
closes it "on logout": those two settings of this module were never read by anyone, so they leave
the schema instead of lying in the settings screen.

What this file proves, against the manifest and a REAL Postgres built from the module's own
migrations (plus the core's `hub_settings` table, which the hub creates and this command reads for
the business time zone, like `taxes` does for the country):

  1. Manifest: a `scheduled_task` runs the module's own `_auto_close_sessions` command; the settings
     schema declares `auto_close_enabled` (off by default) + `auto_close_time` (HH:MM) and no
     longer declares `auto_open_session_on_login` / `auto_close_session_on_logout`.
  2. Disabled (default): the command touches nothing.
  3. Enabled at 23:00 Europe/Madrid: before the cut-off nothing happens; after it every open
     session of THAT hub opened before the cut-off is closed — attributed to the system (no user),
     `closing_balance` NULL (nobody counted), `expected_balance` computed, `closing_notes` marks it.
     Another hub is untouched.
  4. Catch-up: the hub slept through the cut-off and wakes up next morning → the stale session
     (opened before yesterday's cut-off) is closed; a session opened this morning is not.
  5. Time zone: an explicit `hub_settings.timezone` wins; otherwise the country decides (ES → Madrid).

Usage: tests/auto_close.test.py   (exit 0 = green)
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

# cash_register#38: the public open/close/movement commands are WASM handlers (settings enforced on
# the server) that resolve to these internal SQL commands. This file drives the SQL directly, with
# the ids the handler would have handed over (`session_id` / `movement_id` = new_ids[0]).
# cash_register#49: opening is TWO commands in one transaction — the atomic per-(hub, day)
# counter, then the insert that reads it back to compose `S-YYMMDD-NNNN`. The shift number stopped
# being the caller's, so a harness that runs only the insert would produce a session with no number
# at all.
SQL_OF = {
    "cash_register.session.open": ["cash_register._bump_counter", "cash_register._open_session_insert"],
    "cash_register.session.close": "cash_register._close_session_apply",
    "cash_register.movement.add": "cash_register._movement_insert",
}

CONTAINER = os.environ.get("CASH_REGISTER_TEST_PG_CONTAINER", "erplora-test-pg-5433")
DB = f"cash_register_auto_close_test_{os.getpid()}"
HUB = "hub-a"
OTHER_HUB = "hub-b"
USER = "u-cashier"
COMMAND = "cash_register._auto_close_sessions"
DUE = "cash_register.sessions.due_for_auto_close"
APPLY = "cash_register._auto_close_session_apply"
TASK = "auto_close_sessions"
DEAD = ("auto_open_session_on_login", "auto_close_session_on_logout")

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


# The runtime lowers the portable bridge functions to native Postgres (hub/crates/db/src/lib.rs).
# Only the ones this module's SQL uses are mirrored here.
def lower_bridge(sql: str) -> str:
    sql = re.sub(
        r"erp_dt\(([^()]*(?:\([^()]*\))?[^()]*)\)", r"((\1)::timestamptz)", sql
    )
    return sql


def bind(sql: str, params: dict) -> str:
    sql = lower_bridge(sql)
    # `(?<!:)` keeps Postgres casts (`::timestamptz`) out of the bind, like the runtime does.
    return re.sub(
        r"(?<!:):([a-z_][a-z0-9_]*)",
        lambda m: literal(params.get(m.group(1))),
        sql,
        flags=re.IGNORECASE,
    )


def run_command(
    name: str,
    payload: dict,
    hub: str = HUB,
    now: str = "2026-08-18T10:00:00+00:00",
    user: str = USER,
) -> int:
    names = SQL_OF.get(name, name)
    names = [names] if isinstance(names, str) else list(names)
    sql_files = [rel for n in names for rel in MANIFEST["commands"][n]["sql"]]
    params = dict(payload)
    params.setdefault("hub_id", hub)
    params.setdefault("current_user_id", user)
    params.setdefault("now", now)
    params.setdefault("new_id", str(uuid.uuid4()))
    params.setdefault("session_id", params["new_id"])
    params.setdefault("movement_id", params["new_id"])
    params.setdefault("day", "20260818")
    params.setdefault("session_day", "260818")
    script = (
        ["BEGIN;"]
        + [bind((MODULE_DIR / rel).read_text(), params) for rel in sql_files]
        + ["COMMIT;"]
    )
    out = psql([], db=DB, stdin="\n".join(script))
    return sum(
        int(m.group(1))
        for m in re.finditer(r"^(?:INSERT \d+|UPDATE|DELETE) (\d+)$", out, re.MULTILINE)
    )


def run_auto_close(hub: str = HUB, now: str = "2026-08-18T10:00:00+00:00") -> int:
    """What one pass of `_auto_close_sessions` does (cash_register#145): the trusted read decides
    which sessions are due and the WASM handler closes each one through `_auto_close_session_apply`,
    all in one transaction. Driven here as SQL with the system context (no user)."""
    cmd = MANIFEST["commands"][COMMAND]
    params = {"hub_id": hub, "current_user_id": "", "now": now}
    due_sql = MANIFEST["queries"][cmd["reads"][0]["query"]]["sql"]
    out = psql(["-At"], db=DB, stdin=bind((MODULE_DIR / due_sql).read_text(), params))
    due = [line for line in out.splitlines() if line.strip()]
    if not due:
        return 0
    apply_sql = (MODULE_DIR / MANIFEST["commands"][APPLY]["sql"][0]).read_text()
    script = (
        ["BEGIN;"]
        + [bind(apply_sql, {**params, "session_id": sid}) for sid in due]
        + ["COMMIT;"]
    )
    out = psql([], db=DB, stdin="\n".join(script))
    return sum(
        int(m.group(1)) for m in re.finditer(r"^UPDATE (\d+)$", out, re.MULTILINE)
    )


def session(sid: str) -> dict:
    return json.loads(
        psql(
            [
                "-tA",
                "-c",
                f"SELECT row_to_json(s) FROM cash_register_session s WHERE id = '{sid}'",
            ],
            db=DB,
        ).strip()
    )


def open_at(sid: str, opened_at: str, hub: str = HUB, opening: int = 10000) -> None:
    psql(
        [
            "-c",
            "INSERT INTO cash_register_session (id, hub_id, user_id, session_number, status, opened_at, opening_balance, is_deleted) "
            f"VALUES ('{sid}', '{hub}', '{USER}', 'S-{sid}', 'open', '{opened_at}', {opening}, 0)",
        ],
        db=DB,
    )


def set_hub_setting(key: str, value: str | None, hub: str = HUB) -> None:
    psql(
        ["-c", f"DELETE FROM hub_settings WHERE hub_id = '{hub}' AND key = '{key}'"],
        db=DB,
    )
    if value is not None:
        psql(
            [
                "-c",
                f"INSERT INTO hub_settings (hub_id, key, value) VALUES ('{hub}', '{key}', '{value}')",
            ],
            db=DB,
        )


def settings_payload(**overrides) -> dict:
    base = {
        "enable_cash_register": True,
        "require_opening_balance": False,
        "require_closing_balance": True,
        "allow_negative_balance": False,
        "require_blind_count": False,
        "auto_close_enabled": False,
        "auto_close_time": "23:00",
        "protected_pos_url": "/m/sales/pos/",
    }
    base.update(overrides)
    return base


# ── Manifest ─────────────────────────────────────────────────────────────────────────────


def check_manifest() -> None:
    tasks = [t for t in MANIFEST.get("scheduled_tasks", []) if t.get("name") == TASK]
    if not tasks:
        fail(f"no scheduled_task `{TASK}` — nothing closes what nobody closed")
    else:
        t = tasks[0]
        if t.get("command") != COMMAND:
            fail(
                f"scheduled_task `{TASK}` must run `{COMMAND}`, got {t.get('command')!r}"
            )
        elif COMMAND not in MANIFEST["commands"]:
            fail(
                f"`{COMMAND}` is not a command of this module (the scheduler only runs the module's own)"
            )
        else:
            ok(
                f"scheduled_task `{TASK}` → `{COMMAND}` ({t.get('cron')}, catch_up={t.get('catch_up', 'collapse')})"
            )
        if t.get("catch_up", "collapse") != "collapse":
            fail(
                "catch_up must be `collapse`: a hub that slept through the cut-off closes ONCE on boot"
            )
    # cash_register#145: a declared `emit` is written once per EXECUTION — every 5-minute pass
    # announced «drawer closed» whether it closed one or not. The handler announces each session it
    # closes (widgets and the POS guard refresh on it), so the command must declare none.
    cmd = MANIFEST["commands"].get(COMMAND, {})
    if cmd.get("emit"):
        fail(
            f"`{COMMAND}` must not declare `emit` (it would announce a close on every pass): {cmd['emit']}"
        )
    elif cmd.get("handler", {}).get("function") != "auto_close_sessions" or [
        r.get("query") for r in cmd.get("reads", [])
    ] != [DUE]:
        fail(
            f"`{COMMAND}` must run the WASM handler `auto_close_sessions` over the read `{DUE}`"
        )
    else:
        ok(f"`{COMMAND}` = handler over `{DUE}`, no declared emit")
    if MANIFEST["commands"].get(APPLY, {}).get("min_affected_rows") != 1:
        fail(
            f"`{APPLY}` must declare min_affected_rows: 1 (a drawer closed by hand meanwhile rolls the pass back)"
        )

    schema = json.loads((MODULE_DIR / "schemas" / "settings_update.json").read_text())
    props = schema.get("properties", {})
    if props.get("auto_close_enabled", {}).get("type") != "boolean":
        fail(
            "settings schema must declare `auto_close_enabled` (boolean, off by default)"
        )
    else:
        ok("settings schema declares `auto_close_enabled`")
    time_prop = props.get("auto_close_time", {})
    if time_prop.get("type") != "string" or not time_prop.get("enum"):
        fail(
            "settings schema must declare `auto_close_time` as a string with an `enum` of HH:MM values (a select, not a keyboard)"
        )
    elif any(not re.fullmatch(r"\d{2}:\d{2}", v) for v in time_prop["enum"]):
        fail(
            f"`auto_close_time` enum must be HH:MM values, got {time_prop['enum'][:3]}…"
        )
    else:
        ok("settings schema declares `auto_close_time` (HH:MM select)")
    for dead in DEAD:
        if dead in props or dead in schema.get("required", []):
            fail(
                f"`{dead}` is still in the settings schema — nobody reads it, it must not be offered"
            )
    else:
        ok(
            "dead settings auto_open_session_on_login / auto_close_session_on_logout are gone from the schema"
        )
    # cash_register#41: the bridge is over. `additionalProperties: true` was a temporary crutch
    # (cash_register#23) for callers that still sent the retired keys; the last one was the hub's
    # own e2e (ERPlora/hub#1028, merged via hub#1062). With it gone, an unknown key must be
    # REJECTED again — a typo in a settings key silently doing nothing is exactly what
    # `additionalProperties: false` exists to catch.
    if schema.get("additionalProperties") is not False:
        fail(
            "settings schema must be `additionalProperties: false` again — the hub e2e no longer "
            "sends the retired keys (hub#1028), so the bridge of cash_register#23 is over"
        )
    elif "$comment" in schema:
        fail("the bridge `$comment` of cash_register#23 must go with the bridge")
    else:
        ok("settings schema rejects unknown keys again (additionalProperties: false, no bridge)")

    for lang in ("en", "es"):
        ui = json.loads((MODULE_DIR / "locales" / f"{lang}.json").read_text()).get(
            "ui", {}
        )
        for key in ("toggleAutoClose", "labelAutoCloseTime", "autoClosedNote"):
            if not ui.get(key):
                fail(f"locales/{lang}.json: ui.{key} missing")


# ── Real Postgres ────────────────────────────────────────────────────────────────────────


def check_against_postgres() -> None:
    if (
        subprocess.run(["docker", "inspect", CONTAINER], capture_output=True).returncode
        != 0
    ):
        fail(
            f"container `{CONTAINER}` is not running — this can only be proven against Postgres"
        )
        return

    psql(["-c", f'CREATE DATABASE "{DB}"'])
    try:
        for rel in MANIFEST["migrations"]["postgres"]:
            psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
        # The core's settings table (hub/crates/runtime/src/settings.rs) — the hub creates it.
        psql(
            [
                "-c",
                "CREATE TABLE hub_settings (hub_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL DEFAULT '', "
                "updated_at TEXT, updated_by TEXT, PRIMARY KEY (hub_id, key))",
            ],
            db=DB,
        )
        ok("migrations apply on a clean Postgres")

        # 2. Disabled (default): nothing happens, even long after any cut-off.
        run_command("cash_register.settings.update", settings_payload())
        open_at("s-off", "2026-08-10T18:00:00+00:00")
        n = run_auto_close(now="2026-08-18T10:00:00+00:00")
        if n != 0 or session("s-off")["status"] != "open":
            fail(
                f"auto close DISABLED must touch nothing (affected={n}, status={session('s-off')['status']})"
            )
        else:
            ok("disabled → nothing closes")
        psql(["-c", "DELETE FROM cash_register_session"], db=DB)

        # 3. Enabled at 23:00 Europe/Madrid (explicit time zone).
        set_hub_setting("timezone", "Europe/Madrid")
        run_command(
            "cash_register.settings.update",
            settings_payload(auto_close_enabled=True, auto_close_time="23:00"),
        )
        open_at("s-1", "2026-08-17T16:00:00+00:00")  # 18:00 Madrid, the day's shift
        open_at(
            "s-b", "2026-08-17T16:00:00+00:00", hub=OTHER_HUB
        )  # other hub, auto close not enabled there
        psql(
            [
                "-c",
                "INSERT INTO cash_register_movement (id, hub_id, session_id, movement_type, amount, payment_method, payment_method_type, is_deleted) "
                f"VALUES ('m-1', '{HUB}', 's-1', 'sale', 2500, 'cash', 'cash', 0)",
            ],
            db=DB,
        )
        n = run_auto_close(now="2026-08-17T20:30:00+00:00")  # 22:30 Madrid
        if n != 0 or session("s-1")["status"] != "open":
            fail(f"before the cut-off (22:30 local) nothing must close (affected={n})")
        else:
            ok("22:30 local, cut-off 23:00 → still open")
        # Tenancy of the close itself (rv cash_register#148): the apply is reached with an id the
        # trusted read chose, but it must still refuse to close a drawer under another hub's id —
        # 0 rows, the session stays open.
        out = psql([], db=DB, stdin=bind(
            (MODULE_DIR / MANIFEST["commands"][APPLY]["sql"][0]).read_text(),
            {"hub_id": OTHER_HUB, "current_user_id": "", "now": "2026-08-17T21:05:00+00:00", "session_id": "s-1"}))
        if "UPDATE 0" not in out or session("s-1")["status"] != "open":
            fail(f"`{APPLY}` must not close a session under another hub's id (psql={out.strip()!r}, status={session('s-1')['status']!r})")
        else:
            ok("the apply under another hub's id touches 0 rows")
        n = run_auto_close(now="2026-08-17T21:05:00+00:00")  # 23:05 Madrid
        row = session("s-1")
        if n != 1 or row["status"] != "closed":
            fail(
                f"after the cut-off (23:05 local) the session must be closed (affected={n}, status={row['status']})"
            )
        else:
            ok("23:05 local → session closed by the schedule")
            if row["closing_balance"] is not None:
                fail(
                    f"an automatic close must NOT invent a counted amount (closing_balance={row['closing_balance']})"
                )
            if row["expected_balance"] != 12500:
                fail(
                    f"expected_balance must be computed like a manual close (10000 + 2500), got {row['expected_balance']}"
                )
            if (
                row["updated_by"] not in ("", None)
                or (row["closing_notes"] or "") == ""
            ):
                fail(
                    f"the close must be attributed to the system and marked in closing_notes, got updated_by={row['updated_by']!r} notes={row['closing_notes']!r}"
                )
            else:
                ok(
                    f"attributed to the system (updated_by empty), notes={row['closing_notes']!r}, counted NULL, expected 12500"
                )
            if row["closed_at"] != "2026-08-17T21:05:00+00:00":
                fail(
                    f"closed_at must be the run instant (:now), got {row['closed_at']!r}"
                )
        if session("s-b")["status"] != "open":
            fail("the OTHER hub's session was closed — the setting is per hub")
        else:
            ok("other hub untouched")

        # cash_register#145: the read and the close are two steps. A drawer somebody closed by hand
        # in between must not be closed again (its count, its closing time) — the apply touches 0
        # rows and `min_affected_rows: 1` rolls the pass back instead of announcing a close.
        psql(["-c", "UPDATE cash_register_session SET closing_balance = 12000, difference = -500 WHERE id = 's-1'"], db=DB)
        out = psql([], db=DB, stdin=bind(
            (MODULE_DIR / MANIFEST["commands"][APPLY]["sql"][0]).read_text(),
            {"hub_id": HUB, "current_user_id": "", "now": "2026-08-17T21:10:00+00:00", "session_id": "s-1"}))
        again = session("s-1")
        if "UPDATE 0" not in out or again["closed_at"] != "2026-08-17T21:05:00+00:00" or again["closing_balance"] != 12000:
            fail(f"`{APPLY}` must not touch an already-closed drawer (psql={out.strip()!r}, closed_at={again['closed_at']!r}, counted={again['closing_balance']!r})")
        else:
            ok("an already-closed drawer is not closed again (0 rows: the pass would roll back)")

        # 4. Catch-up: the hub slept through the 23:00 cut-off; next morning the stale session goes,
        #    the one opened this morning stays.
        psql(["-c", "DELETE FROM cash_register_session"], db=DB)
        open_at(
            "s-stale", "2026-08-17T16:00:00+00:00"
        )  # yesterday 18:00 Madrid, never closed
        # (the partial unique index allows ONE open per hub → close it before opening the fresh one)
        n = run_auto_close(now="2026-08-18T05:00:00+00:00")  # 07:00 Madrid next day
        if n != 1 or session("s-stale")["status"] != "closed":
            fail(
                f"catch-up: a session opened before YESTERDAY's cut-off must be closed next morning (affected={n})"
            )
        else:
            ok("catch-up next morning → yesterday's stale session closed")
        open_at("s-fresh", "2026-08-18T05:30:00+00:00")  # 07:30 Madrid today
        n = run_auto_close(now="2026-08-18T06:00:00+00:00")  # 08:00 Madrid
        if n != 0 or session("s-fresh")["status"] != "open":
            fail(
                f"a session opened AFTER the last cut-off must not be closed (affected={n})"
            )
        else:
            ok("today's fresh session stays open until tonight's cut-off")

        # 5. Time zone from the country when no explicit zone: ES → Europe/Madrid (UTC+2 in August).
        psql(["-c", "DELETE FROM cash_register_session"], db=DB)
        set_hub_setting("timezone", None)
        set_hub_setting("country_code", "ES")
        open_at("s-es", "2026-08-17T16:00:00+00:00")
        n = run_auto_close(now="2026-08-17T20:30:00+00:00")  # 22:30 Madrid, 20:30 UTC
        if n != 0:
            fail(
                "country ES without explicit zone must resolve to Europe/Madrid (20:30 UTC = 22:30 local, before 23:00)"
            )
        n = run_auto_close(now="2026-08-17T21:05:00+00:00")
        if n != 1:
            fail(
                "country ES without explicit zone: 21:05 UTC = 23:05 Madrid → must close"
            )
        else:
            ok("no explicit zone → the country decides (ES → Europe/Madrid)")
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'])


def main() -> int:
    print("[auto close] manifest")
    check_manifest()
    print("[auto close] real Postgres")
    check_against_postgres()
    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print("\nOK — the schedule closes what nobody closed, at the business's own hour")
    return 0


if __name__ == "__main__":
    sys.exit(main())
