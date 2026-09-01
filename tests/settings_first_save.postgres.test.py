#!/usr/bin/env python3
"""The drawer used to refuse its OWN first save, so it could never be configured (ERPlora/pm#165).

`cash_register_settings` is a singleton born from the Ajustes screen and nowhere else: no migration
seeds it and `cash_register.settings.get` returns `[]` on a fresh hub. So a first save that cannot
go through does not make the configuration "hard to change" — it makes it **impossible to create**,
and with it the whole opening/closing of the till.

That is what shipped. The schema marked all 8 properties `required` and gave none of them a
`default`. The shell's generic form builds its model as **row value > schema `default` > empty**
(`hub/apps/web/src/components/ModuleSettingsForm.vue`, `boot()`), so with no row and no defaults
every control started empty:

  · the six toggles at `false` — while the columns say `enable_cash_register` and
    `require_closing_balance` are ON, so the screen also LIED about the state of the till before
    anyone touched it;
  · `auto_close_time` at `''`, which is not one of the 24 values of its `enum` → the payload is
    refused and the save comes back **422 invalid_payload**;
  · `protected_pos_url` at `''`, which the schema WOULD accept — and which would have written an
    empty route into a NOT NULL column, quietly unlocking the POS the setting exists to protect.

Note where the refusal happens: **before** the SQL. `commands/settings_update.sql` already guards
`auto_close_time` with `COALESCE(NULLIF(:auto_close_time, ''), '04:00')`, but the runtime validates
the payload against this schema first, so that COALESCE never got a chance to run. The fix has to
be the schema's `default`, and it has to equal the column's `DEFAULT` or the screen promises a
value the database does not use.

Two layers, and NEITHER of them can go green by doing nothing:

  A. THE REFUSAL, with its negative control. The snapshot the form builds today is checked against
     the constraints this schema declares; then the same snapshot is rebuilt with the defaults
     STRIPPED — the exact shape of the bug — and must be REFUSED. A check that cannot show the bug
     is not a check. Layer A also refuses to run if the schema grows a validation keyword it does
     not implement, so it can never pass while silently ignoring a new constraint.

  B. THE SAVE, against a REAL Postgres built from this module's own migrations: the snapshot goes
     through `cash_register.settings.update` verbatim and the row has to land with the values the
     screen promised, `protected_pos_url` included.

Usage: tests/settings_first_save.postgres.test.py   (exit 0 = green)
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
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text(encoding="utf-8"))
SCHEMA = json.loads(
    (MODULE_DIR / MANIFEST["settings"]["schema"]).read_text(encoding="utf-8")
)
CONTAINER = os.environ.get("CASH_REGISTER_TEST_PG_CONTAINER", "erplora-test-pg-5433")
DB = f"cash_register_first_save_test_{os.getpid()}"
HUB = "hub-a"
USER = "u-owner"
NOW = "2026-09-01T09:00:00+00:00"

#: The DEFAULT of every column of `cash_register_settings`, read off the migrations that create it
#: (001_init, 005_require_blind_count, 006_auto_close). The schema's `default` has to match these
#: or a hub configured through the screen and a hub that never opened it disagree.
COLUMN_DEFAULTS = {
    "enable_cash_register": 1,
    "require_opening_balance": 0,
    "require_closing_balance": 1,
    "allow_negative_balance": 0,
    "require_blind_count": 0,
    "auto_close_enabled": 0,
    "auto_close_time": "04:00",
    "protected_pos_url": "/m/sales/pos/",
}

#: Everything Layer A knows how to apply. A schema that declares anything else stops the run
#: instead of passing while ignoring it.
UNDERSTOOD = {
    "type",
    "title",
    "description",
    "enum",
    "default",
    "maxLength",
    "minLength",
}

failures: list[str] = []


def fail(message: str) -> None:
    failures.append(message)
    print(f"  x {message}")


def ok(message: str) -> None:
    print(f"  . {message}")


def check(label: str, got: object, want: object) -> None:
    if got != want:
        fail(f"{label}: got {got!r}, want {want!r}")
    else:
        ok(label)


# ── the shell's own rules, mirrored ────────────────────────────────────────────────────────────
# `hub/apps/web/src/lib/module-settings.ts`. A module cannot import them, so they are restated
# here; they are three lines and they are what decides whether the first save is possible.


def is_stored_boolean(prop: dict) -> bool:
    if prop.get("type") == "boolean":
        return True
    enum = prop.get("enum") or []
    return prop.get("type") == "integer" and len(enum) == 2 and set(enum) == {0, 1}


def control(prop: dict) -> str:
    if is_stored_boolean(prop):
        return "toggle"
    if prop.get("enum"):
        return "select"
    if prop.get("type") in ("integer", "number"):
        return "number"
    return "text"


def form_snapshot(properties: dict) -> dict:
    """What `ModuleSettingsForm.boot()` puts in the payload on a hub with no settings row yet."""
    snapshot = {}
    for key, prop in properties.items():
        if "default" in prop:
            snapshot[key] = prop["default"]
        else:
            snapshot[key] = False if control(prop) == "toggle" else ""
    return snapshot


def refusals(payload: dict) -> list[str]:
    """The constraints of THIS schema, applied the way the runtime applies them before the SQL."""
    properties = SCHEMA["properties"]
    problems = []
    for key in SCHEMA.get("required", []):
        if key not in payload:
            problems.append(f"`{key}` is required and absent")
    for key, value in payload.items():
        prop = properties.get(key)
        if prop is None:
            problems.append(
                f"`{key}` is not declared and `additionalProperties` is false"
            )
            continue
        kind = prop.get("type")
        if kind == "boolean" and not isinstance(value, bool):
            problems.append(f"`{key}` must be a boolean, got {value!r}")
        if kind == "integer" and not (
            isinstance(value, int) and not isinstance(value, bool)
        ):
            problems.append(f"`{key}` must be an integer, got {value!r}")
        if kind == "string" and not isinstance(value, str):
            problems.append(f"`{key}` must be a string, got {value!r}")
        if prop.get("enum") is not None and value not in prop["enum"]:
            problems.append(f"`{key}`={value!r} is not one of {prop['enum']}")
        if prop.get("maxLength") is not None and isinstance(value, str):
            if len(value) > prop["maxLength"]:
                problems.append(f"`{key}` is longer than {prop['maxLength']}")
        if prop.get("minLength") is not None and isinstance(value, str):
            if len(value) < prop["minLength"]:
                problems.append(f"`{key}` is shorter than {prop['minLength']}")
    return problems


# ── Postgres plumbing (same shape as tests/mixed_payment_arqueo.postgres.test.py) ──────────────


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


def literal(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def bind(sql: str, params: dict) -> str:
    return re.sub(
        r"(?<!:):([a-z_][a-z0-9_]*)",
        lambda m: literal(params.get(m.group(1))),
        sql,
        flags=re.IGNORECASE,
    )


# ── layer A ───────────────────────────────────────────────────────────────────────────────────


def check_the_refusal() -> dict:
    print("A. the payload the screen builds on a brand-new hub")
    properties = SCHEMA["properties"]

    unknown = {k for p in properties.values() for k in p} - UNDERSTOOD
    if unknown:
        fail(
            f"the schema declares {sorted(unknown)}, which this check does not apply — it would "
            "pass while ignoring a real constraint; teach `refusals()` about it"
        )

    snapshot = form_snapshot(properties)
    problems = refusals(snapshot)
    if problems:
        fail(f"the first save is still refused: {'; '.join(problems)}")
    else:
        ok(f"the {len(snapshot)} values the form proposes are accepted as they stand")

    # The negative control: the same form, on the schema as it shipped before the fix.
    stripped = {
        k: {i: j for i, j in p.items() if i != "default"} for k, p in properties.items()
    }
    if not refusals(form_snapshot(stripped)):
        fail(
            "with the defaults stripped the payload is STILL accepted — this check cannot show "
            "the bug it exists for, so its green means nothing"
        )
    else:
        ok(
            "with the defaults stripped the same form is refused (the bug is reproducible)"
        )

    # And the values have to be the column's, not merely present.
    for key, want in COLUMN_DEFAULTS.items():
        got = properties[key].get("default")
        got = (1 if got else 0) if isinstance(got, bool) else got
        check(f"`{key}` default equals the column DEFAULT", got, want)

    return snapshot


# ── layer B ───────────────────────────────────────────────────────────────────────────────────


def check_the_save(snapshot: dict) -> None:
    print("B. that payload, through the real command, against a real Postgres")
    if (
        subprocess.run(["docker", "inspect", CONTAINER], capture_output=True).returncode
        != 0
    ):
        fail(
            f"container `{CONTAINER}` is not reachable — start it, do not skip this battery"
        )
        return

    psql(["-c", f'CREATE DATABASE "{DB}"'])
    try:
        for rel in MANIFEST["migrations"]["postgres"]:
            psql([], db=DB, stdin=(MODULE_DIR / rel).read_text(encoding="utf-8"))

        params = dict(snapshot)
        params.update(
            hub_id=HUB, current_user_id=USER, now=NOW, new_id=str(uuid.uuid4())
        )
        sql = (
            MODULE_DIR / MANIFEST["commands"]["cash_register.settings.update"]["sql"][0]
        ).read_text(encoding="utf-8")
        psql([], db=DB, stdin="BEGIN;\n" + bind(sql, params) + "\nCOMMIT;")

        columns = ", ".join(COLUMN_DEFAULTS)
        raw = psql(
            [
                "-t",
                "-A",
                "-F",
                "\x1f",
                "-c",
                f"SELECT {columns} FROM cash_register_settings WHERE hub_id = '{HUB}'",
            ],
            db=DB,
        ).strip()
        if not raw:
            fail(
                "the first save wrote NO row — the screen still cannot configure the drawer"
            )
            return
        ok("the first save created the singleton row")

        row = dict(zip(COLUMN_DEFAULTS, raw.split("\x1f")))
        for key, want in COLUMN_DEFAULTS.items():
            got = row[key] if isinstance(want, str) else int(row[key])
            check(f"`{key}` landed as the screen promised", got, want)
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'])


def main() -> int:
    snapshot = check_the_refusal()
    print()
    check_the_save(snapshot)
    print()
    if failures:
        print(
            f"FAILED — {len(failures)} problem(s): the drawer cannot be configured on a new hub"
        )
        for f in failures:
            print(f"  - {f}")
        return 1
    print(
        "PASS — a brand-new hub can save the cash drawer settings on the first try, and the row "
        "it writes carries the values the screen showed."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
