#!/usr/bin/env python3
"""Voiding a sale whose shift is already CLOSED and counted (cash_register#77).

`commands/_reverse_sale.sql` used to post the compensating `refund` in the session that took the
ORIGINAL `sale` movement — `GROUP BY orig.session_id`. Nothing said that session had to still be
open, so a sale voided after the shift was cashed up landed a movement in a **closed** drawer:

  · `queries/session_summary.sql` recomputes `expected_cash` from the movements, so the expected of
    a shift that was already counted and signed moved AFTER the count;
  · the STORED `difference`/`expected_balance` — the audited pair the cashier was measured against —
    stayed where the close had left them, so the two readings of the same shift disagreed
    (`cash_register.sessions.list` serves the stored column for closed shifts since #65);
  · and the drawer the money physically comes out of TODAY did not move at all.

THE RULE THIS BATTERY PINS (the market's, see `commands/_reverse_movement_for_open_session.sql`):
the compensating
movement is booked in the OPEN session at the moment of the void, exactly like a refund
(`_refund_movement_for_open_session`, cash_register#62). A closed shift is FROZEN. When the void
happens during the same shift that took the sale — today's ordinary case — that open session IS the
original one, so nothing about the common path changes.

And its second half: `session.summary` of a CLOSED shift answers with the STORED audited figure,
the same rule `sessions_list.sql` already applies (#65). Landing the void elsewhere fixes the way a
closed shift moved; freezing the reading is what stops ANY later row from moving it again.

Usage: tests/void_after_shift_closed.postgres.test.py   (exit 0 = green)
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
DB = f"cash_register_void_closed_test_{os.getpid()}"
HUB = "hub-a"
NEIGHBOUR = "hub-next-door"
USER = "u-cashier"

# The command the `sale.voided` listener ends up writing with. The listener itself is a handler
# (`reverse_sale`) whose only job is to refuse when no drawer is open; the row is written by this.
VOID_SQL_COMMAND = "cash_register._reverse_movement_for_open_session"

OPENING_FLOAT = 10000  # 100,00 €
SALE_TOTAL = 10000  # 100,00 €

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


# ── Postgres plumbing (same shape as tests/void_across_sessions.postgres.test.py) ───────────────


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
    sql = (
        bind((MODULE_DIR / q["sql"]).read_text(), sys_params(payload or {}, hub))
        .rstrip()
        .rstrip(";")
    )
    out = psql(
        ["-tA", "-c", f"SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM ({sql}) t"],
        db=DB,
    )
    return json.loads(out.strip() or "[]")


def open_session_id(hub: str = HUB) -> str | None:
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


def cash_up(session_id: str, counted: int, when: str, hub: str = HUB) -> None:
    """Close the shift the way a cashier does: count the drawer and post THAT as the closing
    balance. `close_session.sql` derives `expected_balance` and `difference` itself and STORES both
    — that stored pair is the audited figure this battery watches."""
    run_sql_command(
        "cash_register._close_session_apply",
        {"session_id": session_id, "closing_balance": counted, "closing_notes": "", "now": when},
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


def void(sale_id: str, when: str, hub: str = HUB, movement_id: str | None = None) -> str:
    """The write half of the `sale.voided` listener — the door the `reverse_sale` handler emits once
    it has checked there IS an open drawer. Returns the id the handler handed over."""
    ident = movement_id or str(uuid.uuid4())
    run_sql_command(VOID_SQL_COMMAND, {"sale_id": sale_id, "now": when, "movement_id": ident}, hub)
    return ident


def summary(session_id: str, hub: str = HUB) -> dict:
    return run_query("cash_register.session.summary", {"session_id": session_id}, hub)[0]


def expected_cash(session_id: str, hub: str = HUB) -> int:
    return summary(session_id, hub)["expected_cash"]


def stored_arqueo(session_id: str) -> tuple[int, int]:
    """The AUDITED pair `close_session.sql` wrote: (expected_balance, difference)."""
    row = psql(
        [
            "-tA",
            "-c",
            "SELECT expected_balance || '|' || difference FROM cash_register_session"
            f" WHERE id = '{session_id}'",
        ],
        db=DB,
    ).strip()
    a, b = row.split("|")
    return int(a), int(b)


def listed_arqueo(session_id: str, hub: str = HUB) -> tuple[int, int]:
    """What the Cash grid shows for the shift (`cash_register.sessions.list`, #65)."""
    row = next(r for r in run_query("cash_register.sessions.list", {}, hub) if r["id"] == session_id)
    return row["expected_balance"], row["difference"]


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


def force_movement_into(session_id: str, amount: int, when: str, hub: str = HUB) -> None:
    """TEST PLUMBING, and the only hand-written row in this file. There is no module door that
    books into a CLOSED shift any more — which is the point of §1 — so the freeze of §7 has to be
    proven by putting the row there by force. If `session_summary` still recomputed, this would
    move the audited expected of a shift nobody can touch."""
    psql(
        [
            "-c",
            "INSERT INTO cash_register_movement (id, hub_id, session_id, movement_type, amount,"
            " payment_method, payment_method_type, sale_reference, description, employee_id,"
            " is_deleted, created_by, updated_by, created_at, updated_at) VALUES"
            f" ('{uuid.uuid4()}', '{hub}', '{session_id}', 'refund', {-abs(amount)}, 'cash',"
            f" 'cash', '', 'late row', '{USER}', 0, '{USER}', '{USER}', '{when}', '{when}')",
        ],
        db=DB,
    )


# ── the cases ──────────────────────────────────────────────────────────────────────────────────


def shift_that_sold_and_cashed_up(sale_id: str, hub: str = HUB) -> str:
    """Morning shift: float in, ONE cash sale, counted and closed square. Returns its id."""
    running = open_session_id(hub)
    if running is not None:
        cash_up(running, OPENING_FLOAT, "2026-08-24T07:30:00+00:00", hub)
    morning = open_session("2026-08-24T08:00:00+00:00", hub)
    book_sale(SALE_TOTAL, sale_id, "2026-08-24T09:00:00+00:00", hub)
    # The cashier counts exactly what the drawer should hold: the arqueo comes out square.
    cash_up(morning, OPENING_FLOAT + SALE_TOTAL, "2026-08-24T14:00:00+00:00", hub)
    return morning


def run_cases() -> None:
    # ── 1. THE ISSUE ────────────────────────────────────────────────────────────────────────────
    print("\n1 · a sale voided after its shift was counted and closed")
    sale = "sale-voided-next-shift"
    morning = shift_that_sold_and_cashed_up(sale)
    check("the shift closed square", stored_arqueo(morning), (OPENING_FLOAT + SALE_TOTAL, 0))
    afternoon = open_session("2026-08-24T15:00:00+00:00")

    void(sale, "2026-08-24T16:00:00+00:00")

    check(
        "the compensating movement is booked in the OPEN shift, not the closed one",
        void_movements_by_session(sale),
        [(afternoon, SALE_TOTAL)],
    )
    check(
        "the closed shift keeps the audited pair it was signed with",
        stored_arqueo(morning),
        (OPENING_FLOAT + SALE_TOTAL, 0),
    )
    check(
        "and `session.summary` still answers with that same expected",
        expected_cash(morning),
        OPENING_FLOAT + SALE_TOTAL,
    )
    check(
        "so the grid and the summary agree about the closed shift",
        listed_arqueo(morning),
        (OPENING_FLOAT + SALE_TOTAL, 0),
    )
    check(
        "the money comes out of the drawer that is open today",
        expected_cash(afternoon),
        OPENING_FLOAT - SALE_TOTAL,
    )

    # ── 2. THE CONTROL: the ordinary case does not change ────────────────────────────────────────
    # Voiding during the shift that took the sale: the open session IS the original one, so this is
    # the same single movement it always was. Without this the fix could be "always post somewhere
    # else" and §1 would not notice.
    print("\n2 · the control: voided during its own shift, nothing changes")
    sale2 = "sale-voided-same-shift"
    before = expected_cash(afternoon)
    book_sale(2500, sale2, "2026-08-24T17:00:00+00:00")
    check("the sale enters the open till", expected_cash(afternoon), before + 2500)
    injected = void(sale2, "2026-08-24T17:30:00+00:00")
    check("voiding it reverses all 25,00 €", expected_cash(afternoon), before)
    check("in a single movement, in that same shift", void_movements_by_session(sale2), [(afternoon, 2500)])
    check("carrying the id the runtime injected", void_ids(sale2), [injected])

    # ── 3. WHAT IS ALREADY REFUNDED IS NOT REVERSED AGAIN (cash_register#63) ─────────────────────
    # The refund went out of TODAY's drawer (#62) and the sale is yesterday's. The live amount is
    # still one number for the SALE, so the void reverses 100,00 − 30,00 = 70,00 €, once.
    print("\n3 · a refund already paid out shrinks the reversal, once")
    sale3 = "sale-refunded-then-voided"
    morning3 = shift_that_sold_and_cashed_up(sale3)
    afternoon3 = open_session("2026-08-25T09:00:00+00:00")
    book_refund(sale3, 3000, "refund-doc-77-a", "2026-08-25T10:00:00+00:00")
    void(sale3, "2026-08-25T11:00:00+00:00")
    check(
        "only what was still live is reversed, in the open shift",
        void_movements_by_session(sale3),
        [(afternoon3, SALE_TOTAL - 3000)],
    )
    check(
        "the closed shift is untouched by either of them",
        (stored_arqueo(morning3), expected_cash(morning3)),
        ((OPENING_FLOAT + SALE_TOTAL, 0), OPENING_FLOAT + SALE_TOTAL),
    )

    # ── 4. NOTHING LIVE, NOTHING POSTED ─────────────────────────────────────────────────────────
    print("\n4 · a sale already refunded in full leaves nothing for the void")
    sale4 = "sale-fully-refunded-then-voided"
    morning4 = shift_that_sold_and_cashed_up(sale4)
    afternoon4 = open_session("2026-08-26T09:00:00+00:00")
    book_refund(sale4, SALE_TOTAL, "refund-doc-77-b", "2026-08-26T10:00:00+00:00")
    square = expected_cash(afternoon4)
    void(sale4, "2026-08-26T11:00:00+00:00")
    check("no compensating movement at all", void_movements_by_session(sale4), [])
    check("the open drawer does not move", expected_cash(afternoon4), square)
    check("nor does the closed one", expected_cash(morning4), OPENING_FLOAT + SALE_TOTAL)

    # ── 5. IDEMPOTENCE ──────────────────────────────────────────────────────────────────────────
    print("\n5 · re-delivering the void does not reverse twice")
    before5 = expected_cash(afternoon4)
    void(sale, "2026-08-26T12:00:00+00:00")
    check("the drawer does not move again", expected_cash(afternoon4), before5)
    check("and there is still exactly one void movement", void_movements_by_session(sale), [(afternoon, SALE_TOTAL)])

    # ── 6. TENANCY ──────────────────────────────────────────────────────────────────────────────
    # 🔴 The neighbour's open shift is deliberately the NEWEST. The reversal resolves its target
    # with `ORDER BY opened_at DESC LIMIT 1`, so with the `hub_id` filter dropped it would land in
    # whichever open session is newest ACROSS hubs: with both shifts opened at the same instant the
    # pick is a coin toss and the mutant survived. Opening the neighbour's last is what makes this
    # a tenancy test instead of a coincidence.
    print("\n6 · the hub next door keeps its own sale under the same reference")
    shared = "sale-shared-ref"
    mine_morning = shift_that_sold_and_cashed_up(shared)
    mine_afternoon = open_session("2026-08-27T09:00:00+00:00")
    n_morning = shift_that_sold_and_cashed_up(shared, NEIGHBOUR)
    n_afternoon = open_session("2026-08-27T09:30:00+00:00", NEIGHBOUR)
    void(shared, "2026-08-27T10:00:00+00:00")
    check("our void books in OUR open shift", void_movements_by_session(shared), [(mine_afternoon, SALE_TOTAL)])
    check("and nothing in the neighbour's", void_movements_by_session(shared, NEIGHBOUR), [])
    check(
        "whose shifts still hold their own numbers",
        (expected_cash(n_morning, NEIGHBOUR), expected_cash(n_afternoon, NEIGHBOUR)),
        (OPENING_FLOAT + SALE_TOTAL, OPENING_FLOAT),
    )
    check("and ours is untouched too", expected_cash(mine_morning), OPENING_FLOAT + SALE_TOTAL)

    # ── 7. THE CLOSED SHIFT IS FROZEN FOR EVERY LATER ROW, NOT JUST THIS ONE ────────────────────
    # §1 stops the void from landing there. This stops the READING from drifting if anything else
    # ever does — a backdated row, a soft-delete, a module we have not written yet. `sessions_list`
    # has answered with the stored column since #65; `session.summary` now agrees with it.
    print("\n7 · `session.summary` of a closed shift is the AUDITED figure, not a recount")
    force_movement_into(morning, 4200, "2026-08-28T10:00:00+00:00")
    check(
        "a late row does not move the expected of a counted shift",
        expected_cash(morning),
        OPENING_FLOAT + SALE_TOTAL,
    )
    check("the grid says the same", listed_arqueo(morning), (OPENING_FLOAT + SALE_TOTAL, 0))
    # And the guard that proves the check above can see a positive: an OPEN shift still recounts.
    live_before = expected_cash(mine_afternoon)
    force_movement_into(mine_afternoon, 4200, "2026-08-28T10:00:00+00:00")
    check(
        "while an OPEN shift still recomputes, so the check above is not vacuous",
        expected_cash(mine_afternoon),
        live_before - 4200,
    )


def main() -> int:
    print(f"[void-after-shift-closed] real Postgres · container {CONTAINER}")
    if subprocess.run(["docker", "inspect", CONTAINER], capture_output=True).returncode != 0:
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
    print("\nOK — the void books in the open shift; a closed shift keeps the number it was signed with")
    return 0


if __name__ == "__main__":
    sys.exit(main())
