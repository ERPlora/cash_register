#!/usr/bin/env python3
"""`cash_register.live_cash_for_sale` answers how much cash a sale still has alive (cash_register#80).

The `reverse_sale` handler used to refuse EVERY void with no open drawer, even for a sale that never
put a cent in the till (paid entirely by card, or already refunded in full in cash): the event fell
to the outbox dead-letter with an "open the till" message the drawer never needed. This query is the
new READ (`context.reads`, ADR-0069) that lets the handler tell the two cases apart BEFORE deciding
whether the missing session even matters — it mirrors the `live` CTE
`commands/_reverse_movement_for_open_session.sql` computes at write time, so what this battery pins
is that the two agree.

Usage: tests/live_cash_for_sale.postgres.test.py   (exit 0 = green)
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
DB = f"cash_register_live_cash_test_{os.getpid()}"
HUB = "hub-a"
NEIGHBOUR = "hub-next-door"
USER = "u-cashier"

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


def run_query(name: str, payload: dict | None = None, hub: str = HUB) -> list[dict]:
    q = MANIFEST["queries"][name]
    sql = (
        bind((MODULE_DIR / q["sql"]).read_text(), sys_params(payload or {}, hub))
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


def live_cash(sale_id: str, hub: str = HUB) -> int:
    rows = run_query("cash_register.live_cash_for_sale", {"sale_id": sale_id}, hub)
    return rows[0]["amount"]


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


def book_sale(
    amount: int, sale_id: str, when: str, method_type: str = "cash", hub: str = HUB
) -> None:
    """One sale leg, through the door `record_sale` emits."""
    run_sql_command(
        "cash_register._movement_for_open_session",
        {
            "movement_id": str(uuid.uuid4()),
            "movement_type": "sale",
            "amount": amount,
            "gift_total": 0,
            "payment_method": method_type,
            "payment_method_type": method_type,
            "sale_reference": sale_id,
            "description": f"Sale {sale_id}",
            "now": when,
        },
        hub,
    )


def book_refund(sale_id: str, amount: int, ref: str, when: str, hub: str = HUB) -> None:
    """One CASH refund leg, through the door `_record_refund` emits (cash_register#62)."""
    run_sql_command(
        "cash_register._refund_movement_for_open_session",
        {
            "movement_id": str(uuid.uuid4()),
            "amount": amount,
            "payment_method": "Efectivo",
            "payment_method_type": "cash",
            "sale_reference": sale_id,
            "refund_reference": ref,
            "source_payment_id": f"pay-{ref}",
            "description": f"Refund {ref} · sale {sale_id}",
            "now": when,
        },
        hub,
    )


def run_cases() -> None:
    session = str(uuid.uuid4())
    open_session(session, "2026-09-03T08:00:00+00:00")

    print("\n1 · a cash sale with nothing refunded is fully live")
    book_sale(10000, "sale-cash", "2026-09-03T09:00:00+00:00")
    check("the whole 100,00 € is live", live_cash("sale-cash"), 10000)

    print("\n2 · a partial cash refund shrinks the live amount, once")
    book_refund("sale-cash", 3000, "refund-live-1", "2026-09-03T09:30:00+00:00")
    check("only what is left is live", live_cash("sale-cash"), 7000)

    print("\n3 · a sale refunded in full in cash leaves nothing live")
    book_refund("sale-cash", 7000, "refund-live-2", "2026-09-03T09:45:00+00:00")
    check("fully refunded, floored at zero", live_cash("sale-cash"), 0)

    print("\n4 · a card sale never has anything live to reverse")
    book_sale(5000, "sale-card", "2026-09-03T10:00:00+00:00", method_type="card")
    check(
        "card never touches the drawer, so nothing is live", live_cash("sale-card"), 0
    )

    print("\n5 · a sale reference nobody sold is live-zero, not an error")
    check("no such sale, no live cash", live_cash("sale-never-existed"), 0)

    print("\n6 · the hub next door keeps its own sale under the same reference")
    session_n = str(uuid.uuid4())
    open_session(session_n, "2026-09-03T08:00:00+00:00", NEIGHBOUR)
    book_sale(4000, "sale-cash", "2026-09-03T10:00:00+00:00", hub=NEIGHBOUR)
    check(
        "our sale's live amount is untouched by the neighbour's",
        live_cash("sale-cash"),
        0,
    )
    check("the neighbour sees only their own", live_cash("sale-cash", NEIGHBOUR), 4000)


def main() -> int:
    print(f"[live-cash-for-sale] real Postgres · container {CONTAINER}")
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
    print("✓ live_cash_for_sale agrees with the write-time `live` CTE it mirrors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
