"""Reference implementation of the Tend law engine (docs/SPEC.md v1.3, law IR version 2).

A plain reading of the SPEC, written to be checked by eye: the per-item decision (steps 1-6),
then the aggregate phase (steps 7-12). Where the SPEC leaves a choice open, this follows
engine/FORMAT.md section 4, which is normative for both engines. The C++ VM must produce the same
output document, trace included; refengine/difftest.py checks that on random claims.

Arithmetic saturates at the int64 limits exactly where the VM's does, so the two agree even on
claims whose totals pass 2^63.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date

from .claim import Claim, EngineInputError, Item, check_document, loads, read_claim
from .law import RULE_EXPENSES, Law, Rule

INT64_MAX = 2**63 - 1
INT64_MIN = -(2**63)
STATUSES = ("out_of_window", "held", "excluded", "unknown_rule", "needs_confirmation", "eligible")
# Deadline flags in note order: a period counted from either anchor is dated from the incident.
DEADLINE_FLAGS = (("report", "deadline_from_report"), ("discovery", "deadline_from_discovery"))
# Combining several minimum loss rules keeps the most severe status.
MINIMUM_LOSS_SEVERITY = ("met", "waived", "unknown", "may_be_waived", "not_met")
_EPOCH = date(1970, 1, 1).toordinal()
_FIRST_DAY = date(1, 1, 1).toordinal() - _EPOCH
_LAST_DAY = date(9999, 12, 31).toordinal() - _EPOCH


def _sat(v: int) -> int:
    return INT64_MAX if v > INT64_MAX else INT64_MIN if v < INT64_MIN else v


def sadd(a: int, b: int) -> int:
    return _sat(a + b)


def ssub(a: int, b: int) -> int:
    return _sat(a - b)


def smul(a: int, b: int) -> int:
    return _sat(a * b)


def format_day(day: int) -> str:
    # Days since 1970-01-01, shown within 0001-01-01..9999-12-31 like the VM.
    return date.fromordinal(min(max(day, _FIRST_DAY), _LAST_DAY) + _EPOCH).isoformat()


@dataclass
class Line:
    item: Item
    expense: str
    status: str = ""
    allowed: int = 0
    rule_ids: list[str] = field(default_factory=list)
    cap_rule_id: str | None = None
    alt_ids: list[str] = field(default_factory=list)
    flags: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "item_id": self.item.item_id,
            "expense": self.expense,
            "status": self.status,
            "requested_cents": self.item.amount_cents,
            "allowed_cents": self.allowed,
            "rule_ids": list(self.rule_ids),
            "cap_rule_id": self.cap_rule_id,
            "alt_cap_rule_ids": list(self.alt_ids),
            "flags": list(self.flags),
        }


class _Run:
    def __init__(self, law: Law, claim: Claim):
        self.law = law
        self.ctx = claim.context
        self.lines: list[Line] = []
        self.trace: list[dict] = []

    def log(self, op: str, line: Line | None, rule_id: str | None, delta: int = 0) -> None:
        self.trace.append({"op": op, "item_id": line.item.item_id if line else None, "rule_id": rule_id,
                           "delta_cents": delta})

    def decide(self, line: Line, status: str, proof: list[str], allowed: int = 0) -> None:
        line.status = status
        line.rule_ids = list(proof)
        self.log(status, line, proof[0] if proof else None, ssub(allowed, line.allowed))
        line.allowed = allowed

    # Steps 1-6: the first matching step decides the line.
    def item(self, it: Item) -> None:
        law, ctx = self.law, self.ctx
        line = Line(it, it.expense)
        self.lines.append(line)
        # 1. Outside [incident_date, as_of_date]: not related, never counted.
        if it.date < ctx.incident_date or it.date > ctx.as_of_date:
            return self.decide(line, "out_of_window", [])
        # 2. A survivor may not be billed for the exam: hold it. Without an exam_no_bill rule the
        #    exam is a medical cost like any other.
        if line.expense == "forensic_exam":
            if law.hold_proof:
                return self.decide(line, "held", law.hold_proof)
            line.expense = "medical"
        e = line.expense
        # 3. Excluded by law: every matching exclusion, in rule order.
        excluded = [r.id for r in law.excluded
                    if (r.expense is None or r.expense == e) and (not r.tags or r.tags & it.tags)]
        if excluded:
            return self.decide(line, "excluded", excluded)
        # 4. No rule names this expense: shown, never counted.
        coverage = law.coverage.get(e, [])
        if not coverage:
            return self.decide(line, "unknown_rule", [])
        line.alt_ids = [alt for r in coverage if r.kind == "expense_cap" for alt in r.alt_ids]
        proof = [r.id for r in coverage]
        # 5. Waiting for the survivor's yes.
        if not it.confirmed:
            return self.decide(line, "needs_confirmation", proof)
        # 6. Eligible; the program pays after insurance when a collateral rule exists.
        self.decide(line, "eligible", proof + law.collateral_ids, it.amount_cents)
        if law.collateral_ids:
            after = max(0, ssub(line.allowed, it.insurance_paid_cents))
            if after != line.allowed:
                self.log("collateral", line, law.collateral_ids[0], ssub(after, line.allowed))
                line.allowed = after

    def cap(self, line: Line, rule: Rule, value: int, op: str) -> None:
        self.log(op, line, rule.id, ssub(value, line.allowed))
        line.allowed = value
        line.cap_rule_id = rule.id

    def walk(self, lines: list[Line], rule: Rule, op: str) -> None:
        # The line that crosses the cap is cut to what is left; every later line goes to 0 and
        # records the cap, even one already at 0.
        used, crossed = 0, False
        for line in lines:
            if crossed:
                self.cap(line, rule, 0, op)
                continue
            if sadd(used, line.allowed) > rule.cap:
                self.cap(line, rule, ssub(rule.cap, used), op)
                crossed = True
            used = sadd(used, line.allowed)

    def finish(self) -> dict:
        law, ctx = self.law, self.ctx
        eligible = [line for line in self.lines if line.status == "eligible"]

        # 7a. Per-unit caps, rule by rule: they apply only to lines that count the cap's unit.
        for rule in law.unit_caps:
            remaining = rule.count_limit
            for line in eligible:
                if line.expense != rule.expense:
                    continue
                it = line.item
                if it.unit == rule.unit and it.units > 0:
                    counted = it.units
                    if remaining is not None:
                        counted = min(it.units, remaining)
                        remaining = ssub(remaining, counted)
                    limit = smul(rule.cap, counted)
                    if limit < line.allowed:
                        self.cap(line, rule, limit, "unit_cap")
                else:
                    line.flags.append(f"rate_unverified:{rule.id}")
                    self.log("rate_unverified", line, rule.id)
        # 7b. Per-claim caps, each walked over its expense's lines.
        for rule in law.claim_caps:
            self.walk([line for line in eligible if line.expense == rule.expense], rule, "expense_cap")
        # 8. The smallest total cap over every eligible line.
        if law.total_cap is not None:
            self.walk(eligible, law.total_cap, "total_cap")

        requested = allowed = held = 0
        by_expense: dict[str, int] = {}
        for line in self.lines:
            if line.status == "eligible":
                requested = sadd(requested, line.item.amount_cents)
                allowed = sadd(allowed, line.allowed)
                by_expense[line.expense] = sadd(by_expense.get(line.expense, 0), line.allowed)
            elif line.status == "held":
                held = sadd(held, line.item.amount_cents)

        minimum_loss = self.check("minimum_loss", law.minimum_loss, self.minimum_loss(eligible, allowed))  # 9
        status, day = self.deadline()  # 10
        deadline = self.check("deadline", law.deadlines, status)
        deadline = {"status": deadline["status"], "deadline_date": None if day is None else format_day(day),
                    "rule_ids": deadline["rule_ids"], "flags": deadline_flags(law)}
        reporting = self.check("reporting", law.reporting, self.reporting())  # 11
        return {
            "jurisdiction": law.jurisdiction,
            "law_image_sha256": law.law_sha256,
            "lines": [line.to_json() for line in self.lines],
            "totals": {"requested_cents": requested, "allowed_cents": allowed, "held_cents": held,
                       "by_expense": dict(sorted(by_expense.items()))},
            "checks": {"deadline": deadline, "minimum_loss": minimum_loss, "reporting": reporting},
            "info_rule_ids": list(law.info_ids),  # 12. listed for display only
            "trace": self.trace,
        }

    def check(self, name: str, rules: list[Rule], status: str) -> dict:
        ids = [r.id for r in rules]
        self.log(name, None, ids[0] if ids else None)
        return {"status": status, "rule_ids": ids}

    def minimum_loss(self, eligible: list[Line], total: int) -> str:
        # Weeks of lost wages count five working days each.
        weeks = days = 0
        for line in eligible:
            if line.expense == "lost_wages":
                if line.item.unit == "week":
                    weeks = sadd(weeks, line.item.units)
                elif line.item.unit == "day":
                    days = sadd(days, line.item.units)
        lost_days = sadd(smul(weeks, 5), days)
        worst = 0
        for rule in self.law.minimum_loss:
            if (rule.cap is not None and total >= rule.cap) or (rule.days_lost is not None and lost_days >= rule.days_lost):
                continue
            if rule.cap is None:
                status = "unknown"  # only a day count, which the claim does not reach
            elif rule.waiver_sa and rule.waiver == "automatic":
                status = "waived"
            elif rule.waiver_sa and rule.waiver == "discretionary":
                status = "may_be_waived"
            else:
                status = "not_met"
            worst = max(worst, MINIMUM_LOSS_SEVERITY.index(status))
        return MINIMUM_LOSS_SEVERITY[worst]

    def deadline(self) -> tuple[str, int | None]:
        # Every period runs from the incident date (one counted from the report or from discovery
        # runs from the earliest either can be, and is flagged); the latest date wins.
        if not self.law.deadlines:
            return "unknown", None
        latest = max(sadd(self.ctx.incident_date, r.days) for r in self.law.deadlines)
        return ("ok" if self.ctx.as_of_date <= latest else "late"), latest

    def reporting(self) -> str:
        ctx, rules = self.ctx, self.law.reporting
        if ctx.police_report == "yes" or (ctx.forensic_exam and any(r.alt_exam for r in rules)):
            return "satisfied"
        if any(r.required for r in rules):
            return "required" if ctx.police_report == "no" else "unknown"
        return "not_required"


def deadline_flags(law: Law) -> list[str]:
    """checks.deadline.flags: one flag per anchor that can start later than the incident."""
    return [flag for anchor, flag in DEADLINE_FLAGS if any(r.anchor == anchor for r in law.deadlines)]


def _sort_key(it: Item):
    return it.date, it.item_id.encode("utf-8")


def run_claim(law: Law, claim: Claim) -> dict:
    run = _Run(law, claim)
    for it in sorted(claim.items, key=_sort_key):
        run.item(it)
    return run.finish()


def evaluate_law(law: Law, engine_input) -> dict:
    """Evaluates a parsed engine input (a dict). Raises EngineInputError on bad input."""
    check_document(engine_input)
    return run_claim(law, read_claim(engine_input, law))


def evaluate(rules, engine_input, *, law_sha256: str | None = None) -> dict:
    """Evaluates one claim against a law: `rules` is a Law or an IR document (dict)."""
    law = rules if isinstance(rules, Law) else Law(rules, law_sha256=law_sha256)
    return evaluate_law(law, engine_input)


def dumps(doc: dict) -> str:
    # The C++ writer's bytes: compact, keys in document order, UTF-8 kept.
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":"))


def evaluate_json(law: Law, raw: bytes | str) -> str:
    """Claim JSON text in, result JSON text out, the way tend_eval_json works: an error document
    instead of an exception."""
    try:
        return dumps(run_claim(law, read_claim(loads(raw), law)))
    except EngineInputError as e:
        return dumps(e.document())
