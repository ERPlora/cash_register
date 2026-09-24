#!/usr/bin/env python3
"""The shift detail splits its sales by TENDER (cash_register#91).

The detail of a shift said «Cash sales 94,90 €» for a shift with 43,00 € in cash and 51,90 € by
card: `session.summary` returned a single `total_sales` that summed every `sale` movement whatever
its `payment_method_type`, and the screen labelled it «cash». The owner reading it believed 51,90 €
were missing from the drawer. The market's X/Z report (Square, Toast, Lightspeed, Odoo) lists the
sales per tender, and the cash line is what is counted in the drawer.

What this file proves, against a REAL Postgres built from the module's own migrations:

  a. `session.summary` and its ungagged twin `session.summary.expected` answer `cash_sales`,
     `card_sales` and `other_sales` (transfer + other) next to the unchanged `total_sales`.
  b. In a blind-count hub an OPEN session answers the split as NULL through the gagged door
     (cash_register#84: cash sales + opening + in − out − refunds IS the expected), while the twin
     (supervisors) and a CLOSED session keep it.
  c. en/es labels exist for the three lines, and the es text is Spanish.

Usage: tests/sales_by_tender.postgres.test.py   (exit 0 = green)
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
DB = f"cash_register_sales_by_tender_test_{os.getpid()}"
HUB = "hub-a"
SPLIT = ("cash_sales", "card_sales", "other_sales")
LABELS = ("detailSales", "detailCashSales", "detailCardSales", "detailOtherSales")

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


def run_query(name: str, payload: dict) -> list[dict]:
    q = MANIFEST["queries"][name]
    p = dict(payload)
    p.setdefault("hub_id", HUB)
    sql = bind((MODULE_DIR / q["sql"]).read_text(), p).rstrip().rstrip(";")
    out = psql(
        [
            "-tA",
            "-c",
            f"SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM ({sql}) t",
        ],
        db=DB,
    )
    return json.loads(out.strip() or "[]")


def check_locales() -> None:
    en = json.loads((MODULE_DIR / "locales" / "en.json").read_text())["ui"]
    es = json.loads((MODULE_DIR / "locales" / "es.json").read_text())["ui"]
    missing = [
        f"{lang}:{k}"
        for lang, cat in (("en", en), ("es", es))
        for k in LABELS
        if not cat.get(k)
    ]
    same = [k for k in LABELS if en.get(k) and en.get(k) == es.get(k)]
    if missing:
        fail(f"labels missing: {missing}")
    elif same:
        fail(f"locales/es.json still English for {same}")
    else:
        ok("the per-tender lines are labelled in en and es")


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
        sid = str(uuid.uuid4())
        psql(
            [
                "-c",
                "INSERT INTO cash_register_session (id, hub_id, user_id, session_number, status, opening_balance,"
                " is_deleted, created_at, updated_at) VALUES"
                f" ('{sid}', '{HUB}', 'u-cashier', 'S-TENDER', 'open', 10000, 0, '2026-09-18T09:00:00+00:00',"
                " '2026-09-18T09:00:00+00:00')",
            ],
            db=DB,
        )

        def movement(
            movement_type: str, amount: int, method_type: str, hub: str = HUB
        ) -> None:
            psql(
                [
                    "-c",
                    "INSERT INTO cash_register_movement (id, hub_id, session_id, movement_type, amount,"
                    " payment_method, payment_method_type, is_deleted, created_at, updated_at) VALUES"
                    f" ('{uuid.uuid4()}', '{hub}', '{sid}', '{movement_type}', {amount}, '{method_type}',"
                    f" '{method_type}', 0, '2026-09-18T10:00:00+00:00', '2026-09-18T10:00:00+00:00')",
                ],
                db=DB,
            )

        # The QA reproduction (43,00 € cash + 51,90 € card), plus a transfer that is neither.
        movement("sale", 4300, "cash")
        movement("sale", 5190, "card")
        movement("sale", 1000, "transfer")
        movement("in", 700, "cash")  # a cash-in is not a sale
        movement("refund", -500, "cash")  # a refund is not a (negative) sale
        movement("sale", 9999, "cash", hub="hub-b")  # another hub's row never counts
        want = {
            "total_sales": 10490,
            "cash_sales": 4300,
            "card_sales": 5190,
            "other_sales": 1000,
        }

        for q in (
            "cash_register.session.summary",
            "cash_register.session.summary.expected",
        ):
            row = run_query(q, {"session_id": sid})[0]
            got = {k: row.get(k) for k in want}
            if got != want:
                fail(f"{q} must split the sales by tender {want}, got {got}")
            else:
                ok(f"{q}: cash 4300 · card 5190 · other 1000 (total 10490 unchanged)")

        # Blind count ON: the gagged door hides the split of an OPEN session, the twin keeps it.
        psql(
            [
                "-c",
                "INSERT INTO cash_register_settings (id, hub_id, require_blind_count) VALUES"
                f" ('{uuid.uuid4()}', '{HUB}', 1)",
            ],
            db=DB,
        )
        row = run_query("cash_register.session.summary", {"session_id": sid})[0]
        leaked = {k: row.get(k) for k in SPLIT if row.get(k) is not None}
        if leaked:
            fail(
                f"blind hub, open session: session.summary LEAKS the cash split {leaked}"
            )
        elif row.get("total_sales") != 10490:
            fail(
                f"blind hub, open session: total_sales must stay 10490, got {row.get('total_sales')}"
            )
        else:
            ok("blind hub, open session: session.summary hides the per-tender split")
        twin = run_query("cash_register.session.summary.expected", {"session_id": sid})[
            0
        ]
        if {k: twin.get(k) for k in SPLIT} != {k: want[k] for k in SPLIT}:
            fail(f"blind hub: the supervisor twin must keep the split, got {twin}")
        else:
            ok("blind hub: the supervisor twin keeps the split")

        psql(
            [
                "-c",
                f"UPDATE cash_register_session SET status = 'closed', expected_balance = 14500,"
                f" closing_balance = 14500, difference = 0 WHERE id = '{sid}'",
            ],
            db=DB,
        )
        row = run_query("cash_register.session.summary", {"session_id": sid})[0]
        if {k: row.get(k) for k in SPLIT} != {k: want[k] for k in SPLIT}:
            fail(f"blind hub, CLOSED session: the split must be shown, got {row}")
        else:
            ok("blind hub, closed session: the split is shown (the count is over)")
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'])


def main() -> int:
    print("[sales by tender] locales")
    check_locales()
    print("[sales by tender] real Postgres")
    check_against_postgres()
    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print("\nOK — the shift detail splits its sales by tender")
    return 0


if __name__ == "__main__":
    sys.exit(main())
