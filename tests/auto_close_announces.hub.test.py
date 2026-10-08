#!/usr/bin/env python3
"""The automatic close announces ONE «caja cerrada» per session it closes — and nothing otherwise
(cash_register#145), against the REAL kernel.

The scheduled task `auto_close_sessions` runs every 5 minutes. It used to be a declarative command
with `"emit": ["cash_register.session_closed"]`, and the runtime writes a declared event once per
EXECUTION, whether the SQL closed anything or not, carrying the task's own payload (`{}`, no
`session_id`). A hub with the `flows` card «al cerrar la caja → crear una tarea» therefore got a new
task every 5 minutes (~288 a day) without a single drawer being closed. ERPlora/hub#2612 is the
kernel-side fix («emit only if this statement changed something»); until it exists, the task is a
WASM handler: it reads the sessions that are due, closes each one and returns one event per closed
session, with that session's id. A pass with nothing to close returns no event.

What this battery proves, through the scheduler itself (no direct call: an `_` command is not a
public door), with a psql session on the hub's database (`ERPLORA_HUB_PSQL`) to make the task due
right now and to read the outbox:

  1. A pass with NOTHING to close writes no `cash_register.session_closed` — the 288-a-day bug.
  2. A pass that closes a forgotten session writes EXACTLY ONE, whose payload names that session;
     the session is closed with no counted cash (nobody counted it) and its expected cash frozen.
  3. The next pass, with the drawer already closed, writes none — one announcement per real close.
  4. Tenancy: an open, stale session of ANOTHER hub in the same database is neither closed nor
     announced by this hub's task.

Usage: `erplora test <dir> --against-hub [dev|stable|sha256:…]` (module-toolkit#110). Never on its
own: without a runtime (or without the psql session) it fails, it does not skip.
"""

import json
import os
import shlex
import subprocess
import sys
import time
import uuid

import hub_harness
from hub_harness import Hub, close_session, open_session

EVENT = "cash_register.session_closed"
TASK = "auto_close_sessions"
# Long before any cut-off the task can compute: a session opened then is always «forgotten».
STALE_OPENED_AT = "2020-01-01T10:00:00+00:00"


def hub_psql(hub: Hub) -> list[str]:
    """The psql session on the database this hub writes to (`ERPLORA_HUB_PSQL`), or `[]`."""
    session = os.environ.get("ERPLORA_HUB_PSQL", "")
    if not session:
        hub.check_true(
            "a psql session on the hub's database", False, "ERPLORA_HUB_PSQL is empty"
        )
        return []
    return shlex.split(session)


def sql(psql: list[str], statement: str) -> str:
    out = subprocess.run(
        [*psql, "-tAc", statement], capture_output=True, text=True, check=False
    )
    if out.returncode != 0:
        raise AssertionError(
            f"psql failed ({out.returncode}): {out.stderr.strip()} — {statement}"
        )
    return out.stdout.strip()


