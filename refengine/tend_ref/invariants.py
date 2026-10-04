"""Properties every engine output must satisfy for any law and valid input.

They hold for the reference by construction and for the C++ engine if it is right, so the
difftest checks them on every claim, and they still mean something when no C++ engine is built.
"""

from __future__ import annotations

from collections import defaultdict

from .claim import read_claim
from .engine import DEADLINE_FLAGS, INT64_MAX, MINIMUM_LOSS_SEVERITY, STATUSES, format_day
from .law import Law

DEADLINE_STATUSES = {"ok", "late", "unknown"}
REPORTING_STATUSES = {"satisfied", "required", "not_required", "unknown"}


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
    try:
        _check(law, engine_input, out, errors.append)
    except (KeyError, TypeError, ValueError, AttributeError, IndexError) as e:
        errors.append(f"output has the wrong shape: {type(e).__name__}: {e}")
    return errors


def _check(law: Law, engine_input: dict, out: dict, err) -> None:
    for path in _non_int_numbers(out):
        err(f"{path} is a float; money is integer cents")

    claim = read_claim(engine_input, law)
    ctx = claim.context
    items = {it.item_id: it for it in claim.items}
    known = set(law.by_id)
    lines = out["lines"]

    if sorted(line["item_id"] for line in lines) != sorted(items):
        err("lines do not match the input items one to one")
        return
    order = [(items[line["item_id"]].date, line["item_id"].encode()) for line in lines]
    if order != sorted(order):
        err("lines are not in (date, item_id) order")

    trace_sum: dict[str, int] = defaultdict(int)
    for entry in out["trace"]:
        if entry["item_id"] is not None:
            trace_sum[entry["item_id"]] += entry["delta_cents"]

    for line in lines:
        item_id, status = line["item_id"], line["status"]
        it = items[item_id]
        where = f"line {item_id}"
        if status not in STATUSES:
            err(f"{where}: unknown status {status!r}")
        if line["requested_cents"] != it.amount_cents:
            err(f"{where}: requested_cents {line['requested_cents']} != amount_cents {it.amount_cents}")
        if not 0 <= line["allowed_cents"] <= line["requested_cents"]:
            err(f"{where}: allowed_cents {line['allowed_cents']} outside [0, requested]")
        if status != "eligible" and line["allowed_cents"] != 0:
            err(f"{where}: {status} line allows {line['allowed_cents']}")
        if status == "eligible" and law.collateral_ids and line["allowed_cents"] > max(0, it.amount_cents - it.insurance_paid_cents):
            err(f"{where}: allows more than is left after insurance")
        if trace_sum[item_id] != line["allowed_cents"]:
            err(f"{where}: trace deltas sum to {trace_sum[item_id]}, line allows {line['allowed_cents']}")
        in_window = ctx.incident_date <= it.date <= ctx.as_of_date
        if (status == "out_of_window") == in_window:
            err(f"{where}: status {status} but the date is {'inside' if in_window else 'outside'} the window")
        if status in ("held", "excluded", "needs_confirmation", "eligible") and not line["rule_ids"]:
            err(f"{where}: {status} line has no proof")
        if status in ("out_of_window", "unknown_rule") and line["rule_ids"]:
            err(f"{where}: {status} line cites rules")
        for rid in line["rule_ids"] + line["alt_cap_rule_ids"] + ([line["cap_rule_id"]] if line["cap_rule_id"] else []):
            if rid not in known:
                err(f"{where}: cites {rid}, which is not in the law")
        if status == "held" and (it.expense != "forensic_exam" or not law.exam_no_bill):
            err(f"{where}: held without an exam and an exam_no_bill rule")
        if it.expense == "forensic_exam" and in_window and law.exam_no_bill and status != "held":
            err(f"{where}: an exam the law says cannot be billed is not held")
        expected_expense = "medical" if it.expense == "forensic_exam" and in_window and not law.exam_no_bill else it.expense
        if line["expense"] != expected_expense:
            err(f"{where}: expense {line['expense']}, expected {expected_expense}")
        if line["cap_rule_id"] is None and line["allowed_cents"] < line["requested_cents"] and status == "eligible" \
                and not (law.collateral_ids and it.insurance_paid_cents):
            err(f"{where}: allowed is below requested with no cap and no insurance to explain it")
        if status not in ("eligible", "needs_confirmation") and line["alt_cap_rule_ids"]:
            err(f"{where}: {status} line lists alternate caps")
        if status != "eligible" and line["flags"]:
            err(f"{where}: {status} line has flags")

    eligible = [line for line in lines if line["status"] == "eligible"]
    totals = out["totals"]

    def total(values) -> int:
        return min(sum(values), INT64_MAX)

    if totals["requested_cents"] != total(line["requested_cents"] for line in eligible):
        err("totals.requested_cents is not the sum of eligible lines")
    if totals["allowed_cents"] != total(line["allowed_cents"] for line in eligible):
        err("totals.allowed_cents is not the sum of eligible lines")
    if totals["held_cents"] != total(line["requested_cents"] for line in lines if line["status"] == "held"):
        err("totals.held_cents is not the sum of held lines")
    by_expense: dict[str, list[int]] = defaultdict(list)
    for line in eligible:
        by_expense[line["expense"]].append(line["allowed_cents"])
    if totals["by_expense"] != {e: total(v) for e, v in sorted(by_expense.items())}:
        err(f"totals.by_expense {totals['by_expense']} does not match the eligible lines")
    if list(totals["by_expense"]) != sorted(totals["by_expense"]):
        err("totals.by_expense keys are not sorted")

    for rule in law.claim_caps:
        spent = sum(line["allowed_cents"] for line in eligible if line["expense"] == rule.expense)
        if spent > rule.cap:
            err(f"{rule.id}: {rule.expense} allows {spent}, over the {rule.cap} cap")
    if law.total_cap is not None and sum(line["allowed_cents"] for line in eligible) > law.total_cap.cap:
        err(f"{law.total_cap.id}: the total is over the cap")
    for rule in law.unit_caps:
        flag = f"rate_unverified:{rule.id}"
        measured_total = 0
        for line in eligible:
            if line["expense"] != rule.expense:
                continue
            it = items[line["item_id"]]
            measured = it.unit == rule.unit and it.units > 0
            if measured:
                measured_total += line["allowed_cents"]
                if line["allowed_cents"] > rule.cap * it.units:
                    err(f"line {it.item_id}: {line['allowed_cents']} over {rule.id} rate x {it.units} {rule.unit}")
            if measured == (flag in line["flags"]):
                err(f"line {it.item_id}: {rule.id} {'applied' if measured else 'could not apply'} but the flag says otherwise")
        if rule.count_limit is not None and measured_total > rule.cap * rule.count_limit:
            err(f"{rule.id}: {measured_total} paid for more than {rule.count_limit} {rule.unit}s")

    checks = out["checks"]
    deadline = checks["deadline"]
    if deadline["status"] not in DEADLINE_STATUSES:
        err(f"deadline status {deadline['status']!r}")
    if (deadline["status"] == "unknown") != (deadline["deadline_date"] is None) or \
            (deadline["status"] == "unknown") != (not law.deadlines):
        err("deadline_date must be null exactly when there is no deadline rule")
    if law.deadlines:
        latest = max(ctx.incident_date + r.days for r in law.deadlines)
        if deadline["deadline_date"] != format_day(latest):
            err(f"deadline_date {deadline['deadline_date']} is not the latest period from the incident")
        if deadline["status"] != ("ok" if ctx.as_of_date <= latest else "late"):
            err(f"deadline status {deadline['status']} disagrees with the date")
    anchors = {r.anchor for r in law.deadlines}
    if deadline["flags"] != [flag for anchor, flag in DEADLINE_FLAGS if anchor in anchors]:
        err(f"deadline flags {deadline['flags']}")
    if checks["minimum_loss"]["status"] not in MINIMUM_LOSS_SEVERITY:
        err(f"minimum_loss status {checks['minimum_loss']['status']!r}")
    if not law.minimum_loss and checks["minimum_loss"]["status"] != "met":
        err("minimum_loss must be met when the law sets no minimum")
    if checks["reporting"]["status"] not in REPORTING_STATUSES:
        err(f"reporting status {checks['reporting']['status']!r}")
    if ctx.police_report == "yes" and checks["reporting"]["status"] != "satisfied":
        err("a police report was made but reporting is not satisfied")
    for name, rules in (("deadline", law.deadlines), ("minimum_loss", law.minimum_loss), ("reporting", law.reporting)):
        if checks[name]["rule_ids"] != [r.id for r in rules]:
            err(f"checks.{name}.rule_ids do not list the law's {name} rules")
    if out["info_rule_ids"] != law.info_ids:
        err("info_rule_ids are not the law's info rules")
