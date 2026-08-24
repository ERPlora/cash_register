#!/usr/bin/env python3
"""Mixed payment — one movement per TENDER, and the count that follows (cash_register#59).

ADR-0386 says a sale can be charged with N means of payment and `sale.completed` carries
`payments[]`. It also says the drawer needs no schema change, and that is true for what the drawer
READS: `queries/session_summary.sql` sums only the `cash` movements, `commands/_reverse_sale.sql`
reverses their `SUM`. It was NOT true for what the drawer WRITES: `record_sale` booked ONE movement
for the whole total, typed after the PRINCIPAL leg.

The issue's own reproduction, number for number: 121,00 € charged as 50,00 € on a card and
71,00 € in cash (90,00 € handed over, 19,00 € of change).

  Before: one movement of 121,00 € typed `cash`  → the drawer expects 121,00 € and holds 71,00 €.
  After:  two movements, 50,00 € `card` + 71,00 € `cash` → the drawer expects 71,00 €.

The count came out 50,00 € short on every mixed sale, silently, and with the card as the principal
leg it came out long instead. That is why this battery books the OLD shape first and asserts it
reads 121,00 €: a check that cannot show the bug is not a check. Only then does it book the new
shape and assert 71,00 €.

WHAT THIS FILE PROVES, and what it does not:

  - it proves the drawer's SQL — the insert door, the count, the reversal, the tenancy filter —
    behaves correctly over N movements for one sale, against a REAL Postgres built from this
    module's own migrations;
  - it does NOT decide the split. That is pure Rust in `handler/src/lib.rs::record_sale_pure`, and
    it is pinned by `cargo test` there (`a_mixed_sale_puts_only_its_cash_leg_in_the_drawer`,
    `a_mixed_sale_books_one_movement_per_leg_with_its_own_type`,
    `an_event_without_payments_keeps_todays_behaviour_exactly`). The module gate does not compile
    the handler — it says so out loud rather than pretending — so this file runs `cargo test` when
    a toolchain is at hand and reports it as NOT RUN when there is none. It never reports it as
    passed.

The parameter sets below are the ones `record_sale_pure` emits for the event in `MIXED_SALE`; the
Rust tests named above are what keeps the two halves from drifting.

Usage: tests/mixed_payment_arqueo.postgres.test.py   (exit 0 = green)
  Uses the `erplora-test-pg-5433` container by default (override:
  CASH_REGISTER_TEST_PG_CONTAINER; the toolkit sets it per CI job). Creates a scratch database and
  DROPS it at the end, pass or fail. It NEVER skips itself: a battery that goes green because it
  could not reach Postgres is worse than no battery at all.
"""

import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import uuid

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text())
CONTAINER = os.environ.get("CASH_REGISTER_TEST_PG_CONTAINER", "erplora-test-pg-5433")
DB = f"cash_register_mixed_payment_test_{os.getpid()}"
HUB = "hub-a"
NEIGHBOUR = "hub-next-door"
USER = "u-cashier"
SALE = "sale-mixed"

# The event `sales` v2.16.1 emits for the issue's sale (ADR-0386). `amount` is what each leg
# COVERED; the 19,00 € of change left the drawer out of the cash leg, so it is not drawer money.
MIXED_SALE = {
    "sale_id": SALE,
    "total": 12100,
    "payment_method_type": "cash",  # the PRINCIPAL leg: 71 > 50. This scalar is what misled the till.
    "payment_method_name": "Efectivo",
    "payments": [
        {"payment_method_name": "Tarjeta", "payment_method_type": "card", "amount": 5000},
        {
            "payment_method_name": "Efectivo",
            "payment_method_type": "cash",
            "amount": 7100,
            "amount_tendered": 9000,
            "change_due": 1900,
        },
    ],
}
OPENING_FLOAT = 10000
CODES = {"cash_register.not_enough_ids": "errNotEnoughIds"}

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


# ── Postgres plumbing (same shape as tests/movement_payment_method.test.py) ─────────────────────


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
    p.setdefault("now", "2026-08-24T10:00:00+00:00")
    p.setdefault("new_id", str(uuid.uuid4()))
    return p


def run_sql_command(name: str, payload: dict, hub: str = HUB) -> None:
    cmd = MANIFEST["commands"][name]
    p = sys_params(payload, hub)
    if name == "cash_register._open_session_insert":
        p.setdefault("day", "20260824")
        p.setdefault("session_day", "260824")
        cmd = {"sql": MANIFEST["commands"]["cash_register._bump_counter"]["sql"] + cmd["sql"]}
    psql(
        [],
        db=DB,
        stdin="\n".join(
            ["BEGIN;"] + [bind((MODULE_DIR / r).read_text(), p) for r in cmd["sql"]] + ["COMMIT;"]
        ),
    )


