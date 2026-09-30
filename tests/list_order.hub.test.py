#!/usr/bin/env python3
"""The till lists come back NEWEST FIRST from the real kernel (cash_register#127).

The manifest declared `default_sort: "id"` / `default_dir: "asc"` for `sessions.list` and
`counts.list`. The `id` is a UUID, so the Cash grid listed three shifts of the same day as
0002, 0001, 0003 (seen on hub:stable 1.1.30 in module-toolkit#427): today's open shift could sit
last, between two closed ones. The contract test pins what the manifest SAYS; only a runtime proves
that the list engine applies it to rows of different ages when the caller names no order — which
is what the assistant, a widget or any new screen does.

  1. Three sessions opened one after another: `sessions.list` without `sort` lists them newest
     first, and the whole page is ordered by `opened_at` descending (the hub is shared with the
     rest of the run, so older sessions from other batteries sit below — never above).
  2. Two counts of the same session: `counts.list` without `sort` lists the later one first.

Usage: `erplora test <dir> --against-hub [dev|stable|sha256:…]`. Never on its own: without a
runtime it fails, it does not skip.
"""

import sys
import time

import hub_harness
from hub_harness import Hub, close_session, open_session


def test_1_sessions_newest_first(hub: Hub) -> None:
    print("\n1 · sessions.list without a sort lists the newest session first")
    ids = []
    for _ in range(3):
        sid = open_session(hub, 0)
        ids.append(sid)
        close_session(hub, sid)
        # `opened_at` is the RFC 3339 `:now` of each command; a few ms apart is enough, the pause
        # only keeps two opens from sharing a clock tick on a coarse host clock.
        time.sleep(0.02)
    rows = hub.query("cash_register.sessions.list", {"limit": 500})
    mine = [r["id"] for r in rows if r["id"] in ids]
    hub.check("my three sessions, newest first", mine, list(reversed(ids)))
    opened = [r.get("opened_at") or "" for r in rows]
    hub.check_true(
        "the page is ordered by opened_at descending",
        opened == sorted(opened, reverse=True),
        f"opened_at in list order: {opened[:6]}…",
    )


def test_2_counts_newest_first(hub: Hub) -> None:
    print("\n2 · counts.list without a sort lists the latest count first")
    sid = open_session(hub, 0)
    first = hub.run(
        "cash_register.count.add",
        {
            "session_id": sid,
            "count_type": "opening",
            "denominations": {"coins": {"1": 1}},
        },
    )
    time.sleep(0.02)
    second = hub.run(
        "cash_register.count.add",
        {
            "session_id": sid,
            "count_type": "closing",
            "denominations": {"coins": {"1": 2}},
        },
    )
    hub.check_true("both counts landed", bool(first) and bool(second))
    counts = hub.query("cash_register.counts.list", {"session_id": sid})
    hub.check(
        "count types, latest first",
        [c.get("count_type") for c in counts],
        ["closing", "opening"],
    )
    close_session(hub, sid)


def main() -> int:
    hub = Hub("list_order.hub")
    print(
        f"Hub battery · list order (cash_register#127) · {hub_harness.BASE} · hub {hub.hub_id} · user {hub.user}"
    )
    test_1_sessions_newest_first(hub)
    test_2_counts_newest_first(hub)
    return hub.finish(
        "sessions and counts come back newest first when the caller names no order"
    )


if __name__ == "__main__":
    sys.exit(main())
