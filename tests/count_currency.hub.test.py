#!/usr/bin/env python3
"""The till count adds up with the HUB currency's scale, against the REAL kernel (cash_register#111).

`count.add` runs in the WASM sandbox, which cannot read the database: the hub's currency reaches it
as the `cash_register.currency_scale` read the host preloads (ADR-0069). Unit tests feed that row
by hand; only a runtime proves the three links together — the setting the admin screen writes
(`PUT /api/settings`) is the one the query reads, in the shape the handler parses, for THIS hub:

  1. In yen (0 decimals): 5 × ¥1000 + 3 × ¥1 = 5003, not 500300.
  2. In Kuwaiti dinars (3 decimals): 2 × 0.25 + 3 × 0.005 = 515 fils, not 51.
  3. Back in euros (2 decimals): 2 × 50 € + 3 × 0,05 € = 10015 cents — the euro did not move.

The hub is shared with every battery of the run, so the currency it had is restored at the end
whatever happens.

Usage: `erplora test <dir> --against-hub [dev|stable|sha256:…]` (module-toolkit#110). Never on its
own: without a runtime it fails, it does not skip.
"""

import sys

import hub_harness
from hub_harness import Hub, cents, close_session, open_session


def set_currency(hub: Hub, code: str) -> None:
    """The hub's currency through the real admin door (dev auth grants admin to any `X-User-Id`,
    `crates/server/src/auth.rs::require_admin_session`) — the write the settings screen makes."""
    status, body = hub._request("PUT", "/api/settings", {"currency": code})
    if status != 200 or (body or {}).get("currency") != code:
        raise AssertionError(
            f"PUT /api/settings currency={code} answered {status}: {body}"
        )


def counted(hub: Hub, denominations: dict) -> int:
    """Total of ONE count of a fresh session, as the list reads it back (minor units)."""
    sid = open_session(hub, 0)
    try:
        hub.run(
            "cash_register.count.add",
            {
                "session_id": sid,
                "count_type": "closing",
                "denominations": denominations,
            },
        )
        rows = hub.query("cash_register.counts.list", {"session_id": sid})
        hub.check("counts recorded", len(rows), 1)
        return cents(rows[0].get("total"))
    finally:
        close_session(hub, sid)


def main() -> int:
    hub = Hub("count_currency.hub")
    print(
        f"Hub battery · count by hub currency (cash_register#111) · {hub_harness.BASE} · hub {hub.hub_id} · user {hub.user}"
    )
    status, before = hub._request("GET", "/api/settings")
    if status != 200:
        print(f"GET /api/settings answered {status}: {before}")
        return 1
    original = (before or {}).get("currency") or "EUR"
    try:
        print("\n1 · yen: no minor unit")
        set_currency(hub, "JPY")
        hub.check(
            "¥ total", counted(hub, {"bills": {"1000": 5}, "coins": {"1": 3}}), 5003
        )

        print("\n2 · Kuwaiti dinar: three decimals")
        set_currency(hub, "KWD")
        hub.check(
            "KWD total (fils)",
            counted(hub, {"bills": {"0.25": 2}, "coins": {"0.005": 3}}),
            515,
        )

        print("\n3 · euro: cents, as before")
        set_currency(hub, "EUR")
        hub.check(
            "€ total (cents)",
            counted(hub, {"bills": {"50": 2}, "coins": {"0.05": 3}}),
            10015,
        )
    finally:
        set_currency(hub, original)

    return hub.finish(
        "the count adds its notes and coins with the scale of the hub's currency"
    )


if __name__ == "__main__":
    sys.exit(main())
