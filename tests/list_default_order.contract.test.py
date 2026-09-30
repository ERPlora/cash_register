#!/usr/bin/env python3
"""Default order of the two till lists (cash_register#127) — newest first, like every POS.

`cash_register.sessions.list` and `cash_register.counts.list` declared `default_sort: "id"`,
`default_dir: "asc"`. The `id` is a UUID, so the Cash grid came back in an order unrelated to time:
with three shifts of the same day the open one could land last, between two closed ones. The
person opening the screen to find today's shift (or yesterday's, to reconcile it) had to hunt for
it. Square, Toast, Lightspeed and Odoo (POS → Sessions) all list the most recent first.

The manifest is the order a caller gets when it does NOT say one (the assistant, a widget, any new
screen), so it is pinned here:

  * sessions → `opened_at` DESC   (`opened_at` is the RFC 3339 `:now` of `session.open`; as TEXT it
    sorts chronologically, and the list engine breaks ties by `id` — stable across reloads);
  * counts   → `counted_at` DESC.

Both columns must stay in the `sort` whitelist: the runtime only interpolates whitelisted columns
into ORDER BY. The screens pass their own `sort`/`dir` (the SDK list controller always sends one),
so the UI half lives in `ui/test/list-newest-first.test.ts`; the runtime half — the engine really
applying these defaults to rows of different ages — in `tests/list_order.hub.test.py`.

Usage: tests/list_default_order.contract.test.py   (exit 0 = green)
"""

import json
import pathlib
import sys

MANIFEST = json.loads(
    (pathlib.Path(__file__).resolve().parent.parent / "module.json").read_text()
)

EXPECTED = {
    "cash_register.sessions.list": ("opened_at", "desc"),
    "cash_register.counts.list": ("counted_at", "desc"),
}


def main() -> int:
    failures: list[str] = []
    for name, (column, direction) in EXPECTED.items():
        spec = (MANIFEST.get("queries", {}).get(name) or {}).get("list")
        if not isinstance(spec, dict):
            failures.append(f"{name}: no `list` block")
            continue
        got = (spec.get("default_sort"), spec.get("default_dir"))
        if got != (column, direction):
            failures.append(
                f"{name}: default order is {got}, expected {(column, direction)}"
            )
        else:
            print(f"  ok: {name} defaults to {column} {direction}")
        if column not in (spec.get("sort") or []):
            failures.append(f"{name}: `{column}` is not in the `sort` whitelist")
        else:
            print(f"  ok: {name} whitelists `{column}`")
    print()
    if failures:
        print(f"✗ list_default_order: {len(failures)} failure(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("✓ list_default_order: sessions and counts list newest first by default")
    return 0


if __name__ == "__main__":
    sys.exit(main())
