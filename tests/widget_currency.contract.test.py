#!/usr/bin/env python3
"""A home-screen money panel of this module never pins a currency or a locale (cash_register#121,
born from hub#2387).

Since hub#2387 the dashboard shell (`apps/web/src/lib/dashboard-widgets.ts`) formats a money
widget in the HUB's currency — scaled by that currency's minor unit — and in the language of the
UI, whenever the widget leaves `options.currency` / `options.locale` unset. A value the widget sets
still wins. «Expected cash in drawer» and «Recent discrepancies» set `"currency": "EUR"` and
`"locale": "es-ES"`, so a business working in dollars or yen read its drawer in euros, Spanish
style, on the home screen while every other screen of the app used its own currency.

The amounts are the drawer's, always in the hub's currency: no cash panel can know better than
the hub which one that is.

What this file pins:
  1. no widget whose value is money (`format` or `valueFormat` = "currency") declares
     `options.currency` or `options.locale`;
  2. and a positive control: a run that found no money widget FAILS — a guard that compared
     nothing would pass for the wrong reason.

Usage: tests/widget_currency.contract.test.py   (exit 0 = green)
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
widgets = (
    json.loads((ROOT / "module.json").read_text(encoding="utf-8")).get("widgets") or {}
)

PINNED = ("currency", "locale")

errors = []
money = []
for wid, w in sorted(widgets.items()):
    opts = w.get("options") or {}
    if "currency" not in (opts.get("format"), opts.get("valueFormat")):
        continue
    money.append(wid)
    for key in PINNED:
        if key in opts:
            errors.append(
                f"{wid}: options.{key} = {opts[key]!r} pins the panel; leave it unset so the "
                "home screen uses the hub currency and the language of the UI"
            )

if not money:
    errors.append("no widget formats money — nothing was checked")

for e in errors:
    print("FAIL:", e)
print(
    f"widget currency ({len(money)} money widgets: {', '.join(money)}):",
    "OK" if not errors else f"{len(errors)} error(s)",
)
sys.exit(1 if errors else 0)
