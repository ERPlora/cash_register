#!/usr/bin/env python3
"""Every home-screen widget of this module asks its query for something the REAL kernel accepts
(cash_register#119, born from hub#1913).

The shell does not translate a widget: `dashboard-widgets.ts` sends `def.params` VERBATIM to
`POST /api/query`. Since hub#1173/hub#1182 the list engine REJECTS (422 `unknown_filter`) any
param outside the query's vocabulary — `limit/offset/search/sort/dir`, `f_<filter>` (`_from`/`_to`
for a range) and the binds of its SQL. «Recent discrepancies» asked `sessions.list` for
`"status": "closed"` — the filter is `f_status` on the wire — so the manager who switched the panel
on got an error on every load instead of the last closed sessions and how far each drawer was off.

  1. Each widget of the manifest, called exactly as the shell calls it, is answered 200.
  2. «Recent discrepancies» lists CLOSED sessions only, newest close first, the last 8 — the one
     just closed leads and the one still open is not there.

Usage: `erplora test <dir> --against-hub [dev|stable|sha256:…]`. Never on its own: without a
runtime it fails, it does not skip.
"""

import json
import pathlib
import sys

import hub_harness
from hub_harness import Hub, close_session, open_session

ROOT = pathlib.Path(__file__).resolve().parents[1]
WIDGETS = json.loads((ROOT / "module.json").read_text())["widgets"]


def widget_rows(hub: Hub, widget_id: str) -> tuple[int, object]:
    """`(status, body)` of the widget's query sent the way the shell sends it: `def.params ?? {}`."""
    w = WIDGETS[widget_id]
    return hub._request(
        "POST", "/api/query", {"name": w["query"], "params": w.get("params") or {}}
    )


def rows_of(body) -> list:
    data = (body or {}).get("data")
    return data["rows"] if isinstance(data, dict) and "rows" in data else (data or [])


def test_1_every_widget_is_answered(hub: Hub) -> None:
    print("\n1 · every widget, called like the shell calls it, is answered 200")
    for widget_id in sorted(WIDGETS):
        status, body = widget_rows(hub, widget_id)
        code = (
            ((body or {}).get("error") or {}).get("code")
            if isinstance(body, dict)
            else None
        )
        hub.check(f"{widget_id} → HTTP status (error code: {code})", status, 200)


def test_2_recent_discrepancies_are_the_last_closed_sessions(hub: Hub) -> None:
    print(
        "\n2 · «Recent discrepancies» = closed sessions only, newest close first, the last 8"
    )
    # Nine closes first, so the hub holds MORE than the panel shows whatever ran before: on a
    # fresh hub with fewer than 8 closed sessions a dropped `limit` would pass unnoticed.
    for _ in range(9):
        close_session(hub, open_session(hub, 1_000))
    just_closed = open_session(hub, 10_000)
    hub.run(
        "cash_register.session.close",
        {"session_id": just_closed, "closing_balance": 9_500, "closing_notes": ""},
    )
    still_open = open_session(hub, 5_000)
    try:
        status, body = widget_rows(hub, "cash_register.recent_sessions")
        hub.check("recent_sessions → HTTP status", status, 200)
        rows = rows_of(body) if status == 200 else []
        ids = [r["id"] for r in rows]
        hub.check("the session just closed leads the list", ids[:1], [just_closed])
        hub.check_true(
            "the open session is not listed", still_open not in ids, f"ids={ids}"
        )
        hub.check(
            "every row is closed", sorted({r["status"] for r in rows}), ["closed"]
        )
        closed_at = [r["closed_at"] for r in rows]
        hub.check("newest close first", closed_at, sorted(closed_at, reverse=True))
        hub.check("the last 8, no more", len(rows), 8)
    finally:
        close_session(hub, still_open)


def main() -> int:
    hub = Hub("widget_params.hub")
    print(
        f"Hub battery · widget params (cash_register#119) · {hub_harness.BASE} · hub {hub.hub_id}"
    )
    test_1_every_widget_is_answered(hub)
    test_2_recent_discrepancies_are_the_last_closed_sessions(hub)
    return hub.finish("every widget asks the real kernel for params its query accepts")


if __name__ == "__main__":
    sys.exit(main())
