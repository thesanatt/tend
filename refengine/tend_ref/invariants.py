"""Properties every engine output must satisfy for any rules and input.

These hold for the reference by construction and for the C++ engine if it is right, so the
difftest runs them on every claim even when no C++ engine is built yet.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date

from .engine import STATUSES, UNIT_PERS, Law

DEADLINE_STATUSES = {"ok", "late", "unknown"}
MINIMUM_LOSS_STATUSES = {"met", "not_met", "waived", "unknown"}
REPORTING_STATUSES = {"satisfied", "required", "unknown"}


def _non_int_numbers(value, path: str = "$"):
    if isinstance(value, float):
        yield path
    elif isinstance(value, dict):
        for k, v in value.items():
            yield from _non_int_numbers(v, f"{path}.{k}")
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from _non_int_numbers(v, f"{path}[{i}]")


def invariant_errors(law: Law, engine_input: dict, out: dict) -> list[str]:
    errors: list[str] = []
    err = errors.append
    try:
        _check(law, engine_input, out, err)
    except (KeyError, TypeError, ValueError, AttributeError) as e:
        err(f"output has the wrong shape: {type(e).__name__}: {e}")
    return errors


def _check(law: Law, engine_input: dict, out: dict, err) -> None:
    for path in _non_int_numbers(out):
        err(f"{path} is a float; money is integer cents")

    ctx = engine_input["context"]
    incident, as_of = date.fromisoformat(ctx["incident_date"]), date.fromisoformat(ctx["as_of_date"])
    items = {it["item_id"]: it for it in engine_input.get("items") or []}
    rule_ids = {r["id"] for r in law.rules}
    lines = out["lines"]

    if sorted(line["item_id"] for line in lines) != sorted(items):
        err("lines do not match the input items one to one")
        return
    order = [(items[line["item_id"]]["date"], line["item_id"]) for line in lines]
    if order != sorted(order):
        err("lines are not in (date, item_id) order")

    trace_sum: dict[str, int] = defaultdict(int)
    for entry in out["trace"]:
        if entry["item_id"] is not None:
            trace_sum[entry["item_id"]] += entry["delta_cents"]

    for line in lines:
        item_id, status = line["item_id"], line["status"]
        item = items[item_id]
        where = f"line {item_id}"
        if status not in STATUSES:
            err(f"{where}: unknown status {status!r}")
        if line["requested_cents"] != item["amount_cents"]:
            err(f"{where}: requested_cents {line['requested_cents']} != amount_cents {item['amount_cents']}")
        if not 0 <= line["allowed_cents"] <= line["requested_cents"]:
            err(f"{where}: allowed_cents {line['allowed_cents']} outside [0, requested]")
        if status != "eligible" and line["allowed_cents"] != 0:
            err(f"{where}: {status} line allows {line['allowed_cents']}")
        if status == "eligible" and law.collateral_ids:
            net = max(0, item["amount_cents"] - (item.get("insurance_paid_cents") or 0))
            if line["allowed_cents"] > net:
                err(f"{where}: allows {line['allowed_cents']}, more than {net} left after insurance")
        if trace_sum[item_id] != line["allowed_cents"]:
            err(f"{where}: trace deltas sum to {trace_sum[item_id]}, line allows {line['allowed_cents']}")
        in_window = incident <= date.fromisoformat(item["date"]) <= as_of
        if (status == "out_of_window") == in_window:
            err(f"{where}: status {status} but the date is {'inside' if in_window else 'outside'} the window")
        if status in ("held", "excluded", "needs_confirmation", "eligible") and not line["rule_ids"]:
            err(f"{where}: {status} line has no proof")
        if status in ("out_of_window", "unknown_rule") and line["rule_ids"]:
            err(f"{where}: {status} line cites rules")
        for rid in line["rule_ids"] + ([line["cap_rule_id"]] if line["cap_rule_id"] else []):
            if rid not in rule_ids:
                err(f"{where}: cites {rid}, which is not in the rules")
        if status == "held" and item["expense"] != "forensic_exam":
            err(f"{where}: held but the expense is {item['expense']}")
        if line["cap_rule_id"] is None and line["allowed_cents"] < line["requested_cents"] and status == "eligible" \
                and not (law.collateral_ids and item.get("insurance_paid_cents")):
            err(f"{where}: allowed is below requested with no cap and no insurance to explain it")

    eligible = [line for line in lines if line["status"] == "eligible"]
    totals = out["totals"]
    if totals["requested_cents"] != sum(line["requested_cents"] for line in eligible):
        err("totals.requested_cents is not the sum of eligible lines")
    if totals["allowed_cents"] != sum(line["allowed_cents"] for line in eligible):
        err("totals.allowed_cents is not the sum of eligible lines")
    held = sum(line["requested_cents"] for line in lines if line["status"] == "held")
    if totals["held_cents"] != held:
        err(f"totals.held_cents {totals['held_cents']} != {held}")
    by_expense: dict[str, int] = defaultdict(int)
    for line in eligible:
        by_expense[line["expense"]] += line["allowed_cents"]
    if totals["by_expense"] != dict(by_expense):
        err(f"totals.by_expense {totals['by_expense']} != {dict(by_expense)}")

    for cap in law.claim_caps:
        spent = sum(line["allowed_cents"] for line in eligible if line["expense"] == cap.expense)
        if spent > cap.amount_cents:
            err(f"{cap.rule_id}: {cap.expense} allows {spent}, over the {cap.amount_cents} cap")
    if law.total_cap is not None and totals["allowed_cents"] > law.total_cap.amount_cents:
        err(f"{law.total_cap.rule_id}: total {totals['allowed_cents']} is over the cap")
    for cap in law.line_caps:
        for line in eligible:
            if line["expense"] != cap.expense:
                continue
            units = items[line["item_id"]].get("units") or 0
            measured = cap.per in UNIT_PERS and units > 0
            if measured and line["allowed_cents"] > cap.amount_cents * units:
                err(f"line {line['item_id']}: {line['allowed_cents']} over {cap.rule_id} rate x {units} units")
            if not measured and f"rate_unverified:{cap.rule_id}" not in line["flags"]:
                err(f"line {line['item_id']}: {cap.rule_id} could not be applied but the line is not flagged")

    checks = out["checks"]
    deadline = checks["deadline"]
    if deadline["status"] not in DEADLINE_STATUSES:
        err(f"deadline status {deadline['status']!r}")
    if (deadline["status"] == "unknown") != (deadline["deadline_date"] is None):
        err("deadline_date must be null exactly when the deadline is unknown")
    if deadline["deadline_date"] is not None:
        on_time = as_of <= date.fromisoformat(deadline["deadline_date"])
        if deadline["status"] != ("ok" if on_time else "late"):
            err(f"deadline {deadline['deadline_date']} vs as_of {as_of}: status {deadline['status']}")
    if checks["minimum_loss"]["status"] not in MINIMUM_LOSS_STATUSES:
        err(f"minimum_loss status {checks['minimum_loss']['status']!r}")
    if checks["reporting"]["status"] not in REPORTING_STATUSES:
        err(f"reporting status {checks['reporting']['status']!r}")
    if ctx.get("police_report") == "yes" and checks["reporting"]["status"] != "satisfied":
        err("a police report was made but reporting is not satisfied")
