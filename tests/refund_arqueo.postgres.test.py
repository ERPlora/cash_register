#!/usr/bin/env python3
"""A REFUND leaves its entry in the drawer, typed after the DESTINATION (cash_register#62).

`sales` v2.16.4 (sales#160, ADR-0386 decision 3) emits `sale.refunded` with one entry per leg in
`payments[]`. Each entry carries TWO different things, and telling them apart is the whole point:

  - `payment_id`     — the tender the money comes OUT of. It caps how much may be refunded.
  - `payment_method_type` — where the money goes BACK TO. It, and only it, decides the drawer.

The drawer did not listen at all. A refund handed over in cash took money out of the till and left
NO movement behind: the cashier counts the drawer at closing time, the money is short, and nothing
in the session explains it. This is cash_register#59's failure seen from the other side.

`_reverse_sale` cannot be reused, and this file pins both reasons:

  1. it reverses the WHOLE sale (`SUM(orig.amount)` grouped by session). A refund is partial and
     repeatable — 50,00 € today, the rest next week — and each document is its own movement.
  2. it types the movement after the ORIGINAL tender. Refunds do not have to go back the way they
     came: a card sale can be refunded in cash when the card is gone (Square's case), and a cash
     sale can be pushed back onto a card. Typing by origin gets BOTH of those exactly wrong, and
     sections 1 and 2 below are the two halves of that proof.

THE NUMBERS, and they are the issue's own:

  float                     100,00 €   drawer expects 100,00 €
  sale, all on CARD          70,00 €   drawer expects 100,00 €  (card never enters the till)
  refund to CASH             50,00 €   drawer expects  50,00 €  ← only with this fix
                                       drawer expected 100,00 €  before it, holding 50,00 €
                                       → the count came out 50,00 € SHORT, silently

WHAT THIS FILE PROVES, and what it does not:

  - it proves the drawer's SQL — the refund insert door, its UNIQUE index, the count, the reversal,
    the tenancy filter — behaves correctly against a REAL Postgres built from this module's own
    migrations;
  - it does NOT decide which legs get booked or how they are typed. That is pure Rust in
    `handler/src/lib.rs::record_refund_pure`, pinned by `cargo test` there. The module gate has no
    Rust toolchain, so this file runs `cargo test` when one is at hand and reports it as NOT RUN
    when there is none. It never reports it as passed.

Usage: tests/refund_arqueo.postgres.test.py   (exit 0 = green)
  Uses the `erplora-test-pg-5433` container by default (override:
  CASH_REGISTER_TEST_PG_CONTAINER). Creates a scratch database and DROPS it at the end, pass or
  fail. It NEVER skips itself: a battery that goes green because it could not reach Postgres is
  worse than no battery at all.
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
DB = f"cash_register_refund_test_{os.getpid()}"
HUB = "hub-a"
NEIGHBOUR = "hub-next-door"
USER = "u-cashier"

OPENING_FLOAT = 10000  # 100,00 €
CARD_SALE = "sale-paid-by-card"
CARD_SALE_TOTAL = 7000  # 70,00 €
CASH_REFUND = 5000  # 50,00 €
REFUND_REF = "refund-doc-0001"

# The event `sales` v2.16.4 emits for the issue's case: a card sale coming back IN CASH, because
# the card the customer paid with no longer exists. `payment_id` names the tender the money leaves
# (the card leg — that is what caps it); `payment_method_type` is where it lands (the till).
CARD_SALE_REFUNDED_IN_CASH = {
    "sender": "sales",
    "sale_id": CARD_SALE,
    "sale_number": "20260824-0007",
    "refund_id": REFUND_REF,
    "refund_ref": REFUND_REF,
    "total": CASH_REFUND,
    "reason": "returned",
    "refunded_by": USER,
    "refunded_at": "2026-08-24T12:00:00+00:00",
    "fully_refunded": False,
    "document_type": "ticket",
    "payments": [
        {
            "payment_id": "pay-card",
            "payment_method_id": "pm-cash",
            "payment_method_name": "Efectivo",
            "payment_method_type": "cash",
            "amount": CASH_REFUND,
        }
    ],
}

CODES = {"cash_register.refund_not_enough_ids": "errRefundNotEnoughIds"}

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


# ── Postgres plumbing (same shape as tests/mixed_payment_arqueo.postgres.test.py) ───────────────


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
        {"session_id": sid, "opening_balance": OPENING_FLOAT, "register_id": None, "opening_notes": ""},
        hub,
    )
    return sid


def book_sale(amount: int, kind: str, name: str, sale_id: str, hub: str = HUB) -> None:
    """One SALE movement, through the door `record_sale` emits."""
    run_sql_command(
        "cash_register._movement_for_open_session",
        {
            "movement_id": str(uuid.uuid4()),
            "movement_type": "sale",
            "amount": amount,
            "gift_total": 0,
            "payment_method": name,
            "payment_method_type": kind,
            "sale_reference": sale_id,
            "description": f"Sale {sale_id}",
        },
        hub,
    )


def book_refund(event: dict, hub: str = HUB) -> None:
    """The refund, through the door `record_refund` emits — one movement per leg of `payments[]`.

    The parameters below are exactly what `record_refund_pure` puts in each operation; the Rust
    tests named in the module docstring are what keeps the two halves from drifting."""
    for leg in event["payments"]:
        run_sql_command(
            "cash_register._refund_movement_for_open_session",
            {
                "movement_id": str(uuid.uuid4()),
                "amount": leg["amount"],
                # The DESTINATION's canonical type — never the origin tender's.
                "payment_method": leg["payment_method_name"],
                "payment_method_type": leg["payment_method_type"],
                "sale_reference": event["sale_id"],
                "refund_reference": event["refund_ref"],
                # The tender the money came OUT of: it is what makes each leg of one refund
                # document distinct, so the UNIQUE index can key on it.
                "source_payment_id": leg["payment_id"],
                "description": f"Refund {event['refund_ref']} · sale {event['sale_id']}",
            },
            hub,
        )


def expected_cash(session_id: str, hub: str = HUB) -> int:
    return run_query("cash_register.session.summary", {"session_id": session_id}, hub)[0]["expected_cash"]


def movements(session_id: str, movement_type: str | None = None) -> list[dict]:
    where = f"m.session_id = '{session_id}'"
    if movement_type:
        where += f" AND m.movement_type = '{movement_type}'"
    return json.loads(
        psql(
            [
                "-tA",
                "-c",
                "SELECT COALESCE(json_agg(json_build_object('amount', m.amount, 'type',"
                " m.payment_method_type, 'method', m.payment_method, 'ref', m.refund_reference)"
                f" ORDER BY m.amount), '[]'::json) FROM cash_register_movement m WHERE {where}",
            ],
            db=DB,
        ).strip()
    )


# ── the manifest half ──────────────────────────────────────────────────────────────────────────


def check_manifest() -> None:
    listen = MANIFEST["events"]["listen"]
    # Control: the listener that already exists. If this assertion cannot find `sale.completed`,
    # the one below cannot be trusted to have found anything either.
    check("positive control: the manifest reader does find an existing listener",
          listen.get("sale.completed", {}).get("command"), "cash_register.record_sale")

    # 🔴 THE issue: without this line the event is dropped on the floor and the money walks out of
    # the till with nothing to show for it.
    refund_listener = listen.get("sale.refunded", {}).get("command")
    check("the drawer listens to sale.refunded", refund_listener, "cash_register._record_refund")

    # The event payload IS the contract of a listener, and this listener's payload decides money.
    # It is only trustworthy while the runtime is the ONLY thing that can invoke it: `internal:
    # true` closes `POST /api/command`, the public API key surface, the assistant and the flow
    # engine, which would otherwise reach it with a forged `payments[]` and take any amount out of
    # the drawer, skipping every guard `movement.add` enforces. The `_` says the same thing by
    # convention; `internal` is the half the dispatcher actually enforces, so it carries both.
    for name in ("cash_register._record_refund", "cash_register._refund_movement_for_open_session"):
        cmd = MANIFEST["commands"].get(name)
        if cmd is None:
            fail(f"{name} is not declared in the manifest")
            continue
        if not cmd.get("internal"):
            fail(f"{name} must be `internal: true`: without it an external caller with"
                 " `add_movement` posts a drawer movement of any amount through it")
        else:
            ok(f"{name} is internal: only the runtime can invoke it")
        if "ai" in cmd:
            fail(f"{name} must not advertise an `ai` block: the assistant would be offered a tool"
                 " the dispatcher always refuses")

    en = json.loads((MODULE_DIR / "locales" / "en.json").read_text())["ui"]
    es = json.loads((MODULE_DIR / "locales" / "es.json").read_text())["ui"]
    missing = [f"{lang}.{key}" for lang, ui in (("en", en), ("es", es)) for key in CODES.values()
               if not ui.get(key)]
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

        # ── 0. POSITIVE CONTROL: the descuadre, with its exact size and sign ────────────────────
        # 100,00 € float, a 70,00 € sale all on CARD. The till holds the float and nothing else.
        # Now 50,00 € of that sale comes back to the customer IN CASH out of this drawer. With no
        # movement to explain it the session still expects 100,00 € while 50,00 € is physically
        # there: the count lands 50,00 € SHORT and the cashier has nothing to point at.
        blind = open_session()
        book_sale(CARD_SALE_TOTAL, "card", "Tarjeta", CARD_SALE)
        check("a card sale never enters the till", expected_cash(blind), OPENING_FLOAT)
        physically_in_the_drawer = OPENING_FLOAT - CASH_REFUND
        check(
            "positive control: cash handed back with NO movement leaves the count 50,00 € short",
            physically_in_the_drawer - expected_cash(blind),
            -CASH_REFUND,
        )
        check("and there is no refund movement to explain it", movements(blind, "refund"), [])
        run_sql_command("cash_register._close_session_apply", {
            "session_id": blind, "closing_balance": 0, "expected_balance": 0, "difference": 0,
            "closing_notes": ""})

        # ── 1. the fix: the refund leaves its entry, typed after the DESTINATION ────────────────
        sid = open_session()
        book_sale(CARD_SALE_TOTAL, "card", "Tarjeta", CARD_SALE)
        book_refund(CARD_SALE_REFUNDED_IN_CASH)

        refunds = movements(sid, "refund")
        check("the refund books one movement per leg", len(refunds), 1)
        check(
            "it carries the DESTINATION's type and the document reference, as an OUTGOING amount",
            refunds,
            [{"amount": -CASH_REFUND, "type": "cash", "method": "Efectivo", "ref": REFUND_REF}],
        )
        # 🔴 THE issue: 50,00 €, and the drawer now reconciles against what is physically in it.
        check("the drawer expects the float MINUS the cash that went back",
              expected_cash(sid), OPENING_FLOAT - CASH_REFUND)
        check("the count is square: expected equals what is in the drawer",
              (OPENING_FLOAT - CASH_REFUND) - expected_cash(sid), 0)
        for q in ("cash_register.current_session", "cash_register.current_session.expected"):
            check(f"{q} agrees", run_query(q)[0]["expected_total"], OPENING_FLOAT - CASH_REFUND)

        summary = run_query("cash_register.session.summary", {"session_id": sid})[0]
        check("the session reports the refund as refunded, in positive magnitude",
              summary["total_refunds"], CASH_REFUND)
        check("the card sale is still reported as sold", summary["total_sales"], CARD_SALE_TOTAL)

        # ── 2. THE MIRROR: a CASH sale refunded onto a CARD must NOT move the drawer ────────────
        # This is the other half of the destination rule, and the half that typing by ORIGIN gets
        # wrong in the opposite direction: it would take 30,00 € out of a till that keeps every
        # cent. Without this case, "use the destination" and "use the origin" are indistinguishable.
        before = expected_cash(sid)
        book_sale(3000, "cash", "Efectivo", "sale-paid-in-cash")
        check("the cash sale enters the till", expected_cash(sid), before + 3000)
        book_refund({
            "sale_id": "sale-paid-in-cash",
            "refund_ref": "refund-doc-0002",
            "payments": [{
                "payment_id": "pay-cash", "payment_method_id": "pm-card",
                "payment_method_name": "Tarjeta", "payment_method_type": "card", "amount": 3000,
            }],
        })
        check("a refund pushed back onto a card leaves the drawer untouched",
              expected_cash(sid), before + 3000)
        check("but it is still on the record as a refund",
              run_query("cash_register.session.summary", {"session_id": sid})[0]["total_refunds"],
              CASH_REFUND + 3000)

        # ── 3. IDEMPOTENCE by refund_ref: the same document never pays twice ────────────────────
        # Defence in depth over the runtime's `_event_delivery` marker. It is the UNIQUE index that
        # enforces it, not a read-then-write: two concurrent deliveries would both pass a NOT
        # EXISTS and both insert.
        square = expected_cash(sid)
        book_refund(CARD_SALE_REFUNDED_IN_CASH)
        check("re-delivering the same refund document takes no second 50,00 € out",
              expected_cash(sid), square)
        check("and leaves no second movement behind", len(movements(sid, "refund")), 2)

        # ── 4. PARTIAL and REPEATABLE: the rest of the sale comes back next ─────────────────────
        # This is what `_reverse_sale` structurally cannot do: it reverses the sale's whole `SUM`,
        # once. Two documents against one sale are two movements, and both count.
        book_refund({
            "sale_id": CARD_SALE,
            "refund_ref": "refund-doc-0003",
            "payments": [{
                "payment_id": "pay-card", "payment_method_id": "pm-cash",
                "payment_method_name": "Efectivo", "payment_method_type": "cash", "amount": 2000,
            }],
        })
        check("a second refund against the SAME sale books its own movement",
              expected_cash(sid), square - 2000)
        check("three refund movements against two sales", len(movements(sid, "refund")), 3)

        # ── 5. a MULTI-LEG refund: one document, N destinations ────────────────────────────────
        # Each leg is its own movement and only the cash one moves the till. Both legs share the
        # `refund_ref`, so the index has to key on the ORIGIN tender too or the second leg would be
        # swallowed as a duplicate — the failure this section exists to catch.
        two_ways = expected_cash(sid)
        book_refund({
            "sale_id": "sale-mixed",
            "refund_ref": "refund-doc-0004",
            "payments": [
                {"payment_id": "pay-a", "payment_method_id": "pm-cash",
                 "payment_method_name": "Efectivo", "payment_method_type": "cash", "amount": 1500},
                {"payment_id": "pay-b", "payment_method_id": "pm-card",
                 "payment_method_name": "Tarjeta", "payment_method_type": "card", "amount": 2500},
            ],
        })
        check("both legs of one document are booked", len(movements(sid, "refund")), 5)
        check("only the cash leg moves the drawer", expected_cash(sid), two_ways - 1500)

        # ── 6. TENANCY, with a LIVE neighbour ──────────────────────────────────────────────────
        # The same refund document id, in another hub, through the same enforcing door. A scoping
        # check with no neighbour proves nothing — and a UNIQUE index that forgot `hub_id` would
        # silently swallow the neighbour's refund instead of booking it.
        mine = expected_cash(sid)
        neighbour = open_session(NEIGHBOUR)
        book_sale(CARD_SALE_TOTAL, "card", "Tarjeta", CARD_SALE, hub=NEIGHBOUR)
        book_refund(CARD_SALE_REFUNDED_IN_CASH, hub=NEIGHBOUR)
        check("the neighbour's refund reaches the neighbour's drawer",
              expected_cash(neighbour, NEIGHBOUR), OPENING_FLOAT - CASH_REFUND)
        check("and never this hub's", expected_cash(sid), mine)

        # ── 7. the VOID path still behaves, refunds and all ────────────────────────────────────
        # `_reverse_sale` keys on `movement_type='sale'`, so the refund movements must be invisible
        # to it: reversing the cash sale takes back 30,00 € and not a cent more.
        cash_sale_session = expected_cash(sid)
        run_sql_command("cash_register._reverse_sale", {"sale_id": "sale-paid-in-cash"})
        check("voiding the cash sale reverses its 30,00 €, untouched by the refunds",
              expected_cash(sid), cash_sale_session - 3000)
        run_sql_command("cash_register._reverse_sale", {"sale_id": "sale-paid-in-cash"})
        check("and the void is still idempotent", expected_cash(sid), cash_sale_session - 3000)

        # ── 8. BACK-COMPAT: a hub whose `sales` never emits sale.refunded ───────────────────────
        # Nothing about the sale path changed. A sale booked with no refund document behaves
        # exactly as it did before this migration existed, and the columns it never fills are
        # empty strings, not NULLs that would poison the index.
        legacy = expected_cash(sid)
        book_sale(4550, "cash", "Efectivo", "sale-legacy")
        check("a sale from an older `sales` books its movement exactly as before",
              expected_cash(sid), legacy + 4550)
        blanks = psql(["-tA", "-c",
                       "SELECT COUNT(*) FROM cash_register_movement WHERE movement_type = 'sale'"
                       " AND (refund_reference <> '' OR source_payment_id <> ''"
                       "      OR refund_reference IS NULL OR source_payment_id IS NULL)"],
                      db=DB).strip()
        check("and no sale movement carries a refund reference", blanks, "0")
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
        ok("cargo test: the handler types each refund leg after its destination")


def main() -> int:
    print("[refund] manifest")
    check_manifest()
    print("[refund] real Postgres")
    check_against_postgres()
    print("[refund] handler")
    check_handler()
    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print("\nOK — a refund leaves its entry, and only the cash that went back moves the drawer")
    return 0


if __name__ == "__main__":
    sys.exit(main())
