#!/usr/bin/env python3
"""The till count adds up with the HUB currency, read from the hub's own settings (cash_register#111).

`cash_register.count.add` turns «5 notes of 1000» into a total on the server. Until #111 the WASM
handler scaled every denomination ×100 — euros — so a hub in yen booked 100 times too much and a hub
in Kuwaiti dinars ten times too little. The handler runs in a sandbox and cannot read the database,
so the scale reaches it the same way the drawer settings do (ADR-0069): a query the host preloads
into `context.reads`, never a number the client sends.

What this file pins, against a REAL Postgres:

  1. The manifest wires it: `cash_register.count.add` declares `cash_register.currency_scale` as a
     REQUIRED read — without it the handler silently falls back to euros.
  2. A hub that never set its currency still gets exactly ONE row (both fields empty): the handler
     reads «no currency row» as the runtime does — the hub is in euros.
  3. `currency` and the hand-declared `currency_decimals` come back as the hub stored them.
  4. TENANCY: each hub reads ITS OWN currency — hub B's dinars never reach hub A's count.

Usage: tests/currency_scale.postgres.test.py   (exit 0 = green)
  Uses the `erplora-test-pg-5433` container (override: CASH_REGISTER_TEST_PG_CONTAINER) and drops
  its scratch database at the end, pass or fail.
"""

import json
import os
import pathlib
import re
import subprocess
import sys

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text())

CONTAINER = os.environ.get("CASH_REGISTER_TEST_PG_CONTAINER", "erplora-test-pg-5433")
DB = f"cash_register_currency_scale_test_{os.getpid()}"
HUB = "hub-a"
OTHER_HUB = "hub-b"
QUERY = "cash_register.currency_scale"
COMMAND = "cash_register.count.add"

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
    return "'" + str(value).replace("'", "''") + "'"


def bind(sql: str, params: dict) -> str:
    return re.sub(
        r":([a-z_][a-z0-9_]*)",
        lambda m: literal(params.get(m.group(1))),
        sql,
        flags=re.IGNORECASE,
    )


def run_query(hub: str) -> list[dict]:
    sql = bind(
        (MODULE_DIR / MANIFEST["queries"][QUERY]["sql"]).read_text(), {"hub_id": hub}
    )
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


def set_hub_setting(key: str, value: str, hub: str) -> None:
    psql(
        [
            "-c",
            f"INSERT INTO hub_settings (hub_id, key, value) VALUES ('{hub}', '{key}', '{value}')",
        ],
        db=DB,
    )


def check_manifest() -> bool:
    if QUERY not in MANIFEST.get("queries", {}):
        fail(f"the manifest does not declare the query `{QUERY}`")
        return False
    reads = MANIFEST["commands"][COMMAND].get("reads", [])
    declared = [r for r in reads if r.get("query") == QUERY]
    if not declared or not declared[0].get("required"):
        fail(f"`{COMMAND}` must declare `{QUERY}` as a REQUIRED read, got {reads!r}")
    else:
        ok(f"`{COMMAND}` preloads `{QUERY}` (required)")
    return True


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
        # The core's settings table (hub/crates/runtime/src/settings.rs) — the hub creates it.
        psql(
            [
                "-c",
                "CREATE TABLE hub_settings (hub_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL DEFAULT '', "
                "updated_at TEXT, updated_by TEXT, PRIMARY KEY (hub_id, key))",
            ],
            db=DB,
        )

        rows = run_query(HUB)
        if rows != [{"currency": None, "currency_decimals": None}]:
            fail(
                f"a hub with no currency settings must read ONE empty row, got {rows!r}"
            )
        else:
            ok(
                "no currency settings → one row, both fields empty (the handler reads euros)"
            )

        set_hub_setting("currency", "JPY", HUB)
        set_hub_setting("currency", "KWD", OTHER_HUB)
        set_hub_setting("currency_decimals", "3", OTHER_HUB)

        a, b = run_query(HUB), run_query(OTHER_HUB)
        if a != [{"currency": "JPY", "currency_decimals": None}]:
            fail(f"hub A must read its own yen and no declared scale, got {a!r}")
        else:
            ok("hub A reads JPY, nothing declared by hand")
        if b != [{"currency": "KWD", "currency_decimals": "3"}]:
            fail(f"hub B must read its own dinars and its declared scale, got {b!r}")
        else:
            ok("hub B reads KWD and its hand-declared 3 decimals")
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'])


def main() -> int:
    print("[currency scale of the count] real Postgres")
    if check_manifest():
        check_against_postgres()
    if failures:
        print(f"\n{len(failures)} failure(s)")
        return 1
    print("\nOK — the count reads the hub's own currency, tenant by tenant")
    return 0


if __name__ == "__main__":
    sys.exit(main())
