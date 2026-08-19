#!/usr/bin/env python3
"""Blind cash count (cash_register#24) — the expected total is a MANAGER number, and the module
can be told to hide it from the person counting.

The market (Square "blind close", Toast "blind cash drawer close" + the "view expected cash"
permission, Lightspeed "blind cash count") does two things at once: a per-business SETTING that
makes the close blind, and a PERMISSION that lets supervisors see the expected amount anyway. Both
have to live on the server: the closing form already asks only for the counted cash, but the
dashboard widget `cash_register.current_session` streamed `expected_total` live to anyone holding
`cash_register.view_session` — the cashier could read what the drawer "should" hold and make the
count match. A blind count that leaks through a widget is not blind.

What this file proves, against the manifest and a REAL Postgres built from the module's own
migrations:

  1. Manifest: a `require_blind_count` setting exists (schema + default off), a
     `cash_register.view_expected_totals` permission exists, the widget requires it, the widget's
     query requires it too (the query is the second door — the widget is only a picture of it), and
     neither `employee` nor `cashier` is granted it.
  2. With `require_blind_count = 1`, `cash_register.current_session` (the guard query every till
     user can run) still says "there is an open session" but carries NO `expected_total`; the
     dedicated `cash_register.current_session.expected` query (supervisor permission) still does.
  3. With the setting off (default, and with no settings row at all) `current_session` keeps
     returning `expected_total` — nothing changes for hubs that never turn it on.
  4. The difference is only computed when the count is DECLARED (`session.close` stores expected,
     counted and difference on the row — the audit trail), never before.

Usage: tests/blind_count.test.py   (exit 0 = green)
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
SQL_OF = {
    "cash_register.session.open": "cash_register._open_session_insert",
    "cash_register.session.close": "cash_register._close_session_apply",
    "cash_register.movement.add": "cash_register._movement_insert",
}

CONTAINER = os.environ.get("CASH_REGISTER_TEST_PG_CONTAINER", "erplora-test-pg-5433")
DB = f"cash_register_blind_count_test_{os.getpid()}"
HUB = "hub-a"
USER = "u-cashier"
PERMISSION = "cash_register.view_expected_totals"
GUARD_QUERY = "cash_register.current_session"
EXPECTED_QUERY = "cash_register.current_session.expected"
WIDGET = "cash_register.current_session"
SETTING = "require_blind_count"

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


def system_params(payload: dict, hub: str = HUB) -> dict:
    params = dict(payload)
    params.setdefault("hub_id", hub)
    params.setdefault("current_user_id", USER)
    params.setdefault("now", "2026-08-18T10:00:00Z")
    params.setdefault("new_id", str(uuid.uuid4()))
    params.setdefault("session_id", params["new_id"])
    params.setdefault("movement_id", params["new_id"])
    return params


def run_command(name: str, payload: dict, hub: str = HUB) -> None:
    name = SQL_OF.get(name, name)
    cmd = MANIFEST["commands"][name]
    params = system_params(payload, hub)
    script = (
        ["BEGIN;"]
        + [bind((MODULE_DIR / rel).read_text(), params) for rel in cmd["sql"]]
        + ["COMMIT;"]
    )
    psql([], db=DB, stdin="\n".join(script))


def run_query(name: str, payload: dict | None = None, hub: str = HUB) -> list[dict]:
    """The query's SQL with the system params bound, rows as dicts (like the runtime returns them)."""
    q = MANIFEST["queries"][name]
    sql = bind((MODULE_DIR / q["sql"]).read_text(), system_params(payload or {}, hub))
    sql = sql.rstrip().rstrip(";")
    out = psql(
        [
            "-tA",
            "-c",
            f"SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM ({sql}) t",
        ],
        db=DB,
    )
    return json.loads(out.strip() or "[]")


# ── Manifest ─────────────────────────────────────────────────────────────────────────────


def check_manifest() -> None:
    schema = json.loads((MODULE_DIR / "schemas" / "settings_update.json").read_text())
    prop = schema.get("properties", {}).get(SETTING)
    if not prop:
        fail(
            f"schemas/settings_update.json has no `{SETTING}` — the blind count cannot be turned on"
        )
    elif prop.get("type") != "boolean":
        fail(f"`{SETTING}` must be a boolean toggle, got {prop.get('type')!r}")
    else:
        ok(f"settings schema declares `{SETTING}`")
    if SETTING not in schema.get("required", []):
        fail(
            f"`{SETTING}` must be in `required` — the UI sends the full snapshot (upsert)"
        )

    if PERMISSION not in MANIFEST.get("permissions", []):
        fail(f"permission `{PERMISSION}` is not declared")
    else:
        ok(f"permission `{PERMISSION}` declared")

    for role in ("employee", "cashier"):
        grants = MANIFEST.get("role_permissions", {}).get(role, [])
        if PERMISSION in grants or "*" in grants:
            fail(
                f"role `{role}` is granted `{PERMISSION}` — the count would not be blind for the person counting"
            )
        else:
            ok(f"role `{role}` does NOT get `{PERMISSION}`")
    manager = MANIFEST.get("role_permissions", {}).get("manager", [])
    if PERMISSION not in manager and "*" not in manager:
        fail(f"role `manager` should be able to see expected totals (`{PERMISSION}`)")

    widget = MANIFEST.get("widgets", {}).get(WIDGET)
    if not widget:
        fail(f"widget `{WIDGET}` missing")
    else:
        if widget.get("permission") != PERMISSION:
            fail(
                f"widget `{WIDGET}` must require `{PERMISSION}`, got {widget.get('permission')!r}"
            )
        else:
            ok(f"widget `{WIDGET}` requires `{PERMISSION}`")
        wq = MANIFEST.get("queries", {}).get(widget.get("query", ""), {})
        if wq.get("permission") != PERMISSION:
            fail(
                f"the widget's query `{widget.get('query')}` must require `{PERMISSION}` too — "
                "the query is the second door (a direct call bypasses the widget)"
            )
        else:
            ok("the widget's query requires the same permission (second door closed)")

    guard = [
        p for p in MANIFEST.get("protects", []) if p.get("guard_query") == GUARD_QUERY
    ]
    if not guard:
        fail(
            f"the POS guard must keep using `{GUARD_QUERY}` (a till user must still be able to prove the drawer is open)"
        )
    if (
        MANIFEST["queries"].get(GUARD_QUERY, {}).get("permission")
        != "cash_register.view_session"
    ):
        fail(
            f"`{GUARD_QUERY}` must stay readable with `cash_register.view_session` (it is the POS guard)"
        )

    for lang in ("en", "es"):
        ui = json.loads((MODULE_DIR / "locales" / f"{lang}.json").read_text()).get(
            "ui", {}
        )
        if not ui.get("toggleRequireBlindCount"):
            fail(f"locales/{lang}.json: ui.toggleRequireBlindCount missing")


