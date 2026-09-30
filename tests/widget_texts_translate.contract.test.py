#!/usr/bin/env python3
"""Every text a home-screen panel of this module shows speaks the language of the UI (cash_register#123).

With the hub in English, the panel picker («Customize panel») grouped the panels of this module
under «Caja»: the manifest declared `"category": "Caja"` as a Spanish literal, while the title and
the caption were canonical English translated through `locales/es.json`. Same bug and same fix as
sales#473.

The dashboard shell (`hub/apps/web/src/lib/dashboard-widgets.ts`, hub#2401) translates a panel from
the module's locale file for the active language: `widgets.<id>.title`, `.label` (`options.label`),
`.seriesName` (`options.seriesName`, the chart legend) and `.category` (the picker group). What is
not in the locale file stays as the manifest wrote it, so the manifest has to be the English source.

What this file pins, for every widget of `module.json`:
  1. `title`, `category`, `options.label` and `options.seriesName`, whenever declared, have their
     Spanish entry in `locales/es.json` under `widgets.<id>`;
  2. the manifest does not carry the Spanish text itself in `category`/`seriesName` (a Spanish
     literal in the source leaks into every other language);
  3. and positive controls: a run that checked no category FAILS, and so does one where a chart
     panel (`kind: "chart"`) declared no legend — a guard that compared nothing would pass for the
     wrong reason. A module without chart panels has no legend to check.

Usage: tests/widget_texts_translate.contract.test.py   (exit 0 = green)
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
widgets = (
    json.loads((ROOT / "module.json").read_text(encoding="utf-8")).get("widgets") or {}
)
es = (
    json.loads((ROOT / "locales" / "es.json").read_text(encoding="utf-8")).get(
        "widgets"
    )
    or {}
)

errors = []
checked = {"title": 0, "category": 0, "label": 0, "seriesName": 0}
charts = 0
for wid, w in sorted(widgets.items()):
    opts = w.get("options") or {}
    if w.get("kind") == "chart":
        charts += 1
    source = {
        "title": w.get("title"),
        "category": w.get("category"),
        "label": opts.get("label"),
        "seriesName": opts.get("seriesName"),
    }
    tr = es.get(wid) or {}
    for key, text in source.items():
        if text is None:
            continue
        checked[key] += 1
        spanish = tr.get(key)
        if not spanish:
            errors.append(
                f"{wid}: {key} {text!r} has no Spanish entry in locales/es.json widgets"
            )
            continue
        # Same word in both languages («Tickets») is fine; otherwise the source must be English.
        if spanish == text and key in ("category", "seriesName"):
            errors.append(
                f"{wid}: {key} {text!r} in module.json is the Spanish text; the manifest is the "
                "English source and locales/es.json carries the translation"
            )

if not checked["category"]:
    errors.append("no widget declares a category — nothing was checked")
if charts and not checked["seriesName"]:
    errors.append(
        "a chart widget declares no legend (options.seriesName) — nothing was checked"
    )

for e in errors:
    print("FAIL:", e)
print(
    "widget texts (" + ", ".join(f"{n} {k}" for k, n in checked.items()) + "):",
    "OK" if not errors else f"{len(errors)} error(s)",
)
sys.exit(1 if errors else 0)
