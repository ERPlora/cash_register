#!/usr/bin/env python3
"""cash_register#119 (born from hub#1913) — every widget asks its query only for params that query
ACCEPTS, checked offline against the manifest so the next widget cannot ship the same mistake.

The shell sends a widget's `params` VERBATIM to `POST /api/query`, and the kernel refuses (422
`unknown_filter`) anything outside the query's vocabulary. The vocabulary mirrors the runtime's
`accepted_params` (hub `crates/runtime/src/queries.rs`):
  · list query  → `limit offset search sort dir` + `f_<col>` per `eq`/`like` filter +
                  `f_<col>_from`/`f_<col>_to` per `range` filter + the binds of its SQL + the
                  properties of its `schema`, if any;
  · plain query → the binds of its SQL + `limit offset` + its `schema` properties.
`sort` must also name a column the list declares sortable, or the engine falls back silently.

The runtime proof is `widget_params.hub.test.py`; this one runs without a hub.
Usage: tests/widget_params.contract.test.py   (exit 0 = green)
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
m = json.loads((ROOT / "module.json").read_text())

BIND = re.compile(r"(?<![:\w]):([A-Za-z_]\w*)")


def sql_binds(path: str) -> set[str]:
    sql = (ROOT / path).read_text()
    code = re.sub(r"--[^\n]*", "", sql)
    code = re.sub(r"'(?:[^']|'')*'", "''", code)
    return set(BIND.findall(code))


def schema_props(qdef: dict) -> set[str]:
    schema = qdef.get("schema")
    if isinstance(schema, str):
        schema = json.loads((ROOT / schema).read_text())
    return set((schema or {}).get("properties", {}))


def vocabulary(qdef: dict) -> set[str]:
    words = sql_binds(qdef["sql"]) | schema_props(qdef)
    spec = qdef.get("list")
    if spec is None:
        return words | {"limit", "offset"}
    words |= {"limit", "offset", "search", "sort", "dir"}
    for col, f in (spec.get("filters") or {}).items():
        if f.get("op") == "range":
            words |= {f"f_{col}_from", f"f_{col}_to"}
        else:
            words.add(f"f_{col}")
    return words


errors = []
widgets = m.get("widgets") or {}
if not widgets:
    errors.append("the manifest declares no widgets — nothing was checked")
for wid, w in sorted(widgets.items()):
    qdef = m["queries"].get(w["query"])
    if qdef is None:
        errors.append(f"{wid}: query {w['query']} is not declared by this module")
        continue
    accepted = vocabulary(qdef)
    params = w.get("params") or {}
    for name in sorted(params):
        if name not in accepted:
            errors.append(
                f"{wid}: param `{name}` is outside the vocabulary of {w['query']} {sorted(accepted)}"
            )
    spec = qdef.get("list") or {}
    if "sort" in params and params["sort"] not in spec.get("sort", []):
        errors.append(
            f"{wid}: sort `{params['sort']}` is not a sortable column of {w['query']}"
        )
    if "dir" in params and params["dir"] not in ("asc", "desc"):
        errors.append(f"{wid}: dir `{params['dir']}` is neither asc nor desc")

# «Recent discrepancies» is about CLOSED drawers only. Without the filter the engine still sorts
# `closed_at DESC` with nulls last, so the open session hides behind 8 closes — until a business
# has fewer than 8 (its first week), when the open drawer shows up with no difference. Only here
# can that be pinned: the shared hub of a battery run always holds more than 8 closes.
recent = (widgets.get("cash_register.recent_sessions") or {}).get("params") or {}
if recent.get("f_status") != "closed":
    errors.append(
        f"cash_register.recent_sessions: must ask for f_status=closed, asks {recent}"
    )

for e in errors:
    print("FAIL:", e)
print(
    f"widget params ({len(widgets)} widgets):",
    "OK" if not errors else f"{len(errors)} error(s)",
)
sys.exit(1 if errors else 0)
