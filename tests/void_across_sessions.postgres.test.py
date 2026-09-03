#!/usr/bin/env python3
"""Voiding a sale whose cash legs live in TWO sessions (cash_register#61, retargeted by #77).

THE INCIDENT (#61). `commands/_reverse_sale.sql` posted the compensating `refund` in the SAME
session that took the original `sale` movement, so it grouped by `orig.session_id`. But it wrote
**one** `:new_id` for every group the runtime gave it — the runtime injects exactly ONE id per SQL
command — so the moment a sale's cash legs sat in two sessions the INSERT produced two rows with
the same primary key and died:

    duplicate key value violates unique constraint "cash_register_movement_pkey"

The void then failed WHOLE: no reversal at all, and the drawer kept counting a sale that no longer
existed. Underneath it a second, quieter one: the "already refunded" subquery was a scalar over the
WHOLE sale, so every group subtracted the SAME refund total — a 30,00 € refund came off both
sessions and 30,00 € of live cash stayed in the till for good.

WHY THIS BATTERY STILL EXISTS AFTER #77. #77 moved the reversal to the OPEN session — one target,
so one row, so one id — which makes that primary-key collision structurally impossible instead of
merely fixed. That is exactly the kind of change that quietly deletes a regression test, so the
scenario stays and the assertions move: a sale split across two shifts must still VOID (not die),
must still reverse exactly what is LIVE, and must still net the refunds ONCE. What changed is
WHERE the money comes out — the drawer that is open now, never a shift already counted (#77).

HOW A SALE ENDS UP IN TWO SESSIONS. `004_one_open_session_per_hub.sql` allows a single OPEN session
per hub, so today the two legs of one `record_sale` delivery always land together. They come apart
the moment a leg is booked, the shift is closed, and another leg of the SAME sale is booked in the
next shift — which is what this battery does, through the module's own doors, no hand-written rows.
That is also the shape the day several tills per hub are allowed, which is what the issue was
filed for.

THE RULE FOR THE REFUNDS. The live amount of the sale is what came in minus what already went back
in cash — one number for the sale, not one per session (cash_register#63). Since #77 it is also
reversed in one place, so the waterfall that spread it over the original sessions is gone with the
reason for it.

Usage: tests/void_across_sessions.postgres.test.py   (exit 0 = green)
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
DB = f"cash_register_void_sessions_test_{os.getpid()}"
HUB = "hub-a"
NEIGHBOUR = "hub-next-door"
USER = "u-cashier"

OPENING_FLOAT = 10000  # 100,00 €
MORNING_LEG = 6000  # 60,00 €
AFTERNOON_LEG = 4000  # 40,00 €
SALE_TOTAL = MORNING_LEG + AFTERNOON_LEG  # 100,00 €

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


# ── Postgres plumbing (same shape as tests/void_after_partial_refund.postgres.test.py) ──────────


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
    p.setdefault("now", "2026-08-24T10:00:00+00:00")
    p.setdefault("new_id", str(uuid.uuid4()))
    return p


def run_sql_command(name: str, payload: dict, hub: str = HUB) -> None:
    cmd = MANIFEST["commands"][name]
    p = sys_params(payload, hub)
    if name == "cash_register._open_session_insert":
        p.setdefault("day", "20260824")
        p.setdefault("session_day", "260824")
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


def open_session_id(hub: str = HUB) -> str | None:
    """The hub's OPEN session, if any. Test plumbing: `open_session.sql` takes the single-open-session
    slot with `ON CONFLICT DO NOTHING`, so a scenario that forgets to close the previous shift gets a
    silent no-op and its movements pile into the old drawer."""
    return (
        psql(
            [
                "-tA",
                "-c",
                "SELECT id FROM cash_register_session"
                f" WHERE hub_id = '{hub}' AND status = 'open' AND is_deleted = 0",
            ],
            db=DB,
        ).strip()
        or None
    )


def open_session(when: str, hub: str = HUB) -> str:
    sid = str(uuid.uuid4())
    run_sql_command(
        "cash_register._open_session_insert",
        {
            "session_id": sid,
            "opening_balance": OPENING_FLOAT,
            "register_id": None,
            "opening_notes": "",
            "now": when,
        },
        hub,
    )
    return sid


def close_session(session_id: str, when: str, hub: str = HUB) -> None:
    run_sql_command(
        "cash_register._close_session_apply",
        {
            "session_id": session_id,
            "closing_balance": 0,
            "expected_balance": 0,
            "difference": 0,
            "closing_notes": "",
            "now": when,
        },
        hub,
    )


def book_sale(amount: int, sale_id: str, when: str, hub: str = HUB) -> None:
    """One CASH sale leg, through the door `record_sale` emits."""
    run_sql_command(
        "cash_register._movement_for_open_session",
        {
            "movement_id": str(uuid.uuid4()),
            "movement_type": "sale",
            "amount": amount,
            "gift_total": 0,
            "payment_method": "Efectivo",
            "payment_method_type": "cash",
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


def void(
    sale_id: str,
    when: str = "2026-08-24T20:00:00+00:00",
    hub: str = HUB,
    movement_id: str | None = None,
) -> str:
    """The write half of the `sale.voided` listener (#77: the `reverse_sale` handler checks there is
    an open drawer and then emits this). Returns the id the handler handed over."""
    ident = movement_id or str(uuid.uuid4())
    run_sql_command(
        "cash_register._reverse_movement_for_open_session",
        {"sale_id": sale_id, "now": when, "movement_id": ident},
        hub,
    )
    return ident


def expected_cash(session_id: str, hub: str = HUB) -> int:
    return run_query("cash_register.session.summary", {"session_id": session_id}, hub)[
        0
    ]["expected_cash"]


def void_movements(sale_id: str, hub: str = HUB) -> list[int]:
    """Magnitudes the void reversal posted for this sale, oldest session first."""
    return [amount for _, amount in void_movements_by_session(sale_id, hub)]


def void_movements_by_session(sale_id: str, hub: str = HUB) -> list[tuple[str, int]]:
    """(session_id, magnitude) of every void reversal of this sale, oldest session first."""
    rows = json.loads(
        psql(
            [
                "-tA",
                "-c",
                "SELECT COALESCE(json_agg(json_build_array(t.session_id, t.amount)"
                " ORDER BY t.opened_at, t.session_id), '[]'::json) FROM ("
                " SELECT m.session_id, ABS(m.amount) AS amount, s.opened_at"
                " FROM cash_register_movement m"
                " JOIN cash_register_session s ON s.id = m.session_id"
                f" WHERE m.hub_id = '{hub}' AND m.sale_reference = '{sale_id}'"
                " AND m.movement_type = 'refund'"
                f" AND m.description = '[VOID] Sale {sale_id}') t",
            ],
            db=DB,
        ).strip()
    )
    return [(r[0], r[1]) for r in rows]


def void_ids(sale_id: str, hub: str = HUB) -> list[str]:
    """The ids of the void movements of this sale, oldest session first."""
    return json.loads(
        psql(
            [
                "-tA",
                "-c",
                "SELECT COALESCE(json_agg(t.id ORDER BY t.opened_at, t.session_id), '[]'::json)"
                " FROM (SELECT m.id, m.session_id, s.opened_at"
                " FROM cash_register_movement m"
                " JOIN cash_register_session s ON s.id = m.session_id"
                f" WHERE m.hub_id = '{hub}' AND m.sale_reference = '{sale_id}'"
                " AND m.movement_type = 'refund'"
                f" AND m.description = '[VOID] Sale {sale_id}') t",
            ],
            db=DB,
        ).strip()
    )


def distinct_ids(sale_id: str, hub: str = HUB) -> int:
    return int(
        psql(
            [
                "-tA",
                "-c",
                "SELECT COUNT(DISTINCT m.id) FROM cash_register_movement m"
                f" WHERE m.hub_id = '{hub}' AND m.sale_reference = '{sale_id}'"
                f" AND m.description = '[VOID] Sale {sale_id}'",
            ],
            db=DB,
        ).strip()
    )


# ── the cases ──────────────────────────────────────────────────────────────────────────────────


def split_sale(sale_id: str, refund: tuple[int, str] | None = None, hub: str = HUB):
    """Book `sale_id` across TWO sessions of `hub` and return both session ids.

    Morning shift takes the first leg and is CLOSED; the afternoon shift takes the second. This is
    the only way a hub can get there today (`004_one_open_session_per_hub.sql`) and it uses nothing
    but the module's own commands.
    """
    running = open_session_id(hub)
    if running is not None:
        close_session(running, "2026-08-24T07:30:00+00:00", hub)
    morning = open_session("2026-08-24T08:00:00+00:00", hub)
    book_sale(MORNING_LEG, sale_id, "2026-08-24T09:00:00+00:00", hub)
    if refund is not None:
        book_refund(sale_id, refund[0], refund[1], "2026-08-24T09:30:00+00:00", hub)
    close_session(morning, "2026-08-24T14:00:00+00:00", hub)
    afternoon = open_session("2026-08-24T15:00:00+00:00", hub)
    book_sale(AFTERNOON_LEG, sale_id, "2026-08-24T16:00:00+00:00", hub)
    return morning, afternoon


def run_cases() -> None:
    # ── 1. THE ISSUE: two sessions, one sale, one void ──────────────────────────────────────────
    print("\n1 · the issue: a sale whose cash legs sit in two sessions is voided")
    sale = "sale-split-clean"
    morning, afternoon = split_sale(sale)
    check(
        "the morning shift holds its 60,00 € leg",
        expected_cash(morning),
        OPENING_FLOAT + MORNING_LEG,
    )
    check(
        "the afternoon shift holds its 40,00 € leg",
        expected_cash(afternoon),
        OPENING_FLOAT + AFTERNOON_LEG,
    )

    # 🔴 THE issue: before #61 this raised
    # `duplicate key value violates unique constraint "cash_register_movement_pkey"`
    # and the whole void was lost. Since #77 there is only ever one row, so the collision cannot be
    # written at all — but the void still has to HAPPEN, which is what this asserts.
    injected = void(sale)
    check(
        "the void goes through and writes exactly one movement",
        void_ids(sale),
        [injected],
    )
    check(
        "in the OPEN shift, for the whole live amount of the sale (#77)",
        void_movements_by_session(sale),
        [(afternoon, SALE_TOTAL)],
    )
    check("so there is one id, and it is the one handed over", distinct_ids(sale), 1)
    check(
        "the CLOSED morning shift is not touched: its count stands",
        expected_cash(morning),
        OPENING_FLOAT + MORNING_LEG,
    )
    check(
        "and the drawer that is open pays the whole 100,00 € back",
        expected_cash(afternoon),
        OPENING_FLOAT + AFTERNOON_LEG - SALE_TOTAL,
    )

    # ── 2. THE CONTROL: a sale that never left its shift ─────────────────────────────────────────
    # Today's only reachable shape (`004_one_open_session_per_hub.sql`) must not change at all: the
    # open session IS the original one, so this is the same single movement it always was.
    print("\n2 · the control: a single-session sale still posts exactly one movement")
    before = expected_cash(afternoon)
    book_sale(2500, "sale-one-session", "2026-08-24T17:00:00+00:00")
    check("the sale enters the open till", expected_cash(afternoon), before + 2500)
    injected = void("sale-one-session")
    check("voiding it reverses all 25,00 €", expected_cash(afternoon), before)
    check("in a single movement", void_movements("sale-one-session"), [2500])
    check(
        "carrying exactly the id the handler passed, as it always did",
        void_ids("sale-one-session"),
        [injected],
    )

    # ── 3. THE REFUND IS SUBTRACTED ONCE, NOT ONCE PER SESSION ──────────────────────────────────
    # The scalar "already refunded" subquery was the same number for every group, so before #61 a
    # 30,00 € refund came off BOTH sessions: 30,00 € + 10,00 € reversed instead of 70,00 €, and
    # 30,00 € of live cash stayed in the till in silence. The live amount is one number for the
    # SALE, and since #77 it comes out of one drawer: 100,00 − 30,00 = 70,00 €.
    print("\n3 · a partial refund shrinks the reversal ONCE across both sessions")
    sale = "sale-split-refunded"
    morning3, afternoon3 = split_sale(sale, refund=(3000, "refund-doc-61-a"))
    void(sale)
    check(
        "one reversal, in the open shift, for what was still live",
        void_movements_by_session(sale),
        [(afternoon3, SALE_TOTAL - 3000)],
    )
    check(
        "so the void reverses exactly what was still live: 70,00 €",
        sum(void_movements(sale)),
        SALE_TOTAL - 3000,
    )
    check(
        "and the shift that was already closed keeps its own number",
        expected_cash(morning3),
        OPENING_FLOAT + MORNING_LEG - 3000,
    )

    # ── 4. FULLY refunded across sessions: nothing left to reverse ──────────────────────────────
    # Nothing may be posted, and nothing POSITIVE above all: the floor must hold, never hand the
    # drawer money it never had.
    print("\n4 · a sale already refunded in FULL leaves nothing for the void")
    sale = "sale-split-fully-refunded"
    morning4, afternoon4 = split_sale(sale, refund=(SALE_TOTAL, "refund-doc-61-b"))
    square_m, square_a = expected_cash(morning4), expected_cash(afternoon4)
    void(sale)
    check("no compensating movement at all", void_movements_by_session(sale), [])
    check("the morning drawer does not move", expected_cash(morning4), square_m)
    check("the afternoon drawer does not move", expected_cash(afternoon4), square_a)

    # ── 4b. THE REFUND EATS ONE LEG EXACTLY AND THE REST STILL REVERSES ─────────────────────────
    # A refund the size of a whole leg is the arithmetic edge of the netting: what is left is the
    # other leg, and it still has to come out — with the id the handler handed over, because that
    # is the id the caller is answered with, and an id naming a row nobody wrote is a caller left
    # holding a handle to nothing.
    print("\n4b · a refund the size of one leg still leaves the other to reverse")
    sale = "sale-split-first-leg-gone"
    morning4b, afternoon4b = split_sale(sale, refund=(MORNING_LEG, "refund-doc-61-c"))
    injected = void(sale)
    check(
        "the reversal is what survives the netting, in the open shift",
        void_movements_by_session(sale),
        [(afternoon4b, SALE_TOTAL - MORNING_LEG)],
    )
    check("and it carries the id the handler passed", void_ids(sale), [injected])

    # ── 5. IDEMPOTENCE across sessions ──────────────────────────────────────────────────────────
    # Defence in depth over the runtime's `_event_delivery` marker: a re-delivered `sale.voided`
    # must not post a second movement.
    print("\n5 · re-delivering the void does not reverse twice")
    sale = "sale-split-clean"
    before_m, before_a = expected_cash(morning), expected_cash(afternoon)
    void(sale)
    check(
        "the drawers do not move again",
        (expected_cash(morning), expected_cash(afternoon)),
        (before_m, before_a),
    )
    check(
        "and there is still exactly one void movement",
        void_movements_by_session(sale),
        [(afternoon, SALE_TOTAL)],
    )

    # ── 6. TENANCY, with a LIVE neighbour on the same sale reference ────────────────────────────
    # The neighbour's own split sale must be untouched by ours, and ours by theirs.
    print("\n6 · the hub next door keeps its own split sale")
    sale = "sale-split-shared-ref"
    n_morning, n_afternoon = split_sale(sale, hub=NEIGHBOUR)
    _mine_m, mine_a = split_sale(sale)
    void(sale)
    check(
        "our void books in OUR open shift",
        void_movements_by_session(sale),
        [(mine_a, SALE_TOTAL)],
    )
    check(
        "and posts nothing in the neighbour's drawers",
        void_movements_by_session(sale, NEIGHBOUR),
        [],
    )
    check(
        "whose sessions still hold their own legs",
        (
            expected_cash(n_morning, NEIGHBOUR),
            expected_cash(n_afternoon, NEIGHBOUR),
        ),
        (OPENING_FLOAT + MORNING_LEG, OPENING_FLOAT + AFTERNOON_LEG),
    )


def main() -> int:
    print(f"[void-across-sessions] real Postgres · container {CONTAINER}")
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

    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print(
        "\nOK — a sale split across two sessions voids in ONE movement, in the open shift, netted once"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
