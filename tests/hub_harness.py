"""Plumbing shared by the `*.hub.test.py` batteries — the ones that talk to a REAL kernel.

`erplora test <dir> --against-hub` (module-toolkit#110) starts the published hub image with its
own Postgres, installs the module through `POST /api/modules/install` and hands the url over in
`ERPLORA_HUB_BASE_URL`. Everything below is the thin layer between a battery and that runtime:
the two doors (`/api/query`, `/api/command`), the error envelope, the event shape, and the one
piece of bookkeeping every battery needs — a `check()` that records a failure instead of dying on
it, so a red run names EVERY broken assertion and not just the first.

Why HTTP and not a scratch Postgres: these batteries replace the hub's own `cash_register_e2e.rs`
and the `cash_register` half of `void_reversal_e2e.rs` (ERPlora/hub#1264, contract «El Hub se
CIERRA como KERNEL» §5). What they assert is what the WASM handler does INSIDE the runtime — ids
minted by the host, `reads` pre-loaded by the dispatcher, the transaction, the outbox — and none
of that exists in a hand-written harness that binds `:hub_id` itself. The Postgres batteries next
door (`*.postgres.test.py`) keep proving the SQL in isolation; these prove the module against the
kernel that runs it, including the async chain `sale.completed`/`sale.voided` → outbox → listener.

Two facts of the runtime a battery has to know, both resolved here so no battery hard-codes them:

  * THE TENANT. Module seeds (the payment-method catalogue, the tax rules) land under the
    RUNTIME's own `hub_id`, not under whatever `X-Hub-Id` a request carries (that is how hub#594
    was found). `GET /api/hub/context` says which id that is, and every request goes out under it —
    a battery sending `local` would see a hub with no payment methods and `complete_sale` would
    refuse every sale with `sales.payment_method_required`.
  * THE SESSION USER. Dev auth trusts `X-User-Id`. Each run mints its own, because batteries share
    one hub for the length of the run and `sales.by_staff` attributes the unnamed sale to the
    session user: a fixed id would count another battery's sales as this one's.

Cash movements caused by a sale travel by the OUTBOX (`sale.completed`/`sale.voided` →
`cash_register.record_sale`/`cash_register._reverse_sale`), and the relay ticks once a second
(`crates/server/src/lib.rs`), so `wait_for_movement` below polls instead of asserting the instant
after charging or voiding — the boring, standard way to check an eventually-consistent side effect,
not a sleep sized by guesswork.

It refuses to skip. Without a runtime a battery FAILS: a check that excuses itself is the green
that proves nothing this whole toolkit exists to remove (module-toolkit#50).
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = (
    os.environ.get("CASH_REGISTER_HUB_BASE_URL")
    or os.environ.get("ERPLORA_HUB_BASE_URL")
    or ""
).rstrip("/")

# Quantities travel in 10^6 fixed point (ADR-0147); money in integer cents (ADR-0007/0123).
ONE = 1_000_000


def cents(value) -> int:
    """A money aggregate the way Postgres hands it back: `SUM(bigint)` is NUMERIC, so a total may
    arrive as a JSON string (`"5000"`) instead of a number. Either form is the same cents."""
    if isinstance(value, bool):
        raise AssertionError(f"not a money amount: {value!r}")
    if isinstance(value, (int, float)):
        return int(round(value))
    if isinstance(value, str):
        return int(round(float(value)))
    raise AssertionError(f"not a money amount: {value!r}")


class Hub:
    """One battery's view of the live runtime."""

    def __init__(self, battery: str, needs: tuple[str, ...] = ("cash_register",)):
        self.battery = battery
        self.failures: list[str] = []
        if not BASE:
            print(
                f"{battery}: no runtime at the other end (ERPLORA_HUB_BASE_URL is empty)."
            )
            print(
                "Run it with `erplora test <dir> --against-hub`; without a hub this is NOT a skip, "
                "it is a failure."
            )
            sys.exit(1)
        self.user = f"u-{uuid.uuid4().hex[:8]}"
        self.hub_id = self._runtime_hub_id()
        self._require_installed(needs)

    # ── transport ────────────────────────────────────────────────────────────────────────

    def _request(self, method: str, path: str, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            f"{BASE}{path}",
            data=data,
            headers={
                "content-type": "application/json",
                "x-hub-id": self.hub_id,
                "x-user-id": self.user,
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return res.status, json.loads(res.read().decode() or "null")
        except urllib.error.HTTPError as err:
            raw = err.read().decode()
            try:
                return err.code, json.loads(raw or "null")
            except json.JSONDecodeError:
                return err.code, {"raw": raw}

    def _runtime_hub_id(self) -> str:
        req = urllib.request.Request(f"{BASE}/api/hub/context", method="GET")
        with urllib.request.urlopen(req, timeout=60) as res:
            body = json.loads(res.read().decode())
        hub_id = body.get("hub_id")
        if not hub_id:
            print(
                f"{self.battery}: GET /api/hub/context did not say the hub_id: {body}"
            )
            sys.exit(1)
        return hub_id

    def _require_installed(self, needs: tuple[str, ...]) -> None:
        status, body = self._request("GET", "/api/modules")
        installed = (
            {m["id"] for m in (body or {}).get("data", [])} if status == 200 else set()
        )
        missing = [m for m in needs if m not in installed]
        if missing:
            print(
                f"{self.battery}: the runtime at {BASE} does not have {missing} installed "
                f"(installed: {sorted(installed)}). The harness has to install every dependency "
                "through the same door before the module. Not a skip: nothing below can be "
                "trusted without them."
            )
            sys.exit(1)

    # ── the two doors ────────────────────────────────────────────────────────────────────

    def query(self, name: str, params: dict | None = None) -> list:
        """Rows of a query. A query with a `list` block answers `{rows,total,…}`; the rest answer
        the bare array. Both come back as the list of rows."""
        status, body = self._request(
            "POST", "/api/query", {"name": name, "params": params or {}}
        )
        if status != 200 or not (body or {}).get("ok"):
            raise AssertionError(f"query {name} answered {status}: {body}")
        data = body["data"]
        if isinstance(data, dict) and "rows" in data:
            return data["rows"]
        return data

    def command(self, name: str, payload: dict):
        """`(status, body)` of a command, whatever the runtime answered."""
        return self._request("POST", "/api/command", {"name": name, "payload": payload})

    def run(self, name: str, payload: dict) -> dict:
        """A command that MUST succeed. Its `data` (`operations`, `new_ids`, …)."""
        status, body = self.command(name, payload)
        if status != 200 or not (body or {}).get("ok"):
            raise AssertionError(f"command {name} answered {status}: {body}")
        return body["data"]

    def refused(self, label: str, name: str, payload: dict, code: str) -> None:
        """The runtime must REFUSE the command with exactly this domain code — the code, never the
        prose (ADR-0398 §6): the till translates the code, nobody reads the sentence."""
        status, body = self.command(name, payload)
        got = (
            ((body or {}).get("error") or {}).get("code")
            if isinstance(body, dict)
            else None
        )
        if status == 200:
            self.failures.append(
                f"{label} — expected refusal `{code}`, the command SUCCEEDED: {body}"
            )
            print(f"  FAIL: {label} — expected refusal `{code}`, got success: {body}")
        elif got != code:
            self.failures.append(
                f"{label} — expected code [{code}], got [{got}] (HTTP {status}: {body})"
            )
            print(
                f"  FAIL: {label} — expected code [{code}], got [{got}] (HTTP {status})"
            )
        else:
            print(f"  ok: {label} refused with `{code}` (HTTP {status})")

    # ── what the hub says about its events ───────────────────────────────────────────────

    def event_shape(self, event_name: str) -> dict | None:
        """`GET /api/hub/events/shape?name=…` — the fields of the NEWEST events of that name in this
        hub, each with one sample unless withheld (hub#715). `None` when the hub has never heard of
        the event. It is the only read of an emitted payload the runtime offers, and it is enough:
        a sample is the value of the most recent event, which is the one the battery just caused."""
        status, body = self._request(
            "GET", f"/api/hub/events/shape?name={event_name}&limit=1"
        )
        if status == 404:
            return None
        if status != 200 or not (body or {}).get("ok"):
            raise AssertionError(f"events/shape {event_name} answered {status}: {body}")
        return body["data"]

    def event_field(self, event_name: str, path: str) -> dict | None:
        shape = self.event_shape(event_name)
        if shape is None:
            return None
        return next((f for f in shape.get("fields", []) if f.get("path") == path), None)

    # ── bookkeeping ──────────────────────────────────────────────────────────────────────

    def check(self, label: str, got, want) -> None:
        if got != want:
            self.failures.append(f"{label} — expected [{want!r}], got [{got!r}]")
            print(f"  FAIL: {label} — expected [{want!r}], got [{got!r}]")
        else:
            print(f"  ok: {label} = {got!r}")

    def check_true(self, label: str, condition: bool, detail="") -> None:
        if not condition:
            self.failures.append(f"{label} — {detail}" if detail else label)
            print(f"  FAIL: {label} {detail}")
        else:
            print(f"  ok: {label}")

    def finish(self, verdict: str) -> int:
        print()
        if self.failures:
            print(f"✗ {self.battery}: {len(self.failures)} failure(s):")
            for f in self.failures:
                print(f"  - {f}")
            return 1
        print(f"✓ {self.battery}: {verdict}")
        return 0


def cash_method_id(hub: Hub) -> str:
    """Id of the CASH method from the hub's seeded catalogue, through the public query — never
    composed by hand (sales#20: «the client proposes, the server disposes» — `complete_sale`
    demands a `payment_method_id` that IS in the catalogue). `sales` must be installed."""
    rows = hub.query("sales.payment_methods")
    cash = next((r for r in rows if r.get("type") == "cash"), None)
    if cash is None:
        raise AssertionError(
            f"the hub's catalogue must carry the `cash` method: {rows}"
        )
    return cash["id"]


def card_method_id(hub: Hub) -> str:
    """Id of the CARD method from the hub's seeded catalogue (the counter-case: a card sale must
    NOT touch the cash drawer)."""
    rows = hub.query("sales.payment_methods")
    card = next((r for r in rows if r.get("type") == "card"), None)
    if card is None:
        raise AssertionError(
            f"the hub's catalogue must carry the `card` method: {rows}"
        )
    return card["id"]


def key(tag: str) -> str:
    """A charge-attempt key unique to THIS run (sales#20's `idempotency_key`)."""
    return f"hub-battery-{tag}-{uuid.uuid4().hex[:8]}"


def open_session(hub: Hub, opening: int) -> str:
    """Opens a cash session and returns its id. `session_number` is deprecated and server-minted
    since cash_register#49 — never sent.

    Reads the id off `new_ids[0]` of the command's OWN response, never off `sessions.list` — the
    list's `default_sort` is `id` (a UUID, sorted lexically), not creation order, and this hub is
    shared across every test in the battery run: picking "the last row" would silently grab
    whichever session happens to sort last, not the one just opened."""
    out = hub.run(
        "cash_register.session.open",
        {"register_id": None, "opening_balance": opening, "opening_notes": ""},
    )
    return out["new_ids"][0]


def close_session(hub: Hub, session_id: str) -> None:
    """Closes a session so the next test can open a new one — the business rule is exactly ONE
    open session at a time (`cash_register.session_already_open`), and this hub is shared for the
    length of a battery run. The counted amount is irrelevant to callers that just need the
    session out of the way; use `closing_expected_balance()`-style helpers when the reconciliation itself is
    the assertion."""
    hub.run(
        "cash_register.session.close",
        {"session_id": session_id, "closing_balance": 0, "closing_notes": ""},
    )


def live_expected_cash(hub: Hub, session_id: str) -> tuple[int, int]:
    """The two figures the drawer shows WHILE the session is open — `(current_session.expected_total,
    session.summary.expected_cash)` — as opposed to the `expected_balance` that `session.close`
    freezes. They are three copies of the same rule (`opening + Σ cash movements signed by kind`)
    in three files (`queries/current_session.sql`, `queries/session_summary.sql`,
    `commands/close_session.sql`), and only the closing one is exercised by a close: a battery that
    reads just `expected_balance` stays green when the live KPI starts counting card legs as cash
    (proved with a mutant during the hub#1264 review). `summary.expected_cash` is also what the
    `movement.add` handler reads to enforce `allow_negative_balance` (cash_register#38).

    `current_session` only ever shows the OPEN session (the newest), which must be `session_id` —
    the battery owns the single open session, so anything else is a test-design error, not a
    tolerance."""
    current = hub.query("cash_register.current_session")
    if len(current) != 1 or current[0].get("id") != session_id:
        raise AssertionError(
            f"current_session should be the open session {session_id}, got {current}"
        )
    summary = hub.query("cash_register.session.summary", {"session_id": session_id})
    if len(summary) != 1:
        raise AssertionError(f"session.summary of {session_id} answered {summary}")
    return cents(current[0].get("expected_total")), cents(summary[0].get("expected_cash"))


def wait_for_movements(
    hub: Hub,
    session_id: str,
    sale_id: str,
    movement_type: str,
    count: int = 1,
    timeout: float = 8.0,
    interval: float = 0.1,
) -> list:
    """Polls `cash_register.movements.list` until `sale_id` has at least `count` movements of
    `movement_type` in `session_id`.

    A sale's cash movement (`record_sale` on `sale.completed`) and its reversal (`_reverse_sale` on
    `sale.voided`) both reach the module through the outbox relay, which ticks once a second — so
    the row this asks for may not exist the instant `complete_sale`/`sales.void` returns. Fails
    LOUDLY on timeout, naming what it actually saw — a helper that gave up quietly with fewer rows
    than asked would be indistinguishable from the listener never firing at all."""
    deadline = time.monotonic() + timeout
    seen: list = []
    while time.monotonic() < deadline:
        seen = [
            m
            for m in hub.query(
                "cash_register.movements.list", {"session_id": session_id}
            )
            if m.get("sale_reference") == sale_id
            and m.get("movement_type") == movement_type
        ]
        if len(seen) >= count:
            return seen
        time.sleep(interval)
    raise AssertionError(
        f"timed out after {timeout}s waiting for {count} `{movement_type}` movement(s) of sale "
        f"{sale_id} in session {session_id}, saw {len(seen)}: {seen}"
    )
