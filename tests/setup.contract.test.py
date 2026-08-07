#!/usr/bin/env python3
"""Setup-block contract test (cash_register#17) — the checklist item this module declares.

`hub.setup.status` (hub#369, ADR-0222 — `architecture/hub/setup-status.md`) turned the onboarding
checklist into ONE query served by the runtime, and the `setup` block of `module.json` into the
module's half of that contract. Two consequences drive this file:

  * **A malformed `setup` is a malformed manifest.** The runtime no longer transports the block, it
    PARSES it (`crates/runtime/src/manifest.rs`, `SetupDef`), and `Manifest::load` is the first
    thing `installer::install` does. A wrong type here does not degrade a feature — it makes the
    published module impossible to install on ANY hub (exactly what tables#28 did with `catch_up`).
  * **A `setup` that parses can still be a lie.** The runtime runs `query`, takes the FIRST row and
    evaluates `configured_when` against it. If the query needs a param the block cannot supply, or
    never returns the fields the checks name, the item is silently OMITTED (best-effort, §5.3) and
    the user never sees the task. Nothing turns red anywhere — the item is simply missing.

So the three layers below check the block the way the runtime does, and the last one runs the
declared query against a REAL Postgres, with the module's own migrations and its own command:

  1. SHAPE — mirrors `SetupDef`: required fields, JSON types, exactly one of `truthy`/`equals` per
     check, the reserved `order` slot, the permission and the route resolving to things this
     manifest actually declares, and the English-canonical title having its `es` translation.
  2. CANONICAL JSON SCHEMA — the manifest validated against `hub/schemas/module.schema.json`
     ITSELF, the source of truth, no re-implementation. Unreachable is reported as SKIPPED.
  3. REAL POSTGRES — migrations applied to a scratch database, then the acceptance points of the
     item: a fresh hub reads PENDING, saving the cash settings reads DONE, and turning the drawer
     OFF still reads DONE (an item nobody can ever clear is worse than no item at all).

Usage: tests/setup.contract.test.py   (exit 0 = green)
  Layer 3 uses the `erplora-test-pg-5433` container (override: CASH_REGISTER_TEST_PG_CONTAINER)
  and drops its scratch database at the end, pass or fail.
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
MODULE_ID = "cash_register"

# The slot the CORE reserved for this module in the checklist scale (`setup-status.md` §6): the
# scale belongs to the core, the module takes the slot it was assigned. 90 = "your cash drawer",
# after the team (80) and before the tables/agenda (100).
RESERVED_ORDER = 90

# Params the runtime injects into every query (`system_params`, crates/runtime/src/lib.rs). A query
# that needs anything else cannot be a `setup` query unless the block supplies it in `params`:
# `cash_register.session.summary` is the live counter-example — it filters by `:session_id`, which
# no static block can know, so it would error and the item would vanish from the checklist.
SYSTEM_PARAMS = {
    "hub_id",
    "current_user_id",
    "now",
    "new_id",
    "business_tax_id",
    "business_legal_name",
    "business_address",
    "has_certificate",
}

CONTAINER = os.environ.get("CASH_REGISTER_TEST_PG_CONTAINER", "erplora-test-pg-5433")
DB = f"cash_register_setup_test_{os.getpid()}"
HUB = "hub-test"
USER = "u-admin"

failures: list[str] = []
warnings: list[str] = []
notes: list[str] = []

JSON_TYPE_NAME = {
    bool: "boolean",
    int: "number",
    float: "number",
    str: "string",
    list: "array",
    dict: "object",
    type(None): "null",
}


def fail(message: str) -> None:
    failures.append(message)
    print(f"  FAIL: {message}")


def ok(label: str) -> None:
    print(f"  ok: {label}")


def type_name(value) -> str:
    return JSON_TYPE_NAME.get(type(value), type(value).__name__)


def expect(path: str, value, kind) -> bool:
    """Assert the JSON type. `True`/`False` never pass as a number or a string: in Python `bool` is
    a subclass of `int`, in JSON it is a type of its own — and confusing the two is the bug class
    this file exists to catch."""
    good = isinstance(value, kind) and not (
        isinstance(value, bool) and kind is not bool
    )
    if not good:
        fail(
            f"setup.{path}: expected {kind.__name__}, got {type_name(value)} ({value!r})"
        )
    return good


# ── Layer 1: the shape, mirroring `SetupDef` ─────────────────────────────────────────────


def check_shape(setup: dict) -> None:
    # `query`, `configured_when`, `title` and `route` have no serde default: absent = the manifest
    # does not deserialize = the module does not install.
    for key, kind in (("query", str), ("title", str), ("route", str)):
        if key not in setup:
            fail(f"setup.{key}: missing, and the runtime requires it")
        else:
            expect(key, setup[key], kind)
            if isinstance(setup[key], str) and not setup[key].strip():
                fail(f"setup.{key}: empty")

    for key, kind in (
        ("description", str),
        ("icon", str),
        ("permission", str),
        ("params", dict),
        ("countries", list),
        ("required", bool),
        ("order", int),
    ):
        if key in setup:
            expect(key, setup[key], kind)

    for i, country in enumerate(setup.get("countries", [])):
        if not (isinstance(country, str) and re.fullmatch(r"[A-Za-z]{2}", country)):
            fail(f"setup.countries[{i}]: {country!r} is not an ISO-3166-1 alpha-2 code")

    # The key is NEVER declared: the core derives it as `<module_id>.setup` so that a manifest
    # cannot rename itself out of the core-owned ⛔ list (hub#370).
    if "key" in setup:
        fail(
            "setup.key: not a field of the contract — the core derives it as `<id>.setup`"
        )

    if setup.get("order") != RESERVED_ORDER:
        fail(
            f"setup.order: {setup.get('order')!r}, but the core reserved slot {RESERVED_ORDER} for "
            f"this module (setup-status.md §6). Absent = 500, behind everything the core placed."
        )
    else:
        ok(f"order = {RESERVED_ORDER}, the slot the core reserved")

    # 🟡 recommended: a shop can sell all day without ever opening a drawer, so this item must not
    # nag as if it were 🔴. `required` NEVER maps to ⛔ — that list is core-owned.
    if setup.get("required") is not False:
        fail(
            "setup.required: must be false — slot 90 is 🟡 recommended, not 🔴 functional"
        )
    else:
        ok("required = false (🟡 recommended)")

    check_configured_when(setup.get("configured_when"))


def check_configured_when(checks) -> None:
    if checks is None:
        fail("setup.configured_when: missing, and the runtime requires it")
        return
    if not expect("configured_when", checks, list):
        return
    if not checks:
        fail(
            "setup.configured_when: empty — the runtime would then tick the item done on the mere "
            "presence of a row, with nothing written down about what 'configured' means"
        )
    for i, check in enumerate(checks):
        path = f"configured_when[{i}]"
        if not expect(path, check, dict):
            continue
        if not isinstance(check.get("field"), str) or not check["field"].strip():
            fail(f"setup.{path}.field: missing or not a string")
        has = [k for k in ("truthy", "equals") if k in check]
        if len(has) != 1:
            # `passes()` returns false when neither is set, and it is deliberate: a half-written
            # contract must never tick an item as done.
            fail(
                f"setup.{path}: exactly one of `truthy`/`equals` is required, found {has or 'none'}"
                " — a check with neither NEVER passes, so the item would stay pending forever"
            )
        if "truthy" in check:
            expect(f"{path}.truthy", check["truthy"], bool)
        for extra in sorted(set(check) - {"field", "truthy", "equals"}):
            fail(
                f"setup.{path}.{extra}: unknown key (the canonical schema forbids extras)"
            )


def check_query_is_runnable(setup: dict) -> None:
    """The query is the module's OWN, it is declared, and the block can supply every param it
    needs. A query that errors makes the item vanish — silently, by design (best-effort)."""
    name = setup.get("query")
    if not isinstance(name, str):
        return
    if not name.startswith(f"{MODULE_ID}."):
        fail(f"setup.query: {name!r} does not belong to this module")
    qdef = MANIFEST.get("queries", {}).get(name)
    if qdef is None:
        fail(f"setup.query: {name!r} is not declared in `queries`")
        return
    ok(f"query {name} is declared by this module")

    sql_path = MODULE_DIR / qdef["sql"]
    if not sql_path.exists():
        fail(
            f"setup.query: {name!r} declares `{qdef['sql']}`, which is not in the package"
        )
        return

    sql = strip_comments(sql_path.read_text())
    needed = set(re.findall(r":([a-z_][a-z0-9_]*)", sql, re.IGNORECASE))
    missing = needed - SYSTEM_PARAMS - set(setup.get("params", {}))
    if missing:
        fail(
            f"setup.query: {name!r} needs {sorted(missing)}, which neither the runtime injects nor "
            f"`setup.params` supplies — the query would error and the ITEM WOULD BE OMITTED"
        )
    else:
        ok("the query needs no param the setup block cannot supply")

    # Every field the checks name must be selected by the query. Layer 3 proves it against a real
    # database; this is the cheap version that also runs when Docker is not around.
    for check in setup.get("configured_when", []):
        field = check.get("field") if isinstance(check, dict) else None
        if isinstance(field, str) and not re.search(rf"\b{re.escape(field)}\b", sql):
            fail(f"setup.configured_when: `{field}` does not appear in {qdef['sql']}")


def strip_comments(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def check_route_and_permission(setup: dict) -> None:
    route = setup.get("route")
    if isinstance(route, str):
        # `/m/:moduleId/:navId?` (hub/apps/web/src/router/index.ts). The shell injects a synthetic
        # `settings` tab for a module that declares the `settings` block without a component, so
        # that id is a valid destination too.
        nav_ids = {e.get("id") for e in MANIFEST.get("navigation", [])}
        if "settings" in MANIFEST:
            nav_ids.add("settings")
        parts = route.strip("/").split("/")
        if parts[:1] != ["m"] or len(parts) < 2 or parts[1] != MODULE_ID:
            fail(
                f"setup.route: {route!r} is not a `/m/{MODULE_ID}/…` screen of this module"
            )
        elif len(parts) > 2 and parts[2] not in nav_ids:
            fail(
                f"setup.route: {route!r} points at the tab {parts[2]!r}, which this manifest does "
                f"not declare (known: {sorted(nav_ids)}) — a task with a dead route"
            )
        else:
            ok(f"route {route} resolves to a screen this manifest declares")

    permission = setup.get("permission")
    if isinstance(permission, str) and permission:
        if permission not in MANIFEST.get("permissions", []):
            fail(f"setup.permission: {permission!r} is not declared in `permissions`")
        # The permission of CONFIGURING, deliberately narrower than the one to READ the query:
        # whoever only looks must not be handed a task they cannot complete. So it has to be the
        # one the command behind the route requires.
        writers = {
            name
            for name, c in MANIFEST.get("commands", {}).items()
            if c.get("permission") == permission
        }
        if not writers:
            fail(
                f"setup.permission: {permission!r} gates no command — the item would be offered to "
                f"people who cannot complete it"
            )
        else:
            ok(
                f"permission {permission} gates {len(writers)} command(s) behind the route"
            )


def check_i18n(setup: dict) -> None:
    """English is the canonical source and every visible string ships its `es` (ADR-0055). The
    `title` that travels in the response is the fallback the shell translates over."""
    for lang in ("en", "es"):
        path = MODULE_DIR / "locales" / f"{lang}.json"
        if not path.exists():
            fail(f"locales/{lang}.json: missing")
            continue
        block = json.loads(path.read_text()).get("setup")
        if not isinstance(block, dict):
            fail(
                f"locales/{lang}.json: no `setup` block — the item's title would never translate"
            )
            continue
        for key in ("title", "description"):
            if not isinstance(block.get(key), str) or not block[key].strip():
                fail(f"locales/{lang}.json: setup.{key} missing or empty")

    en = json.loads((MODULE_DIR / "locales" / "en.json").read_text()).get("setup", {})
    es = json.loads((MODULE_DIR / "locales" / "es.json").read_text()).get("setup", {})
    if (
        isinstance(en, dict)
        and en.get("title")
        and en.get("title") != setup.get("title")
    ):
        fail(
            f"locales/en.json: setup.title {en.get('title')!r} does not match the manifest "
            f"{setup.get('title')!r} — the manifest string IS the English source"
        )
    if isinstance(es, dict) and es.get("title") and es.get("title") == en.get("title"):
        fail(
            "locales/es.json: setup.title is still the English string, not a translation"
        )
    if not failures:
        ok("title/description are English-canonical with their `es` translation")


# ── Layer 2: the canonical JSON Schema, when it is reachable ─────────────────────────────


def canonical_schema() -> tuple[dict, str] | None:
    """`hub/schemas/module.schema.json`, preferring a copy that already knows about hub#369.

    The dev workspace keeps the hub checkout on whatever branch its own work needs, so the working
    tree may predate the `countries`/`order` fields — and since the schema declares
    `additionalProperties: false`, validating against a stale copy would fail this module for
    declaring exactly what the contract now asks for. Detect that and ask git for the branch that
    carries the contract instead of quietly reporting the wrong answer."""
    hub = pathlib.Path(os.environ.get("ERPLORA_HUB_DIR", MODULE_DIR.parents[2] / "hub"))
    override = os.environ.get("ERPLORA_MODULE_SCHEMA")
    candidates: list[tuple[str, str]] = []

    if override:
        candidates.append((override, pathlib.Path(override).read_text()))
    working = hub / "schemas" / "module.schema.json"
    if working.exists():
        candidates.append((str(working), working.read_text()))
    for ref in ("origin/develop", "origin/main"):
        res = subprocess.run(
            ["git", "-C", str(hub), "show", f"{ref}:schemas/module.schema.json"],
            capture_output=True,
            text=True,
        )
        if res.returncode == 0:
            candidates.append((f"{hub}@{ref}", res.stdout))

    for source, raw in candidates:
        schema = json.loads(raw)
        setup = schema.get("properties", {}).get("setup", {}).get("properties", {})
        if "order" in setup and "countries" in setup:
            return schema, source
    # Every copy predates hub#369. Validating against one would be a FALSE RED — `countries` and
    # `order` do not exist there and the block is `additionalProperties: false` — so this layer
    # reports SKIPPED and says why. Never a silent green, never a red for being right.
    return None


def check_against_canonical_schema() -> None:
    try:
        import jsonschema
    except ImportError:
        notes.append("SKIPPED canonical schema: `jsonschema` is not installed")
        return

    found = canonical_schema()
    if found is None:
        notes.append(
            "SKIPPED canonical schema: no copy of hub/schemas/module.schema.json that knows about "
            "hub#369 (`setup.countries`/`setup.order`). The contract lives on the hub's `develop` "
            "branch, NOT on `main`: point ERPLORA_MODULE_SCHEMA at it, or ERPLORA_HUB_DIR at a hub "
            "checkout whose origin/develop is fetched"
        )
        return

    schema, source = found
    notes.append(f"canonical schema applied: {source}")

    # The `setup` subtree is what this file owns, and it is strict: `additionalProperties: false`,
    # so a typo'd key fails HERE instead of shipping a manifest the installer refuses.
    setup_schema = schema.get("properties", {}).get("setup")
    if isinstance(setup_schema, dict):
        for err in sorted(
            jsonschema.Draft202012Validator(setup_schema).iter_errors(
                MANIFEST["setup"]
            ),
            key=lambda e: list(e.absolute_path),
        ):
            where = "/".join(str(p) for p in err.absolute_path) or "<setup>"
            fail(f"[schema] setup/{where}: {err.message}")
        ok("the setup block validates against the canonical schema")

    # The rest of the manifest is validated too, but as a WARNING: this is the setup-block test,
    # and the blocks around it have their own drift. Today the only hit is `protects` (ADR-0130,
    # `architecture/hub/route-guards-and-subroutes.md`), a real and documented block that the hub
    # schema never grew — a gap in the hub, not something this module can fix from here.
    validator = jsonschema.Draft202012Validator(schema)
    for err in sorted(
        validator.iter_errors(MANIFEST), key=lambda e: list(e.absolute_path)
    ):
        path = list(err.absolute_path)
        if path[:1] == ["setup"]:
            continue  # already reported, strictly, above
        where = "/".join(str(p) for p in path) or "<root>"
        warnings.append(f"[schema] {where}: {err.message}")


# ── Layer 3: the item's acceptance points, against a real Postgres ───────────────────────


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
        return (
            "1" if value else "0"
        )  # flags are INTEGER 0/1 (ADR-0007), never a Postgres boolean
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def bind(sql: str, params: dict) -> str:
    """One pass over the `:name` placeholders, like the driver: a value that itself contains a
    colon (an ISO timestamp) must never be rescanned. An absent param binds as NULL."""
    return re.sub(
        r":([a-z_][a-z0-9_]*)",
        lambda m: literal(params.get(m.group(1))),
        sql,
        flags=re.IGNORECASE,
    )


def run_setup_query(setup: dict) -> list[dict]:
    qdef = MANIFEST["queries"][setup["query"]]
    sql = (MODULE_DIR / qdef["sql"]).read_text().strip().rstrip(";")
    params = dict(setup.get("params", {}))
    params.setdefault("hub_id", HUB)
    out = psql(["-tAc", f"SELECT row_to_json(r) FROM ({bind(sql, params)}) r"], db=DB)
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def run_command(name: str, payload: dict) -> None:
    """The module's own command, exactly as the runtime runs it: every statement of `sql[]` in ONE
    transaction with the system params bound. This is what the settings screen does."""
    cmd = MANIFEST["commands"][name]
    params = dict(payload)
    params.setdefault("hub_id", HUB)
    params.setdefault("current_user_id", USER)
    params.setdefault("now", "2026-08-07T10:00:00Z")
    script = ["BEGIN;"]
    for rel in cmd["sql"]:
        stmt = dict(params, new_id=str(uuid.uuid4()))
        script.append(bind((MODULE_DIR / rel).read_text(), stmt))
    script.append("COMMIT;")
    psql([], db=DB, stdin="\n".join(script))


# The runtime's evaluator in miniature (`setup_status::passes`/`truthy`/`as_text`): loosely false is
# null, empty, 0, false — and the STRINGS "0"/"false", because a flag crossing a text column arrives
# spelled out.
def truthy(value) -> bool:
    if value is None or value is False:
        return False
    if value is True:
        return True
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        s = value.strip()
        return bool(s) and s != "0" and s.lower() != "false"
    return bool(value)


def as_text(value) -> str:
    if value is None:
        return ""
    return value if isinstance(value, str) else json.dumps(value)


def is_configured(rows: list[dict], checks: list[dict]) -> bool:
    if not rows:
        return False  # ADR-0063: no row, not configured
    row = rows[0]
    for check in checks:
        value = row.get(check["field"])
        if "truthy" in check:
            if truthy(value) != check["truthy"]:
                return False
        elif "equals" in check:
            if as_text(value) != as_text(check["equals"]):
                return False
        else:
            return False
    return True


SETTINGS_SNAPSHOT = {
    "enable_cash_register": True,
    "require_opening_balance": True,
    "require_closing_balance": True,
    "allow_negative_balance": False,
    "auto_open_session_on_login": True,
    "auto_close_session_on_logout": True,
    "protected_pos_url": "/m/sales/pos/",
}


def check_against_postgres(setup: dict) -> None:
    if (
        subprocess.run(["docker", "inspect", CONTAINER], capture_output=True).returncode
        != 0
    ):
        notes.append(f"SKIPPED live check: container `{CONTAINER}` is not running")
        return
    if setup.get("query") not in MANIFEST.get("queries", {}):
        notes.append("SKIPPED live check: the setup query is not declared")
        return

    checks = setup.get("configured_when", [])
    psql(["-c", f'CREATE DATABASE "{DB}"'])
    try:
        # Exactly what `installer::install` does, in its order: migrations, then the module's own
        # seed for this dialect. Anything either of them creates is there BEFORE the user does a
        # single thing — which is the whole point of the next assertion.
        for rel in MANIFEST["migrations"]["postgres"]:
            psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
        for rel in MANIFEST.get("seed", {}).get("postgres", []):
            # `seed::apply_module_seed` binds `:hub_id`, `:now` and a `:current_user_id` of
            # "system": the seed is written by the installer, not by a user.
            seed_params = {
                "hub_id": HUB,
                "now": "2026-08-07T09:00:00Z",
                "current_user_id": "system",
            }
            psql([], db=DB, stdin=bind((MODULE_DIR / rel).read_text(), seed_params))
        ok("migrations (+ seed, if any) apply on a clean Postgres")

        # 1. THE ONE THAT MATTERS (services#26): a hub that was just installed and where nobody
        #    ever opened the till must read PENDING. If the row this query reads were created by
        #    the install itself — a seed, a DEFAULT row, another module writing it — the item would
        #    report DONE on an untouched hub and the task would be hidden FOREVER, in silence:
        #    nothing turns red when a checklist lies in the optimistic direction.
        rows = run_setup_query(setup)
        if rows or is_configured(rows, checks):
            fail(
                f"a just-installed hub, with nobody having touched the till, already reads "
                f"{'DONE' if is_configured(rows, checks) else 'a row'} "
                f"({rows[:1]}) — the row is created by the install, not by the user, so the item "
                f"would be ticked from birth and the task would never be shown. Use a query whose "
                f"row only exists once somebody has actually configured something."
            )
        else:
            ok("a just-installed hub reads PENDING (no row is auto-created)")

        # 2. The user saves the cash settings from the screen `route` points at ⇒ done.
        run_command("cash_register.settings.update", SETTINGS_SNAPSHOT)
        rows = run_setup_query(setup)
        if len(rows) != 1:
            fail(f"after saving the settings: expected exactly 1 row, got {len(rows)}")
        else:
            missing = [c["field"] for c in checks if c["field"] not in rows[0]]
            if missing:
                fail(
                    f"the setup query does not return {missing} — `configured_when` would evaluate "
                    f"a field that is not there and the item would stay pending forever"
                )
            else:
                ok(
                    f"the query returns every configured_when field: {[c['field'] for c in checks]}"
                )
        if not is_configured(rows, checks):
            fail("after saving the cash settings the item still reads PENDING")
        else:
            ok("saving the cash settings reads DONE")

        # 3. A card-only shop turns the drawer OFF — and the item must still be clearable. An item
        #    that can never be ticked, in a checklist, teaches the user to ignore the checklist.
        run_command(
            "cash_register.settings.update",
            dict(SETTINGS_SNAPSHOT, enable_cash_register=False),
        )
        if not is_configured(run_setup_query(setup), checks):
            fail(
                "turning the cash drawer OFF flips the item back to PENDING — a 🟡 task nobody can "
                "ever clear. The check must read 'the settings were saved', not 'cash is enabled'"
            )
        else:
            ok("a shop that turns the drawer off keeps the item DONE")
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'])


# ── Runner ───────────────────────────────────────────────────────────────────────────────


def main() -> int:
    setup = MANIFEST.get("setup")
    if not isinstance(setup, dict):
        print("FAILED — module.json declares no `setup` block (cash_register#17):")
        print(
            "  - the module contributes no item to `hub.setup.status`, so a new hub is never"
        )
        print(
            "    told to set its cash drawer up (architecture/hub/setup-status.md §6)"
        )
        return 1

    print("· shape (mirror of SetupDef)")
    check_shape(setup)
    check_query_is_runnable(setup)
    check_route_and_permission(setup)
    check_i18n(setup)

    print("· canonical schema")
    check_against_canonical_schema()

    print("· live check (real Postgres)")
    check_against_postgres(setup)

    for note in notes:
        print(f"  · {note}")
    for warning in warnings:
        print(f"  ! {warning}")
    print()

    if failures:
        print(f"FAILED — {len(failures)} violation(s) in the `setup` block:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(
        f"PASS — `setup` v{MANIFEST['version']} is the contract the runtime parses and evaluates"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
