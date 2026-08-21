#!/usr/bin/env python3
"""The drawer settings are enforced on the SERVER (cash_register#38).

`require_opening_balance` / `require_closing_balance` / `allow_negative_balance` were looked at by
the UI only: by API, or from an old UI, one could open without a float, close without a count or
take out more cash than the drawer holds. A declarative SQL command has ONE `expect_rows` gate, so
"already open" and "float missing" would share a code; the rules moved to a WASM handler that reads
the trusted settings row the host preloads (`reads`, ADR-0069) and answers ONE domain code per cause:

    cash_register.opening_balance_required · cash_register.closing_balance_required ·
    cash_register.negative_balance_not_allowed   (+ session_already_open / session_unavailable kept)

The decisions themselves are pure Rust and are proven by `handler/src/lib.rs` tests (`cargo test`).
What this file proves, against the manifest and a REAL Postgres built from the module's migrations,
is that the handler is wired to REAL inputs and REAL writes:

  1. Manifest: the three public commands are WASM handlers, each declares the `reads` its rule
     needs (settings row; the payload's session with `expected_cash` for movements; the open session
     for opens), all required; every code is translated in en/es; the internal SQL commands exist.
  2. Postgres: `settings.get` returns the three flags exactly as saved; `session.summary` (the read
     the movement rule uses) returns `expected_cash` = opening + Σ cash movements, ignoring card;
     the internal SQL commands write what the handler hands over (ids from `new_ids`).

Usage: tests/settings_enforced.test.py   (exit 0 = green)
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
DB = f"cash_register_settings_enforced_test_{os.getpid()}"
HUB = "hub-a"
USER = "u-cashier"

RULES = {
    "cash_register.session.open": (
        "open_session",
        ["cash_register.settings.get", "cash_register.current_session"],
        "cash_register._open_session_insert",
    ),
    "cash_register.session.close": (
        "close_session",
        ["cash_register.settings.get"],
        "cash_register._close_session_apply",
    ),
    "cash_register.movement.add": (
        "add_movement",
        ["cash_register.settings.get", "cash_register.session.summary"],
        "cash_register._movement_insert",
    ),
}
CODES = {
    "cash_register.opening_balance_required": "errOpeningBalanceRequired",
    "cash_register.closing_balance_required": "errClosingBalanceRequired",
    "cash_register.negative_balance_not_allowed": "errNegativeBalanceNotAllowed",
    "cash_register.session_already_open": "errSessionAlreadyOpen",
    "cash_register.session_unavailable": "errSessionUnavailable",
}

failures: list[str] = []


def fail(m: str) -> None:
    failures.append(m)
    print(f"  FAIL: {m}")


def ok(m: str) -> None:
    print(f"  ok: {m}")


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


def sys_params(payload: dict) -> dict:
    p = dict(payload)
    p.setdefault("hub_id", HUB)
    p.setdefault("current_user_id", USER)
    p.setdefault("now", "2026-08-18T10:00:00+00:00")
    p.setdefault("new_id", str(uuid.uuid4()))
    return p


def run_sql_command(name: str, payload: dict) -> None:
    cmd = MANIFEST["commands"][name]
    p = sys_params(payload)
    # cash_register#49: the shift number is minted by an atomic per-(hub, day) counter that the
    # open bumps in the SAME transaction, so the insert has something to read back. Without it the
    # session would simply not be written.
    if name == "cash_register._open_session_insert":
        p.setdefault("day", "20260818")
        p.setdefault("session_day", "260818")
        cmd = {"sql": MANIFEST["commands"]["cash_register._bump_counter"]["sql"] + cmd["sql"]}
    psql(
        [],
        db=DB,
        stdin="\n".join(
            ["BEGIN;"]
            + [bind((MODULE_DIR / r).read_text(), p) for r in cmd["sql"]]
            + ["COMMIT;"]
        ),
    )


def run_query(name: str, payload: dict | None = None) -> list[dict]:
    q = MANIFEST["queries"][name]
    sql = (
        bind((MODULE_DIR / q["sql"]).read_text(), sys_params(payload or {}))
        .rstrip()
        .rstrip(";")
    )
    out = psql(
        [
            "-tA",
            "-c",
            f"SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM ({sql}) t",
        ],
        db=DB,
    )
    return json.loads(out.strip() or "[]")


def check_manifest() -> None:
    for name, (function, reads, internal) in RULES.items():
        cmd = MANIFEST["commands"].get(name, {})
        h = cmd.get("handler") or {}
        if h.get("type") != "wasm" or h.get("function") != function:
            fail(f"{name} must be a WASM handler `{function}`, got {h}")
            continue
        declared = {
            (r.get("query") if isinstance(r, dict) else r): r
            for r in cmd.get("reads", [])
        }
        for q in reads:
            if q not in declared:
                fail(
                    f"{name} must declare read `{q}` — the rule has no trusted input without it"
                )
            elif isinstance(declared[q], dict) and not declared[q].get("required"):
                fail(
                    f"{name}: read `{q}` must be required (a failed read aborts instead of degrading)"
                )
        if (
            name == "cash_register.movement.add"
            and declared.get("cash_register.session.summary", {})
            .get("params", {})
            .get("session_id")
            != "payload.session_id"
        ):
            fail(
                "movement.add must preload the PAYLOAD's session (params.session_id = payload.session_id)"
            )
        if internal not in MANIFEST["commands"] or not MANIFEST["commands"][
            internal
        ].get("sql"):
            fail(
                f"{name} resolves to `{internal}`, which must be an internal SQL command"
            )
        if "expect_rows" in cmd:
            fail(
                f"{name}: `expect_rows` is not applied on the handler path — the rule must live in the handler"
            )
        ok(f"{name} → wasm `{function}`, reads {reads}, writes via `{internal}`")
    for lang in ("en", "es"):
        ui = json.loads((MODULE_DIR / "locales" / f"{lang}.json").read_text()).get(
            "ui", {}
        )
        for code, key in CODES.items():
            if not ui.get(key):
                fail(f"locales/{lang}.json: ui.{key} missing (translation of {code})")
    en = json.loads((MODULE_DIR / "locales" / "en.json").read_text())["ui"]
    es = json.loads((MODULE_DIR / "locales" / "es.json").read_text())["ui"]
    same = [k for k in CODES.values() if en.get(k) and en.get(k) == es.get(k)]
    if same:
        fail(f"locales/es.json still English for {same}")
    else:
        ok("every domain code is translated in en and es")


def check_against_postgres() -> None:
    if (
        subprocess.run(["docker", "inspect", CONTAINER], capture_output=True).returncode
        != 0
    ):
        fail(f"container `{CONTAINER}` is not running")
        return
    psql(["-c", f'CREATE DATABASE "{DB}"'])
    try:
        for rel in MANIFEST["migrations"]["postgres"]:
            psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
        run_sql_command(
            "cash_register.settings.update",
            {
                "enable_cash_register": True,
                "require_opening_balance": True,
                "require_closing_balance": True,
                "allow_negative_balance": False,
                "require_blind_count": False,
                "auto_close_enabled": False,
                "auto_close_time": "04:00",
                "protected_pos_url": "/m/sales/pos/",
            },
        )
        row = run_query("cash_register.settings.get")[0]
        if (
            row["require_opening_balance"],
            row["require_closing_balance"],
            row["allow_negative_balance"],
        ) != (1, 1, 0):
            fail(f"settings.get must return the three flags as saved, got {row}")
        else:
            ok("settings.get returns the three flags the handler reads")

        sid = str(uuid.uuid4())
        run_sql_command(
            "cash_register._open_session_insert",
            {
                "session_id": sid,
                "opening_balance": 10000,
                "session_number": "S-1",
                "register_id": None,
                "opening_notes": "",
            },
        )
        run_sql_command(
            "cash_register._movement_insert",
            {
                "movement_id": str(uuid.uuid4()),
                "session_id": sid,
                "movement_type": "sale",
                "amount": 2500,
                "payment_method": "cash",
                "sale_reference": "T1",
                "description": "",
            },
        )
        run_sql_command(
            "cash_register._movement_insert",
            {
                "movement_id": str(uuid.uuid4()),
                "session_id": sid,
                "movement_type": "out",
                "amount": -1000,
                "payment_method": "cash",
                "sale_reference": "",
                "description": "supplier",
            },
        )
        psql(
            [
                "-c",
                f"INSERT INTO cash_register_movement (id, hub_id, session_id, movement_type, amount, payment_method, payment_method_type, is_deleted) VALUES ('card', '{HUB}', '{sid}', 'sale', 9999, 'Tarjeta', 'card', 0)",
            ],
            db=DB,
        )
        summary = run_query("cash_register.session.summary", {"session_id": sid})
        if not summary or summary[0].get("expected_cash") != 11500:
            fail(
                f"session.summary.expected_cash must be 10000 + 2500 - 1000 = 11500 (card ignored), got {summary}"
            )
        else:
            ok(
                "session.summary carries expected_cash (the number the negative-balance rule uses)"
            )
        if run_query("cash_register.session.summary", {"session_id": "ghost"}):
            fail(
                "session.summary must return no row for an unknown session (the handler refuses on empty)"
            )
        else:
            ok(
                "an unknown session preloads as empty → handler refuses with session_unavailable"
            )
        run_sql_command(
            "cash_register._close_session_apply",
            {"session_id": sid, "closing_balance": 11000, "closing_notes": ""},
        )
        closed = json.loads(
            psql(
                [
                    "-tA",
                    "-c",
                    f"SELECT row_to_json(s) FROM cash_register_session s WHERE id = '{sid}'",
                ],
                db=DB,
            ).strip()
        )
        if (
            closed["status"] != "closed"
            or closed["expected_balance"] != 11500
            or closed["difference"] != -500
        ):
            fail(
                f"_close_session_apply must reconcile like before (expected 11500, difference -500), got {closed}"
            )
        else:
            ok("_close_session_apply reconciles exactly as the old session.close did")
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'])


def main() -> int:
    print("[settings enforced] manifest")
    check_manifest()
    print("[settings enforced] real Postgres")
    check_against_postgres()
    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print("\nOK — the drawer settings are enforced on the server, one code per cause")
    return 0


if __name__ == "__main__":
    sys.exit(main())