def lit(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def announced(psql: list[str], hub_id: str) -> list[dict]:
    """Every `session_closed` this hub has written to its outbox, oldest first, as payloads."""
    raw = sql(
        psql,
        "SELECT COALESCE(json_agg(payload ORDER BY created_at, id), '[]') FROM _event_outbox "
        f"WHERE hub_id = {lit(hub_id)} AND event_name = {lit(EVENT)}",
    )
    return [json.loads(p) if isinstance(p, str) else p for p in json.loads(raw or "[]")]


def run_task_now(hub: Hub, psql: list[str], timeout: float = 30.0) -> None:
    """Makes the task due NOW and waits until the scheduler (a 1 s loop in the server) has run it.

    «Has run» is read off `last_run`, which the runtime advances in the SAME transaction as the
    command's effects and its outbox rows: once it moves, whatever the pass announced is already
    committed. A task that keeps failing never moves it — that times out loudly."""
    where = f"module_id = 'cash_register' AND name = {lit(TASK)}"
    before = sql(
        psql, f"SELECT COALESCE(last_run, '') FROM _scheduled_tasks WHERE {where}"
    )
    if sql(psql, f"SELECT count(*) FROM _scheduled_tasks WHERE {where}") != "1":
        raise AssertionError(f"the hub has no scheduled task cash_register/{TASK}")
    sql(
        psql,
        f"UPDATE _scheduled_tasks SET next_run = '2000-01-01T00:00:00Z', claim_expires_at = NULL WHERE {where}",
    )
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        after = sql(
            psql, f"SELECT COALESCE(last_run, '') FROM _scheduled_tasks WHERE {where}"
        )
        if after and after != before:
            return
        time.sleep(0.25)
    raise AssertionError(
        f"the scheduler did not run cash_register/{TASK} within {timeout}s"
    )


def turn_auto_close(hub: Hub, enabled: bool) -> None:
    """The whole settings snapshot (the update is an upsert of the full form). The drawer lock stays
    OFF so no other battery sharing this hub finds the POS blocked; the auto-close does not read it."""
    hub.run(
        "cash_register.settings.update",
        {
            "enable_cash_register": False,
            "require_opening_balance": False,
            "require_closing_balance": False,
            "allow_negative_balance": False,
            "require_blind_count": False,
            "auto_close_enabled": enabled,
            "auto_close_time": "04:00",
            "protected_pos_url": "/m/sales/pos/",
        },
    )


def session_row(psql: list[str], session_id: str) -> dict:
    raw = sql(
        psql,
        "SELECT row_to_json(s) FROM (SELECT status, closing_balance, expected_balance, opening_balance "
        f"FROM cash_register_session WHERE id = {lit(session_id)}) s",
    )
    return json.loads(raw) if raw else {}


def main() -> int:
    hub = Hub("auto_close_announces.hub")
    print(
        f"Hub battery · auto-close announces once per real close (cash_register#145) · "
        f"{hub_harness.BASE} · hub {hub.hub_id}"
    )
    psql = hub_psql(hub)
    if not psql:
        return hub.finish("unreachable")

    # The business rule is ONE open session per hub: a leftover of another battery is closed first,
    # through the same door a cashier uses, so the passes below only ever see what this one opens.
    for leftover in hub.query("cash_register.current_session"):
        close_session(hub, leftover["id"])

    foreign_hub = f"other-hub-{uuid.uuid4().hex[:8]}"
    foreign_id = f"foreign-{uuid.uuid4().hex[:8]}"
    turn_auto_close(hub, True)
    try:
        print("\n1 · a pass with nothing to close announces nothing")
        before = len(announced(psql, hub.hub_id))
        run_task_now(hub, psql)
        hub.check(
            "session_closed written by an empty pass",
            len(announced(psql, hub.hub_id)) - before,
            0,
        )

        print(
            "\n2 · a pass that closes a forgotten session announces it exactly once, by its id"
        )
        sid = open_session(hub, 10_000)
        hub.run(
            "cash_register.movement.add",
            {
                "session_id": sid,
                "movement_type": "in",
                "amount": 2_500,
                "payment_method": "cash",
                "description": "change",
            },
        )
        sql(
            psql,
            f"UPDATE cash_register_session SET opened_at = {lit(STALE_OPENED_AT)} WHERE id = {lit(sid)}",
        )
        # 4 · the same forgotten shape, but another hub's row in the same database.
        sql(
            psql,
            "INSERT INTO cash_register_session SELECT (jsonb_populate_record(NULL::cash_register_session, "
            f"to_jsonb(s) || jsonb_build_object('id', {lit(foreign_id)}, 'hub_id', {lit(foreign_hub)}, "
            f"'status', 'open', 'opened_at', {lit(STALE_OPENED_AT)}))).* "
            f"FROM cash_register_session s WHERE s.id = {lit(sid)}",
        )
        before = len(announced(psql, hub.hub_id))
        run_task_now(hub, psql)
        new = announced(psql, hub.hub_id)[before:]
        hub.check(
            "session_closed written by the pass that closed one session", len(new), 1
        )
        hub.check(
            "the announcement names the session it closed",
            [e.get("session_id") for e in new],
            [sid],
        )
        row = session_row(psql, sid)
        hub.check("the forgotten session is closed", row.get("status"), "closed")
        hub.check(
            "nobody counted it: no closing balance", row.get("closing_balance"), None
        )
        hub.check(
            "its expected cash is frozen (float + cash in)",
            hub_harness.cents(row.get("expected_balance")),
            12_500,
        )

        print(
            "\n3 · the next pass, with the drawer already closed, announces nothing more"
        )
        before = len(announced(psql, hub.hub_id))
        run_task_now(hub, psql)
        hub.check(
            "session_closed written after the drawer was already closed",
            len(announced(psql, hub.hub_id)) - before,
            0,
        )

        print(
            "\n4 · another hub's forgotten session is not this hub's to close or announce"
        )
        hub.check(
            "the other hub's session stays open",
            session_row(psql, foreign_id).get("status"),
            "open",
        )
        hub.check(
            "no announcement anywhere names the other hub's session",
            sql(
                psql,
                f"SELECT count(*) FROM _event_outbox WHERE event_name = {lit(EVENT)} AND payload LIKE {lit('%' + foreign_id + '%')}",
            ),
            "0",
        )
    finally:
        turn_auto_close(hub, False)
        sql(psql, f"DELETE FROM cash_register_session WHERE id = {lit(foreign_id)}")

    return hub.finish(
        "the automatic close announces each session it closes once, and nothing when it closes none"
    )


if __name__ == "__main__":
    sys.exit(main())