def run_query(name: str, payload: dict | None = None, hub: str = HUB) -> list[dict]:
    q = MANIFEST["queries"][name]
    sql = bind((MODULE_DIR / q["sql"]).read_text(), sys_params(payload or {}, hub)).rstrip().rstrip(";")
    out = psql(
        ["-tA", "-c", f"SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM ({sql}) t"],
        db=DB,
    )
    return json.loads(out.strip() or "[]")


def open_session(hub: str = HUB) -> str:
    sid = str(uuid.uuid4())
    run_sql_command(
        "cash_register._open_session_insert",
        {
            "session_id": sid,
            "opening_balance": OPENING_FLOAT,
            "register_id": None,
            "opening_notes": "",
        },
        hub,
    )
    return sid


def book(leg: dict, sale_id: str = SALE, gift_total: int = 0, hub: str = HUB) -> None:
    """One movement through the door `record_sale` emits — `_movement_for_open_session`."""
    run_sql_command(
        "cash_register._movement_for_open_session",
        {
            "movement_id": str(uuid.uuid4()),
            "movement_type": "sale",
            "amount": leg["amount"],
            "gift_total": gift_total,
            "payment_method": leg["payment_method_name"],
            "payment_method_type": leg["payment_method_type"],
            "sale_reference": sale_id,
            "description": f"Sale {sale_id}",
        },
        hub,
    )


def expected_cash(session_id: str, hub: str = HUB) -> int:
    return run_query("cash_register.session.summary", {"session_id": session_id}, hub)[0][
        "expected_cash"
    ]


# ── the manifest half ──────────────────────────────────────────────────────────────────────────


def check_manifest() -> None:
    # The event payload IS the contract of a listener, and this listener's payload decides money.
    # It is only trustworthy while the runtime is the ONLY thing that can invoke it: `internal:
    # true` closes `POST /api/command`, the public API key surface, the assistant and the flow
    # engine, which would otherwise reach `record_sale` with a forged `payments[]` and post any
    # amount into the drawer, skipping every guard `movement.add` enforces.
    cmd = MANIFEST["commands"]["cash_register.record_sale"]
    if not cmd.get("internal"):
        fail(
            "cash_register.record_sale must be `internal: true`: its last segment has no `_`, so"
            " without the flag an external caller with `add_movement` posts a drawer movement of"
            " any amount and any type through it"
        )
    else:
        ok("record_sale is internal: only the runtime's event relay can invoke it")
    if "ai" in cmd:
        fail("an internal command must not advertise an `ai` block: the assistant would be offered"
             " a tool the dispatcher always refuses")
    else:
        ok("record_sale offers the assistant no tool it cannot call")

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


# ── the Postgres half ──────────────────────────────────────────────────────────────────────────


