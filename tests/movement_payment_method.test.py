#!/usr/bin/env python3
"""The manual movement says HOW it was paid, and the drawer believes it (cash_register#54).

Two halves of the same operation — what is WRITTEN and what is READ — used different columns:

  1. `commands/add_movement.sql` did not name `payment_method_type` in its INSERT, so the column
     kept the `DEFAULT 'cash'` its migration gave it (`003_payment_method_type.sql`, no backfill).
     A movement registered with `payment_method: "card"` therefore entered the drawer AS CASH:
     opening float 100,00 € + one CARD movement of 50,00 € left `expected_cash` at 150,00 €, money
     the till does not hold. It is cash_register#33 —fixed for the SALE door in
     `_movement_for_open_session.sql`— coming back through the MANUAL door.

  2. The handler's `allow_negative_balance` guard decided "is this cash?" on the LOCALIZED NAME
     while the five readings key on the canonical TYPE. The name of the cash method is translated
     («Efectivo», «Espèces») and never equals `'cash'`, so a hub in Spanish emptied the drawer
     below zero just by naming the method in its own language. That half is decided in pure Rust
     (`handler/src/lib.rs`, `cargo test`) and stated in the manifest by the checks below.

What this file proves, against a REAL Postgres built from the module's own migrations:

  a. The manifest states the contract: `movement.add` constrains `payment_method` to the canonical
     vocabulary (`cash`|`card`|`transfer`|`other`), and the new domain code is translated in en/es.
  b. `add_movement.sql` PERSISTS the type, so a card movement does not inflate the expected cash —
     the issue's own reproduction, number for number.
  c. Migration 008 REPAIRS what the buggy version already wrote: a hub that has been booking card
     movements as cash gets its drawer back on upgrade, instead of dragging the lie for ever
     (`cash_register#48` did the same for the badly signed rows, in the readings).

Usage: tests/movement_payment_method.test.py   (exit 0 = green)
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
DB = f"cash_register_payment_method_test_{os.getpid()}"
HUB = "hub-a"
USER = "u-cashier"

# The canonical vocabulary of the drawer's own door (hub#778). NOT the catalogue of payment methods
# —that one is `sales`', it is localized, and it reaches the drawer through `record_sale` carrying
# the type the catalogue already knows.
TYPES = ["cash", "card", "transfer", "other"]
CODES = {"cash_register.payment_method_unknown": "errPaymentMethodUnknown"}
# The backfill only repairs what it can name: the row written through the manual door, whose
# `payment_method` IS one of the canonical tokens.
BACKFILL_MIGRATION = "migrations/postgres/008_backfill_payment_method_type.sql"

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
    p.setdefault("now", "2026-08-21T10:00:00+00:00")
    p.setdefault("new_id", str(uuid.uuid4()))
    return p


def run_sql_command(name: str, payload: dict) -> None:
    cmd = MANIFEST["commands"][name]
    p = sys_params(payload)
    if name == "cash_register._open_session_insert":
        p.setdefault("day", "20260821")
        p.setdefault("session_day", "260821")
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


# ── a. the manifest states the contract ────────────────────────────────────────────────────────
def check_manifest() -> None:
    cmd = MANIFEST["commands"]["cash_register.movement.add"]
    schema = json.loads((MODULE_DIR / cmd["schema"]).read_text())
    method = schema.get("properties", {}).get("payment_method", {})
    if sorted(method.get("enum", [])) != sorted(TYPES):
        fail(
            f"payment_method must be an enum of the canonical types {TYPES}, got {method.get('enum')}"
            " — a free string is what let «Efectivo» dodge the drawer guard"
        )
    else:
        ok(
            "payment_method is an enum of the canonical types: no localized name reaches the drawer"
        )
    if method.get("default") != "cash":
        fail(f"payment_method must still default to cash, got {method.get('default')}")
    else:
        ok(
            "payment_method still defaults to cash: a caller that says nothing means the drawer"
        )

    en = json.loads((MODULE_DIR / "locales" / "en.json").read_text())["ui"]
    es = json.loads((MODULE_DIR / "locales" / "es.json").read_text())["ui"]
    missing = [
        f"{lang}.{key}"
        for lang, ui in (("en", en), ("es", es))
        for key in CODES.values()
        if not ui.get(key)
    ]
    same = [k for k in CODES.values() if en.get(k) and en.get(k) == es.get(k)]
    if missing:
        fail(f"the domain code has no translation: {missing} ({list(CODES)})")
    elif same:
        fail(f"locales/es.json still English for {same}")
    else:
        ok("the new domain code is translated in en and es")
    # And the screen has to MAP the code to that string, or the person reads a raw error code.
    dashboard = (
        MODULE_DIR
        / "ui/components/erp-cashregister-dashboard"
        / "erp-cashregister-dashboard.ts"
    ).read_text()
    unmapped = [c for c in CODES if c not in dashboard]
    if unmapped:
        fail(
            f"the dashboard does not translate {unmapped}: DOMAIN_MESSAGES has no entry for it"
        )
    else:
        ok("the dashboard maps the code to its translated message")

    if BACKFILL_MIGRATION not in MANIFEST["migrations"]["postgres"]:
        fail(f"{BACKFILL_MIGRATION} is not declared in module.json: it would never run")
    else:
        ok("the backfill migration is declared")


# ── b/c. against a real Postgres ───────────────────────────────────────────────────────────────
def check_against_postgres() -> None:
    if (
        subprocess.run(["docker", "inspect", CONTAINER], capture_output=True).returncode
        != 0
    ):
        fail(f"container `{CONTAINER}` is not running")
        return
    psql(["-c", f'CREATE DATABASE "{DB}"'])
    try:
        # The hub of a customer who has been running the BUGGY version: every migration EXCEPT the
        # repair, so the poisoned rows below are written exactly as they are in their tables today.
        migrations = MANIFEST["migrations"]["postgres"]
        for rel in migrations:
            if rel == BACKFILL_MIGRATION:
                continue
            psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())

        # ── b. the issue's reproduction, number for number ──────────────────────────────────────
        sid = str(uuid.uuid4())
        run_sql_command(
            "cash_register._open_session_insert",
            {
                "session_id": sid,
                "opening_balance": 10000,
                "register_id": None,
                "opening_notes": "",
            },
        )
        # The parameters the handler produces for `{movement_type: "in", amount: 5000,
        # payment_method: "card"}`: the sign is already applied (cash_register#48) and the canonical
        # type travels next to the name (cash_register#54).
        run_sql_command(
            "cash_register._movement_insert",
            {
                "movement_id": str(uuid.uuid4()),
                "session_id": sid,
                "movement_type": "in",
                "amount": 5000,
                "payment_method": "card",
                "payment_method_type": "card",
                "sale_reference": "",
                "description": "card movement",
            },
        )

        row = json.loads(
            psql(
                [
                    "-tA",
                    "-c",
                    "SELECT row_to_json(m) FROM cash_register_movement m"
                    f" WHERE m.session_id = '{sid}'",
                ],
                db=DB,
            ).strip()
        )
        if row["payment_method_type"] != "card":
            fail(
                "add_movement.sql does not persist payment_method_type: the row landed as "
                f"{row['payment_method']} / {row['payment_method_type']} — the INSERT does not name"
                " the column, so it keeps the DEFAULT 'cash' of migration 003"
            )
        else:
            ok("add_movement.sql persists the canonical type of the method")

        s = run_query("cash_register.session.summary", {"session_id": sid})[0]
        if s["expected_cash"] != 10000:
            fail(
                f"expected_cash must be 10000 (the float alone: the 50,00 € went to a CARD, the "
                f"drawer never saw it), got {s['expected_cash']}"
            )
        else:
            ok("a card movement does not inflate the expected cash of the drawer")
        for q in (
            "cash_register.current_session",
            "cash_register.current_session.expected",
        ):
            live = run_query(q)[0]
            if live["expected_total"] != 10000:
                fail(f"{q}.expected_total must be 10000, got {live['expected_total']}")
            else:
                ok(f"{q} agrees: the drawer holds the float and nothing else")

        # A cash movement in the same session still counts, so the fix did not just mute the door.
        run_sql_command(
            "cash_register._movement_insert",
            {
                "movement_id": str(uuid.uuid4()),
                "session_id": sid,
                "movement_type": "in",
                "amount": 2000,
                "payment_method": "cash",
                "payment_method_type": "cash",
                "sale_reference": "",
                "description": "cash in",
            },
        )
        s = run_query("cash_register.session.summary", {"session_id": sid})[0]
        if s["expected_cash"] != 12000:
            fail(
                f"a CASH movement must still reach the drawer: expected 12000, got {s['expected_cash']}"
            )
        else:
            ok("a cash movement still reaches the drawer")

        # ── c. the repair of what the buggy version already wrote ───────────────────────────────
        sid2 = str(uuid.uuid4())
        psql(
            [
                "-c",
                "INSERT INTO cash_register_session (id, hub_id, user_id, session_number, status, opened_at,"
                " opening_balance, opening_notes, is_deleted, created_at, updated_at) VALUES"
                f" ('{sid2}', '{HUB}', '{USER}', 'S-OLD', 'closed', '2026-08-20T08:00:00+00:00', 10000, '', 0,"
                " '2026-08-20T08:00:00+00:00', '2026-08-20T08:00:00+00:00')",
            ],
            db=DB,
        )

        def poisoned(method: str, amount: int = 5000, movement_type: str = "in") -> str:
            """A row exactly as the buggy `add_movement.sql` wrote it: the method the caller sent,
            and the type stuck on the DEFAULT 'cash' the INSERT never overwrote."""
            mid = str(uuid.uuid4())
            psql(
                [
                    "-c",
                    "INSERT INTO cash_register_movement (id, hub_id, session_id, movement_type, amount,"
                    " payment_method, payment_method_type, is_deleted, created_at, updated_at) VALUES"
                    f" ('{mid}', '{HUB}', '{sid2}', '{movement_type}', {amount}, '{method}', 'cash', 0,"
                    " '2026-08-20T09:00:00+00:00', '2026-08-20T09:00:00+00:00')",
                ],
                db=DB,
            )
            return mid

        card, transfer, other = (
            poisoned("card"),
            poisoned("transfer"),
            poisoned("other"),
        )
        upper = poisoned("Card")  # the same token, as the API caller typed it
        cash = poisoned("cash", 3000)  # a real cash movement: must NOT be touched
        localized = poisoned("Tarjeta")  # a name the drawer cannot resolve on its own
        untouched = json.loads(
            psql(
                [
                    "-tA",
                    "-c",
                    "SELECT COALESCE(json_agg(m.payment_method_type), '[]'::json)"
                    f" FROM cash_register_movement m WHERE m.session_id = '{sid2}'",
                ],
                db=DB,
            ).strip()
        )
        if set(untouched) != {"cash"}:
            fail(
                f"the fixture is wrong: the poisoned rows should all read 'cash', got {untouched}"
            )

        psql([], db=DB, stdin=(MODULE_DIR / BACKFILL_MIGRATION).read_text())

        def type_of(mid: str) -> str:
            return psql(
                [
                    "-tA",
                    "-c",
                    "SELECT payment_method_type FROM cash_register_movement"
                    f" WHERE id = '{mid}'",
                ],
                db=DB,
            ).strip()

        for mid, method, want in [
            (card, "card", "card"),
            (transfer, "transfer", "transfer"),
            (other, "other", "other"),
            (upper, "Card", "card"),
            (cash, "cash", "cash"),
        ]:
            got = type_of(mid)
            if got != want:
                fail(
                    f"migration 008 must repair a row written as '{method}' to type '{want}', got '{got}'"
                )
            else:
                ok(f"a movement written as '{method}' now reads type '{want}'")
        if type_of(localized) != "cash":
            fail(
                "migration 008 touched a LOCALIZED name ('Tarjeta'): the drawer cannot resolve the"
                " sales catalogue without a hard dependency on it, so it must leave those alone"
            )
        else:
            ok(
                "a localized name is left alone: guessing it would be the same mistake, backwards"
            )

        # The whole point of repairing: the drawer of that old session stops lying. Before the
        # migration it expected 10000 + 5000 + 5000 + 5000 + 5000 + 3000 + 5000 = 38000, of which
        # only 13000 was ever physical money. After it: 10000 float + 3000 cash + the 5000 of the
        # row written with a LOCALIZED name, the residue the module cannot resolve on its own
        # (and which no longer gets written: that door was fixed in #33).
        old = run_query("cash_register.session.summary", {"session_id": sid2})[0]
        if old["expected_cash"] != 18000:
            fail(
                f"after the repair the old session must expect 18000 (float 10000 + 3000 cash +"
                f" 5000 unresolvable), got {old['expected_cash']}"
            )
        else:
            ok(
                "the arqueo of the sessions already written stops counting card money as cash"
            )

        # And running it twice changes nothing: a migration re-applied by hand must be harmless.
        psql([], db=DB, stdin=(MODULE_DIR / BACKFILL_MIGRATION).read_text())
        again = run_query("cash_register.session.summary", {"session_id": sid2})[0]
        if again["expected_cash"] != 18000:
            fail(
                f"the backfill is not idempotent: second run left {again['expected_cash']}"
            )
        else:
            ok("the backfill is idempotent")
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'])


def main() -> int:
    print("[payment method] manifest")
    check_manifest()
    print("[payment method] real Postgres")
    check_against_postgres()
    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print(
        "\nOK — the drawer counts the money it holds, and the guard keys on the type, not the language"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
