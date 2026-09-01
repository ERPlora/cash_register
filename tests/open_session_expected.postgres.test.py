#!/usr/bin/env python3
"""The EXPECTED cash exists while the session is OPEN (cash_register#65).

`cash_register.sessions.list` is the query that feeds the Cash grid. Until this battery it only
SELECTed the stored `expected_balance` column, which `session.close` is the one that writes — so
every OPEN session came back with `expected_balance: null` and the grid printed «—» in the
ESPERADO column for the whole shift. The number existed (`cash_register.current_session` computes
it live), just not where the screen reads from: the manager could not see what the drawer should
hold at any point BEFORE closing, which is exactly when the figure is worth something.

The market treats the running expected as shift information, not a closing artefact: Square shows
"Expected in drawer" on the open drawer, Toast shows it in Shift Review, Lightspeed in Cash
management. Blind counting is achieved by HIDING it (the `require_blind_count` setting,
cash_register#24), never by leaving the column empty for everybody.

What this file pins, against a REAL Postgres built from the module's own migrations:

  1. An OPEN session carries a live `expected_balance` = opening float + Σ cash movements.
  2. It carries NOTHING it has not earned: `closing_balance` and `difference` stay NULL until the
     count is declared (that is the audit trail — nothing is invented for the open row).
  3. The drawer is PHYSICAL cash: a card movement does not move the expected.
  4. The SIGN is server-authoritative (cash_register#48): an `out` stored POSITIVE still subtracts.
  5. `require_blind_count = 1` puts the open row's expected back to NULL — the blind count survives
     this change, same rule the guard query already applies.
  6. A CLOSED session keeps showing the STORED number, not a recomputation: that column is the
     audited figure the difference was computed against and it must never drift.
  7. Every session still comes back exactly once — the expected is a correlated subquery, not a
     JOIN that would multiply a session by its movements and corrupt the pager's total.

Usage: tests/open_session_expected.postgres.test.py   (exit 0 = green)
  Uses the `erplora-test-pg-5433` container (override: CASH_REGISTER_TEST_PG_CONTAINER) and drops
  its scratch database at the end, pass or fail.
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

# The public commands are WASM handlers; this file drives the SQL they resolve to, with the ids the
# handler would have handed over (cash_register#38/#49 — opening is counter + insert).
SQL_OF = {
    "cash_register.session.open": [
        "cash_register._bump_counter",
        "cash_register._open_session_insert",
    ],
    "cash_register.session.close": "cash_register._close_session_apply",
    "cash_register.movement.add": "cash_register._movement_insert",
}

CONTAINER = os.environ.get("CASH_REGISTER_TEST_PG_CONTAINER", "erplora-test-pg-5433")
DB = f"cash_register_open_expected_test_{os.getpid()}"
HUB = "hub-a"
OTHER_HUB = "hub-b"
USER = "u-manager"
LIST_QUERY = "cash_register.sessions.list"
SETTING = "require_blind_count"

failures: list[str] = []


def fail(message: str) -> None:
    failures.append(message)
    print(f"  FAIL: {message}")


def ok(label: str) -> None:
    print(f"  ok: {label}")


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


def literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def bind(sql: str, params: dict) -> str:
    return re.sub(
        r":([a-z_][a-z0-9_]*)",
        lambda m: literal(params.get(m.group(1))),
        sql,
        flags=re.IGNORECASE,
    )


def system_params(payload: dict, hub: str = HUB) -> dict:
    params = dict(payload)
    params.setdefault("hub_id", hub)
    params.setdefault("current_user_id", USER)
    params.setdefault("now", "2026-08-25T10:00:00Z")
    params.setdefault("new_id", str(uuid.uuid4()))
    params.setdefault("session_id", params["new_id"])
    params.setdefault("movement_id", params["new_id"])
    params.setdefault("day", "20260825")
    params.setdefault("session_day", "260825")
    return params


def run_command(name: str, payload: dict, hub: str = HUB) -> None:
    names = SQL_OF.get(name, name)
    names = [names] if isinstance(names, str) else list(names)
    sql_files = [rel for n in names for rel in MANIFEST["commands"][n]["sql"]]
    params = system_params(payload, hub)
    script = (
        ["BEGIN;"]
        + [bind((MODULE_DIR / rel).read_text(), params) for rel in sql_files]
        + ["COMMIT;"]
    )
    psql([], db=DB, stdin="\n".join(script))


def run_query(name: str, payload: dict | None = None, hub: str = HUB) -> list[dict]:
    q = MANIFEST["queries"][name]
    sql = bind((MODULE_DIR / q["sql"]).read_text(), system_params(payload or {}, hub))
    sql = sql.rstrip().rstrip(";")
    out = psql(
        [
            "-tA",
            "-c",
            f"SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM ({sql}) t",
        ],
        db=DB,
    )
    return json.loads(out.strip() or "[]")


def row_of(session_id: str, hub: str = HUB) -> dict:
    rows = [r for r in run_query(LIST_QUERY, hub=hub) if r.get("id") == session_id]
    if len(rows) != 1:
        fail(
            f"session {session_id} came back {len(rows)} time(s) from {LIST_QUERY} — expected exactly 1"
        )
        return rows[0] if rows else {}
    return rows[0]


def add_movement(
    session_id: str,
    movement_type: str,
    amount: int,
    method: str = "cash",
    hub: str = HUB,
) -> None:
    run_command(
        "cash_register.movement.add",
        {
            "session_id": session_id,
            "movement_type": movement_type,
            "amount": amount,
            "payment_method": method,
            "payment_method_type": method,
            "sale_reference": "",
            "description": "",
        },
        hub=hub,
    )


def settings_payload(**overrides) -> dict:
    base = {
        "enable_cash_register": True,
        "require_opening_balance": False,
        "require_closing_balance": True,
        "allow_negative_balance": False,
        "protected_pos_url": "/m/sales/pos/",
        SETTING: False,
    }
    base.update(overrides)
    return base


def run_list_engine(
    sort: str | None = None,
    dir_: str = "asc",
    filters: dict | None = None,
    hub: str = HUB,
) -> list[dict]:
    """`sessions.list` AS THE RUNTIME RUNS IT — the paginated wrapper of `crates/runtime/src/queries.rs`.

    `expected_balance` stopped being a stored column and became a computed one, and the manifest
    declares it sortable AND range-filterable. The engine wraps the base SELECT as a derived table
    and puts `ORDER BY sub.<col>` / `sub.<col> >= :f_<col>_from` on the OUTER query, so an alias
    works — but only if the base really exposes it. Asserting on the raw SELECT alone would leave
    the pager and the filters untested, and those are what the screen actually calls.
    """
    base = bind(
        (MODULE_DIR / MANIFEST["queries"][LIST_QUERY]["sql"]).read_text(),
        system_params({}, hub),
    )
    base = base.rstrip().rstrip(";").rstrip()
    conds = []
    for col, rng in (filters or {}).items():
        if rng.get("from") is not None:
            conds.append(f"sub.{col} >= {rng['from']}")
        if rng.get("to") is not None:
            conds.append(f"sub.{col} <= {rng['to']}")
    where = f" WHERE {' AND '.join(conds)}" if conds else ""
    order = f" ORDER BY sub.{sort} {dir_}" if sort else ""
    sql = f"SELECT sub.*, COUNT(*) OVER() AS _total FROM ( {base} ) AS sub{where}{order} LIMIT 50 OFFSET 0"
    out = psql(
        [
            "-tA",
            "-c",
            f"SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM ({sql}) t",
        ],
        db=DB,
    )
    return json.loads(out.strip() or "[]")


def check_against_postgres() -> None:
    if (
        subprocess.run(["docker", "inspect", CONTAINER], capture_output=True).returncode
        != 0
    ):
        fail(
            f"container `{CONTAINER}` is not running — this can only be proven against Postgres"
        )
        return

    psql(["-c", f'CREATE DATABASE "{DB}"'])
    try:
        for rel in MANIFEST["migrations"]["postgres"]:
            psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
        ok("migrations apply on a clean Postgres")

        # ── 1/2 · the shift of the issue: 150,00 € float + four cash sales = 101,30 € ───────────
        run_command("cash_register.session.open", {"opening_balance": 15_000})
        sid = run_query("cash_register.current_session")[0]["id"]
        for cents in (9650, 150, 160, 170):
            add_movement(sid, "sale", cents)

        row = row_of(sid)
        if row.get("expected_balance") != 25_130:
            fail(
                "an OPEN session must carry the live expected (150,00 € + 101,30 € = 251,30 € = 25130), "
                f"got expected_balance={row.get('expected_balance')!r} — the grid prints «—» all shift"
            )
        else:
            ok("open session → expected_balance = 25130 (float + cash movements)")

        if row.get("closing_balance") is not None or row.get("difference") is not None:
            fail(
                "an OPEN session must NOT carry counted/difference (nothing is invented before the "
                f"count is declared), got closing_balance={row.get('closing_balance')!r} "
                f"difference={row.get('difference')!r}"
            )
        else:
            ok("open session → counted/difference still NULL (nothing invented)")

        # ── 3 · the drawer is PHYSICAL cash: a card movement does not move it ───────────────────
        add_movement(sid, "sale", 5_000, method="card")
        if row_of(sid).get("expected_balance") != 25_130:
            fail(
                "a CARD sale moved the expected cash — the drawer only holds physical cash "
                f"(got {row_of(sid).get('expected_balance')!r}, expected 25130)"
            )
        else:
            ok("card sale → expected unchanged (drawer = physical cash)")

        # ── 4 · the SIGN comes from the KIND, not from how the row was stored (#48) ─────────────
        add_movement(sid, "out", 2_000)  # magnitude, sent POSITIVE on purpose
        if row_of(sid).get("expected_balance") != 23_130:
            fail(
                "an `out` stored POSITIVE must still SUBTRACT (sign is server-authoritative, #48): "
                f"expected 23130, got {row_of(sid).get('expected_balance')!r}"
            )
        else:
            ok("`out` stored positive → subtracts (23130)")

        # ── 7 · one row per session, always (a JOIN would multiply it by its movements) ─────────
        rows = run_query(LIST_QUERY)
        if len([r for r in rows if r.get("id") == sid]) != 1:
            fail(
                f"the session appears {len(rows)} times — the pager's total would be a lie"
            )
        else:
            ok("one row per session (6 movements did not multiply it)")

        # ── the grid and the live widget must say the SAME number ───────────────────────────────
        # Three places now compute this: the grid (here), the KPI widget (`current_session`) and the
        # close (`close_session.sql`). Copies of a formula drift — the widget already drifted once
        # (double negation on `out`/`refund`, fixed in cash_register#48) and the screen said one
        # thing while the close said another, which is how docs/limits.md ended up telling people
        # not to trust the dashboard. If they ever disagree again, this fails.
        live = run_query("cash_register.current_session")
        if not live or live[0].get("expected_total") != row_of(sid).get(
            "expected_balance"
        ):
            fail(
                "the grid and the live widget disagree on the expected cash: "
                f"list={row_of(sid).get('expected_balance')!r} widget={live[0].get('expected_total') if live else None!r}"
            )
        else:
            ok("grid and live widget agree on the expected (same formula, no drift)")

        # ── the LIST ENGINE · the computed column still sorts and filters ───────────────────────
        # The manifest declares `expected_balance` sortable and range-filterable, and the screen
        # uses both. A computed column that the pager cannot ORDER BY would turn the whole grid
        # into a 500 the moment somebody clicks the header.
        by_expected = run_list_engine(sort="expected_balance", dir_="desc")
        if not by_expected or by_expected[0].get("id") != sid:
            fail(f"ORDER BY the computed expected did not work, got {by_expected!r}")
        else:
            ok(
                "the pager sorts by the computed expected (ORDER BY sub.expected_balance)"
            )

        hit = run_list_engine(
            filters={"expected_balance": {"from": 23_000, "to": 23_500}}
        )
        if [r.get("id") for r in hit] != [sid]:
            fail(
                f"the range filter on the computed expected did not select the open session, got {hit!r}"
            )
        elif hit[0].get("_total") != 1:
            fail(
                f"the pager's total must count the filtered rows, got _total={hit[0].get('_total')!r}"
            )
        else:
            ok(
                "the range filter selects on the computed expected, and `_total` counts it"
            )

        miss = run_list_engine(filters={"expected_balance": {"from": 90_000}})
        if miss:
            fail(f"a range that excludes the session still returned it: {miss!r}")
        else:
            ok("a range that excludes it returns nothing (the filter really filters)")

        # ── tenancy · another hub never sees this session ───────────────────────────────────────
        if any(r.get("id") == sid for r in run_query(LIST_QUERY, hub=OTHER_HUB)):
            fail(
                f"hub `{OTHER_HUB}` can read hub `{HUB}`'s session through {LIST_QUERY}"
            )
        else:
            ok("another hub sees nothing (hub_id still scopes the list)")

        # ── 5 · blind count still wins ──────────────────────────────────────────────────────────
        run_command(
            "cash_register.settings.update", settings_payload(**{SETTING: True})
        )
        blind = row_of(sid)
        if blind.get("expected_balance") is not None:
            fail(
                f"{SETTING}=1 → the open row LEAKS expected_balance={blind.get('expected_balance')!r}; "
                "the person counting must not read what the drawer should hold"
            )
        else:
            ok(f"{SETTING}=1 → open row carries no expected (blind count survives)")
        if blind.get("id") != sid or blind.get("status") != "open":
            fail(f"{SETTING}=1 must hide the AMOUNT, not the session, got {blind!r}")

        run_command(
            "cash_register.settings.update", settings_payload(**{SETTING: False})
        )
        if row_of(sid).get("expected_balance") != 23_130:
            fail(
                f"{SETTING}=0 → the expected must come back, got {row_of(sid).get('expected_balance')!r}"
            )
        else:
            ok(f"{SETTING}=0 → expected back to 23130")

        # ── 6 · a CLOSED session echoes the STORED (audited) number, never a recomputation ──────
        run_command(
            "cash_register.session.close",
            {"session_id": sid, "closing_balance": 23_130, "closing_notes": ""},
        )
        closed = row_of(sid)
        if (
            closed.get("status") != "closed"
            or closed.get("expected_balance") != 23_130
            or closed.get("difference") != 0
        ):
            fail(f"the close must store expected=23130 / difference=0, got {closed!r}")
        else:
            ok("closed → expected/counted/difference reconciled (23130 / 23130 / 0)")

        # The audited column is the source of truth once closed: stamp a marker and the list must
        # echo it. A recomputation would quietly overwrite the number the difference was based on.
        psql(
            [
                "-c",
                f"UPDATE cash_register_session SET expected_balance = 111 WHERE id = '{sid}'",
            ],
            db=DB,
        )
        if row_of(sid).get("expected_balance") != 111:
            fail(
                "a CLOSED session must echo the STORED expected (the audited figure), got "
                f"{row_of(sid).get('expected_balance')!r} — the list is recomputing it and the "
                "stored difference no longer matches the expected it was computed against"
            )
        else:
            ok(
                "closed → the STORED expected is what the list returns (audit trail intact)"
            )
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'])


def main() -> int:
    print("[open session expected] real Postgres")
    check_against_postgres()
    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print(
        "\nOK — the expected cash is readable DURING the shift, blind count and audit intact"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
