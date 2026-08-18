#!/usr/bin/env python3
"""sales#100 — the `cashier` role is DECLARED by `sales` (a job / permission set, never an identity:
Toast, Square, Mindbody, Vagaro — decided in ERPlora/pm#9) and every module the till touches
GRANTS to that key what a cashier needs there. The runtime does not inherit from `employee`
(`permissions_for_role` = union of what each active module grants to the key), so a hub that
switches the role on and installs this module without this grant hands the cashier an empty screen.

Contract: what cash_register grants to `cashier`, and what it must NOT (reports, settings, catalogue edits).
Usage: tests/cashier_role.contract.test.py   (exit 0 = green)
"""
import json, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
m = json.loads((ROOT / "module.json").read_text())
grants = m.get("role_permissions", {}).get("cashier")
MUST = [
    "cash_register.view_session",
    "cash_register.add_session",
    "cash_register.close_session",
    "cash_register.view_movement",
    "cash_register.add_movement",
    "cash_register.view_count",
    "cash_register.add_count"
]
MUST_NOT = [
    "cash_register.view_reports",
    "cash_register.manage_settings"
]

errors = []
if grants is None:
    errors.append("role_permissions.cashier is not declared")
else:
    for p in MUST:
        if p not in grants: errors.append(f"cashier lacks {p}")
    for p in MUST_NOT:
        if p in grants: errors.append(f"cashier must not get {p}")
    if "*" in grants: errors.append("cashier must never get *")
    for p in grants:
        if p not in m["permissions"]: errors.append(f"cashier is granted {p}, which this module does not declare")
for e in errors: print("FAIL:", e)
print("cashier role grants:", "OK" if not errors else f"{len(errors)} error(s)")
sys.exit(1 if errors else 0)
