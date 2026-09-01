#!/usr/bin/env python3
"""The generic Ajustes screen can only speak the language the MODULE ships (ERPlora/pm#165).

Since hub#1094 (shipped in hub#1199) the shell resolves every control of the settings form it
generates by **module locale → schema `title` → humanized key**
(`hub/apps/web/src/lib/module-settings.ts`, `settingsFieldLabel`). The first link is the module's
half of the contract, and for seven of the eight modules with a `settings` block it was empty: the
shell had nothing to read, so a Spanish hub painted the canonical-English `title` of the JSON
Schema — and, for a property without one, `humanize(key)`, which is the COLUMN NAME spelled with
capitals (`warning_time_minutes` → «Warning Time Minutes»).

No fix in the shell can ever make that screen Spanish. The strings have to exist here.

What this file pins, and why each half is load-bearing:

  1. every property of the settings schema carries a non-empty `title` — English is the SOURCE
     (ADR-0055), and the `title` is the fallback that stops the screen leaking a column name;
  2. every property carries a `settings.fields.<key>.label` in EVERY `locales/*.json` the module
     publishes — a chain of `en` + its `es`, never one without the other (ADR-0199);
  3. a property whose schema declares a `description` carries that help text in every locale too,
     or the control is labelled in Spanish and explained in English;
  4. every `required` property carries a `default`. This is not decoration: the form builds its
     model as **row value > schema `default` > empty**, and the singleton row is born from this
     very screen, so on a brand-new hub a `required` property with no `default` starts as
     `''`/`false` and the first Guardar is a 422 the user can never get past. That is exactly how
     `cash_register` locked its own settings screen (pm#165) and `kitchen` before it (kitchen#41).

  5. and a positive control: a run that found no properties, or no locales, FAILS. A guard that
     passes because it compared nothing is the failure mode this whole file exists to prevent.

Usage: tests/settings_labels.contract.test.py   (exit 0 = green)
"""

import json
import pathlib
import sys

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text(encoding="utf-8"))

#: `settings.schema` from the manifest — the very file the shell fetches and renders.
SETTINGS = MANIFEST.get("settings") or {}
LOCALES_DIR = MODULE_DIR / "locales"


def text(value: object) -> str:
    """A string that survives trimming. Blank-but-present counts as absent, like the shell."""
    return value.strip() if isinstance(value, str) else ""


def main() -> int:
    failures: list[str] = []

    schema_rel = SETTINGS.get("schema")
    if not schema_rel:
        print(
            f"SKIPPED — `{MANIFEST['id']}` declares no `settings.schema` in module.json, so the "
            "shell generates no settings screen and there is nothing to translate."
        )
        return 0

    schema = json.loads((MODULE_DIR / schema_rel).read_text(encoding="utf-8"))
    properties = schema.get("properties") or {}
    required = schema.get("required") or []

    # ── positive control ─────────────────────────────────────────────────────────────────────
    # Everything below iterates over `properties` and over `locales/*.json`. If either is empty
    # the loops run zero times and the file prints PASS having verified nothing at all.
    if not properties:
        failures.append(
            f"{schema_rel} declares no `properties` — this check would pass having compared "
            "nothing; fix the schema or the path in `settings.schema`"
        )
    locales = sorted(LOCALES_DIR.glob("*.json")) if LOCALES_DIR.is_dir() else []
    if not locales:
        failures.append(
            "the module ships no `locales/*.json` — its settings screen can only ever be English "
            "(ADR-0055: English is the source, every shipped language is a translation)"
        )

    # ── 1. English source in the schema ──────────────────────────────────────────────────────
    for key, prop in properties.items():
        if not text(prop.get("title")):
            failures.append(
                f"`{key}` has no `title`: with no locale for the active language the shell falls "
                f"back to humanize('{key}') and shows the COLUMN NAME as the label"
            )

    # ── 2 & 3. the translation, in every language the module publishes ───────────────────────
    for path in locales:
        block = json.loads(path.read_text(encoding="utf-8")).get("settings") or {}
        fields = block.get("fields") or {}
        if not text(block.get("title")):
            failures.append(
                f"locales/{path.name}: no `settings.title` — the heading of the settings screen "
                "stays in the source language"
            )
        for key, prop in properties.items():
            entry = fields.get(key) or {}
            if not text(entry.get("label")):
                failures.append(
                    f"locales/{path.name}: no `settings.fields.{key}.label` — that control can "
                    "never be shown in this language"
                )
            if text(prop.get("description")) and not text(entry.get("description")):
                failures.append(
                    f"locales/{path.name}: `{key}` has help text in the schema but no "
                    f"`settings.fields.{key}.description` — the control would be labelled in this "
                    "language and explained in another"
                )

    # ── 4. the first save has to be possible ─────────────────────────────────────────────────
    for key in required:
        prop = properties.get(key)
        if prop is None:
            failures.append(
                f"`{key}` is listed in `required` but not declared in `properties`"
            )
            continue
        if "default" not in prop:
            failures.append(
                f"`{key}` is required and has NO `default`: on a hub whose settings row does not "
                "exist yet the form starts it empty and the first save is rejected — the screen "
                "can never create the row (pm#165)"
            )

    if failures:
        print(
            f"FAILED — {len(failures)} problem(s) in the settings contract of {MANIFEST['id']}:"
        )
        for f in failures:
            print(f"  - {f}")
        return 1

    print(
        f"PASS — {len(properties)} setting(s) of `{MANIFEST['id']}` carry an English title and a "
        f"label in {len(locales)} locale(s) ({', '.join(p.stem for p in locales)}); "
        f"{len(required)} required one(s) carry a default."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