# ── Real Postgres ────────────────────────────────────────────────────────────────────────


def settings_payload(**overrides) -> dict:
    base = {
        "enable_cash_register": True,
        "require_opening_balance": False,
        "require_closing_balance": True,
        "allow_negative_balance": False,
        "protected_pos_url": "/m/sales/pos/",
        SETTING: False,
    }
    base.update(overrides)
    return base


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
        ok("migrations apply on a clean Postgres")

        # No settings row yet (fresh hub): the guard query behaves as today.
        run_command(
            "cash_register.session.open",
            {"opening_balance": 10000, "session_number": "S-1"},
        )
        sid = run_query(GUARD_QUERY)[0]["id"]
        run_command(
            "cash_register.movement.add",
            {
                "session_id": sid,
                "movement_type": "sale",
                "amount": 2500,
                "payment_method": "cash",
                "sale_reference": "T-1",
                "description": "",
            },
        )
        rows = run_query(GUARD_QUERY)
        if len(rows) != 1 or rows[0].get("expected_total") != 12500:
            fail(
                f"without a settings row, current_session must return expected_total=12500 (status quo), got {rows}"
            )
        else:
            ok("no settings row → current_session shows expected_total (status quo)")

        # Setting OFF explicitly: same.
        run_command("cash_register.settings.update", settings_payload())
        settings = run_query("cash_register.settings.get")
        if not settings or settings[0].get(SETTING) != 0:
            fail(
                f"settings.get must expose `{SETTING}` (0 after saving it off), got {settings}"
            )
        rows = run_query(GUARD_QUERY)
        if rows[0].get("expected_total") != 12500:
            fail(
                f"{SETTING}=0 → current_session must still show expected_total, got {rows}"
            )
        else:
            ok(f"{SETTING}=0 → current_session shows expected_total")

        # Setting ON: the guard still proves the drawer is open, but says nothing about the amount.
        run_command(
            "cash_register.settings.update", settings_payload(**{SETTING: True})
        )
        settings = run_query("cash_register.settings.get")
        if not settings or settings[0].get(SETTING) != 1:
            fail(f"settings.update must persist `{SETTING}` = 1, got {settings}")
        else:
            ok(f"settings.update persists `{SETTING}`")
        rows = run_query(GUARD_QUERY)
        if len(rows) != 1 or rows[0].get("id") != sid:
            fail(
                f"{SETTING}=1 → current_session must still return the open session (POS guard), got {rows}"
            )
        elif rows[0].get("expected_total") is not None:
            fail(
                f"{SETTING}=1 → current_session LEAKS expected_total={rows[0].get('expected_total')}"
            )
        else:
            ok(
                f"{SETTING}=1 → current_session returns the session WITHOUT expected_total"
            )

        sup = run_query(EXPECTED_QUERY)
        if len(sup) != 1 or sup[0].get("expected_total") != 12500:
            fail(
                f"{EXPECTED_QUERY} (supervisor permission) must return expected_total=12500 even when blind, got {sup}"
            )
        else:
            ok(f"{EXPECTED_QUERY} still returns expected_total for supervisors")

        # Declaring the count reveals (and audits) the difference on the row itself.
        run_command(
            "cash_register.session.close",
            {"session_id": sid, "closing_balance": 12000, "closing_notes": ""},
        )
        row = json.loads(
            psql(
                [
                    "-tA",
                    "-c",
                    f"SELECT row_to_json(s) FROM cash_register_session s WHERE id = '{sid}'",
                ],
                db=DB,
            ).strip()
        )
        if row.get("expected_balance") != 12500 or row.get("difference") != -500:
            fail(
                f"after the count the row must carry expected=12500 / difference=-500 (audit), got {row}"
            )
        else:
            ok(
                "the count declared → expected/difference stored on the session (audited, revealed after)"
            )
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'])


def main() -> int:
    print("[blind count] manifest")
    check_manifest()
    print("[blind count] real Postgres")
    check_against_postgres()
    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print(
        "\nOK — blind count enforceable on the server, expected totals are a supervisor number"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