def check_against_postgres() -> None:
    if subprocess.run(["docker", "inspect", CONTAINER], capture_output=True).returncode != 0:
        fail(f"container `{CONTAINER}` is not running")
        return
    psql(["-c", f'CREATE DATABASE "{DB}"'])
    try:
        for rel in MANIFEST["migrations"]["postgres"]:
            psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())

        # ── 0. POSITIVE CONTROL: the bug, as the drawer used to book it ─────────────────────────
        # One movement for the whole total, typed after the principal leg. If this does not read
        # 121,00 €, the assertion below cannot be trusted to have caught anything.
        broken = open_session()
        book(
            {"amount": 12100, "payment_method_name": "Efectivo", "payment_method_type": "cash"},
            sale_id="sale-as-it-used-to-be-booked",
        )
        check(
            "positive control: the old single-movement shape DOES inflate the drawer",
            expected_cash(broken),
            OPENING_FLOAT + 12100,
        )
        run_sql_command("cash_register._close_session_apply", {"session_id": broken, "closing_balance": 0, "expected_balance": 0, "difference": 0, "closing_notes": ""})

        # ── 1. the fix: one movement per leg ────────────────────────────────────────────────────
        sid = open_session()
        for leg in MIXED_SALE["payments"]:
            book(leg)

        rows = json.loads(
            psql(
                [
                    "-tA",
                    "-c",
                    "SELECT COALESCE(json_agg(json_build_object('amount', m.amount, 'type',"
                    " m.payment_method_type, 'method', m.payment_method) ORDER BY m.amount), '[]'::json)"
                    f" FROM cash_register_movement m WHERE m.session_id = '{sid}'",
                ],
                db=DB,
            ).strip()
        )
        check("the mixed sale books one movement per leg", len(rows), 2)
        check(
            "each leg carries its own amount and canonical type",
            rows,
            [
                {"amount": 5000, "type": "card", "method": "Tarjeta"},
                {"amount": 7100, "type": "cash", "method": "Efectivo"},
            ],
        )
        check(
            "the legs still add up to the sale, to the cent",
            sum(r["amount"] for r in rows),
            MIXED_SALE["total"],
        )

        # 🔴 THE issue: 71,00 €, never 121,00 € and never 0.
        check(
            "the drawer expects the float plus the CASH leg only",
            expected_cash(sid),
            OPENING_FLOAT + 7100,
        )
        for q in ("cash_register.current_session", "cash_register.current_session.expected"):
            check(f"{q} agrees", run_query(q)[0]["expected_total"], OPENING_FLOAT + 7100)

        # The sale total is still the sale total: the count reports 121,00 € sold, of which only
        # 71,00 € is drawer money. Losing that would trade one wrong number for another.
        summary = run_query("cash_register.session.summary", {"session_id": sid})[0]
        check("the session still reports the whole sale as sold", summary["total_sales"], 12100)
        check("both legs are listed as movements", summary["movement_count"], 2)

        # ── 2. TENANCY, with a LIVE neighbour ───────────────────────────────────────────────────
        # The same sale id, in another hub, through the same enforcing door. A scoping check with
        # no neighbour proves nothing.
        neighbour = open_session(NEIGHBOUR)
        for leg in MIXED_SALE["payments"]:
            book(leg, hub=NEIGHBOUR)
        check(
            "the neighbour's legs never reach this hub's drawer",
            expected_cash(sid),
            OPENING_FLOAT + 7100,
        )
        check(
            "and this hub's legs never reach the neighbour's",
            expected_cash(neighbour, NEIGHBOUR),
            OPENING_FLOAT + 7100,
        )

        # ── 3. voiding a mixed sale reverses the CASH legs, and only those ──────────────────────
        run_sql_command("cash_register._reverse_sale", {"sale_id": SALE})
        reversal = json.loads(
            psql(
                [
                    "-tA",
                    "-c",
                    "SELECT COALESCE(json_agg(json_build_object('amount', m.amount, 'type',"
                    " m.payment_method_type)), '[]'::json) FROM cash_register_movement m"
                    f" WHERE m.session_id = '{sid}' AND m.movement_type = 'refund'",
                ],
                db=DB,
            ).strip()
        )
        check("one compensating movement, not one per leg", len(reversal), 1)
        check(
            "it reverses the 71,00 € of cash, never the 121,00 € of the sale",
            reversal,
            [{"amount": -7100, "type": "cash"}],
        )
        check("the drawer is back to the float alone", expected_cash(sid), OPENING_FLOAT)
        check(
            "the neighbour's drawer was not touched by this hub's void",
            expected_cash(neighbour, NEIGHBOUR),
            OPENING_FLOAT + 7100,
        )

        # Re-delivering the void changes nothing (defence in depth over `_event_delivery`).
        run_sql_command("cash_register._reverse_sale", {"sale_id": SALE})
        check("the reversal is idempotent over N legs", expected_cash(sid), OPENING_FLOAT)

        # ── 4. a card-only sale still never reaches the drawer ──────────────────────────────────
        book(
            {"amount": 3000, "payment_method_name": "Tarjeta", "payment_method_type": "card"},
            sale_id="sale-card-only",
        )
        check("a card-only sale leaves the drawer alone", expected_cash(sid), OPENING_FLOAT)
        run_sql_command("cash_register._reverse_sale", {"sale_id": "sale-card-only"})
        check(
            "and voiding it is a no-op, not a phantom refund",
            expected_cash(sid),
            OPENING_FLOAT,
        )

        # ── 5. back-compat: the one-tender sale every hub still emits today ─────────────────────
        book(
            {"amount": 4550, "payment_method_name": "Efectivo", "payment_method_type": "cash"},
            sale_id="sale-legacy",
        )
        check(
            "a sale with no payments[] books its single movement exactly as before",
            expected_cash(sid),
            OPENING_FLOAT + 4550,
        )
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'])


# ── the handler half, when a toolchain is at hand ───────────────────────────────────────────────


def check_handler() -> None:
    """`cargo test` on the handler. The module gate has no Rust toolchain and no checkout of the
    hub (the `guest-sdk` is a relative path dependency), and it NAMES that gap instead of hiding
    it. So this half runs where it can and is reported as NOT RUN where it cannot — never as
    passed. The Postgres half above runs everywhere and is what makes this file a battery."""
    if not shutil.which("cargo") or not (MODULE_DIR / "../../../hub/crates/guest-sdk").resolve().exists():
        print("  – NOT RUN: no cargo toolchain or no ERPlora/hub checkout (the gate documents this)")
        return
    res = subprocess.run(
        ["cargo", "test", "--quiet"],
        cwd=MODULE_DIR / "handler",
        capture_output=True,
        text=True,
        env={**os.environ, "CARGO_TARGET_DIR": os.environ.get("CARGO_TARGET_DIR", "/tmp/cash-register-handler-target")},
    )
    if res.returncode != 0:
        fail(f"cargo test on the handler is red:\n{res.stdout[-3000:]}\n{res.stderr[-2000:]}")
    else:
        ok("cargo test: the handler splits the event into one movement per leg")


def main() -> int:
    print("[mixed payment] manifest")
    check_manifest()
    print("[mixed payment] real Postgres")
    check_against_postgres()
    print("[mixed payment] handler")
    check_handler()
    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print("\nOK — the drawer counts the cash legs, and only the cash legs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
