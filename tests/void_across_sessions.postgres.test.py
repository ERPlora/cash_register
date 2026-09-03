#!/usr/bin/env python3
"""Voiding a sale whose cash legs live in TWO sessions (cash_register#61).

`commands/_reverse_sale.sql` posts the compensating `refund` in the SAME session that took the
original `sale` movement, so it groups by `orig.session_id`. But it wrote **one** `:new_id` for
every group the runtime gave it — the runtime injects exactly ONE id per SQL command — so the
moment a sale's cash legs sat in two sessions the INSERT produced two rows with the same primary
key and died:

    duplicate key value violates unique constraint "cash_register_movement_pkey"

The void then failed WHOLE: no reversal at all, and the drawer kept counting a sale that no longer
existed. And underneath it a second, quieter one: the "already refunded" subquery is a scalar over
the WHOLE sale, so every group subtracted the SAME refund total — a 30,00 € refund came off both
sessions and 30,00 € of live cash stayed in the till for good.

HOW A SALE ENDS UP IN TWO SESSIONS. `004_one_open_session_per_hub.sql` allows a single OPEN session
per hub, so today the two legs of one `record_sale` delivery always land together. They come apart
the moment a leg is booked, the shift is closed, and another leg of the SAME sale is booked in the
next shift — which is what this battery does, through the module's own doors, no hand-written rows.
That is also the shape the day several tills per hub are allowed, which is what the issue was
filed for.

THE RULE FOR THE REFUNDS. The live amount of the sale is what came in minus what already went back
in cash — one number for the sale, not one per session (cash_register#63). Spread over sessions it
is a WATERFALL in booking order: the refunds eat the oldest sale legs first, no session ever goes
below zero, and the TOTAL reversed is exactly the live amount. With one session it is arithmetically
identical to what #63 shipped, which is why that battery keeps passing untouched.

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
    new_id: str | None = None,
) -> str:
    """The `sale.voided` listener, through its own door. Returns the `:new_id` the runtime injected."""
    ident = new_id or str(uuid.uuid4())
    run_sql_command(
        "cash_register._reverse_sale",
        {"sale_id": sale_id, "now": when, "new_id": ident},
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

    # 🔴 THE issue: before the fix this raised
    # `duplicate key value violates unique constraint "cash_register_movement_pkey"`
    # and the whole void was lost.
    injected = void(sale)
    check(
        "the runtime's own `:new_id` names the first of the rows written",
        void_ids(sale)[:1],
        [injected],
    )
    check(
        "each session gets its OWN compensating movement, for its OWN leg",
        void_movements_by_session(sale),
        [(morning, MORNING_LEG), (afternoon, AFTERNOON_LEG)],
    )
    check("and the two movements carry two distinct ids", distinct_ids(sale), 2)
    check("the morning drawer is back on its float", expected_cash(morning), OPENING_FLOAT)
    check(
        "the afternoon drawer is back on its float",
        expected_cash(afternoon),
        OPENING_FLOAT,
    )

    # ── 2. THE CONTROL: one session still reverses in ONE movement ──────────────────────────────
    # Without it, "split the reversal" and "post one row per session always" would look the same in
    # §1's numbers. Today's only reachable shape must not change at all.
    print("\n2 · the control: a single-session sale still posts exactly one movement")
    before = expected_cash(afternoon)
    book_sale(2500, "sale-one-session", "2026-08-24T17:00:00+00:00")
    check("the sale enters the open till", expected_cash(afternoon), before + 2500)
    injected = void("sale-one-session")
    check("voiding it reverses all 25,00 €", expected_cash(afternoon), before)
    check("in a single movement", void_movements("sale-one-session"), [2500])
    check(
        "carrying exactly the id the runtime injected, as it always did",
        void_ids("sale-one-session"),
        [injected],
    )

    # ── 3. THE REFUND IS SUBTRACTED ONCE, NOT ONCE PER SESSION ──────────────────────────────────
    # The scalar "already refunded" subquery is the same number for every group, so before the fix
    # a 30,00 € refund came off BOTH sessions: 30,00 € + 10,00 € reversed instead of 70,00 €, and
    # 30,00 € of live cash stayed in the till in silence. The waterfall spends the refund on the
    # oldest leg first: the morning reverses 60 − 30 = 30, the afternoon its whole 40.
    print("\n3 · a partial refund shrinks the reversal ONCE across both sessions")
    sale = "sale-split-refunded"
    morning3, afternoon3 = split_sale(sale, refund=(3000, "refund-doc-61-a"))
    void(sale)
    check(
        "the refund eats the oldest leg first and only once",
        void_movements_by_session(sale),
        [(morning3, MORNING_LEG - 3000), (afternoon3, AFTERNOON_LEG)],
    )
    check(
        "so the void reverses exactly what was still live: 70,00 €",
        sum(void_movements(sale)),
        SALE_TOTAL - 3000,
    )

    # ── 4. FULLY refunded across sessions: nothing left to reverse ──────────────────────────────
    # No group may post a row, and none may post a POSITIVE one: a session whose leg is smaller
    # than the refund must floor at zero, never hand the drawer money it never had.
    print("\n4 · a sale already refunded in FULL leaves nothing for the void")
    sale = "sale-split-fully-refunded"
    morning4, afternoon4 = split_sale(sale, refund=(SALE_TOTAL, "refund-doc-61-b"))
    square_m, square_a = expected_cash(morning4), expected_cash(afternoon4)
    void(sale)
    check("no compensating movement at all", void_movements_by_session(sale), [])
    check("the morning drawer does not move", expected_cash(morning4), square_m)
    check("the afternoon drawer does not move", expected_cash(afternoon4), square_a)

    # ── 4b. THE FIRST GROUP FLOORS TO ZERO AND A LATER ONE SURVIVES ────────────────────────────
    # The refund eats the morning leg EXACTLY. That group must post nothing, the afternoon must post
    # its whole leg — and `:new_id` has to land on THAT row: the runtime answers the command with
    # that id, so an id naming a row nobody wrote is a caller left holding a handle to nothing.
    # Numbering the groups BEFORE the floor would have burnt `:new_id` on the row that never exists.
    print("\n4b · the refund eats the first leg exactly; the second still reverses")
    sale = "sale-split-first-leg-gone"
    morning4b, afternoon4b = split_sale(sale, refund=(MORNING_LEG, "refund-doc-61-c"))
    injected = void(sale)
    check(
        "only the afternoon reverses, for its whole leg",
        void_movements_by_session(sale),
        [(afternoon4b, AFTERNOON_LEG)],
    )
    check("and it carries the runtime's `:new_id`", void_ids(sale), [injected])
    check(
        "the total reversed is what was live: 40,00 €",
        sum(void_movements(sale)),
        SALE_TOTAL - MORNING_LEG,
    )

    # ── 5. IDEMPOTENCE across sessions ──────────────────────────────────────────────────────────
    # Defence in depth over the runtime's `_event_delivery` marker: a re-delivered `sale.voided`
    # must not post a second pair of movements.
    print("\n5 · re-delivering the void does not reverse twice")
    sale = "sale-split-clean"
    before_m, before_a = expected_cash(morning), expected_cash(afternoon)
    void(sale)
    check("the drawers do not move again", (expected_cash(morning), expected_cash(afternoon)), (before_m, before_a))
    check(
        "and there are still exactly two void movements",
        void_movements_by_session(sale),
        [(morning, MORNING_LEG), (afternoon, AFTERNOON_LEG)],
    )

    # ── 6. TENANCY, with a LIVE neighbour on the same sale reference ────────────────────────────
    # The neighbour's own split sale must be untouched by ours, and ours by theirs.
    print("\n6 · the hub next door keeps its own split sale")
    sale = "sale-split-shared-ref"
    n_morning, n_afternoon = split_sale(sale, hub=NEIGHBOUR)
    mine_m, mine_a = split_sale(sale)
    void(sale)
    check(
        "our void reverses OUR two legs",
        void_movements_by_session(sale),
        [(mine_m, MORNING_LEG), (mine_a, AFTERNOON_LEG)],
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
        "\nOK — a sale split across two sessions reverses one movement per session, netted once"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
