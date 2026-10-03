"""Reference implementation of the Tend law engine.

A direct reading of "Law engine semantics" in docs/SPEC.md: per-item decisions (steps 1-6), then
the aggregate phase (steps 7-12). The C++ VM must produce the same output for the same rules and
input; refengine/difftest.py checks that on random claims. Where the SPEC leaves a choice open,
the reading used here is marked "Reading:" and listed in refengine/README.md.
"""

from __future__ import annotations

import calendar
import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

EXPENSES = frozenset({
    "medical", "forensic_exam", "counseling", "lost_wages", "transportation", "relocation",
    "temporary_housing", "security", "crime_scene_cleanup", "childcare", "property_replacement",
    "clothing_bedding", "prescription", "dental", "funeral", "legal", "tuition", "other",
})
STATUSES = ("out_of_window", "held", "excluded", "unknown_rule", "needs_confirmation", "eligible")
POLICE_REPORT_VALUES = ("yes", "no", "unknown")
UNIT_PERS = frozenset({"week", "session", "hour", "mile", "day"})
INFO_CATEGORIES = frozenset({
    "collateral_source", "conduct_reduction", "emergency_award", "eligible_crime", "residency",
})
# Integers above 2^53 - 1 do not survive a JSON round trip through JavaScript (the WASM build).
MAX_SAFE_INT = 2**53 - 1

_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


class EngineInputError(ValueError):
    pass


def rule_expense(rule: dict) -> str | None:
    params = rule.get("params")
    return rule.get("expense") or (params.get("expense") if isinstance(params, dict) else None)


def _params(rule: dict) -> dict:
    params = rule.get("params")
    return params if isinstance(params, dict) else {}


def _count(value) -> int | None:
    # A rule's numeric parameter, or None when absent or malformed.
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_SAFE_INT:
        return value
    return None


def add_years(start: date, years: int) -> date:
    # Calendar years; Feb 29 lands on Feb 28 in a non-leap year (the earlier, safer deadline).
    year = start.year + years
    if year > date.max.year:
        return date.max
    if start.month == 2 and start.day == 29 and not calendar.isleap(year):
        return date(year, 2, 28)
    return start.replace(year=year)


def add_days(start: date, days: int) -> date:
    try:
        return start + timedelta(days=days)
    except OverflowError:
        return date.max


def canonical_sha256(obj) -> str:
    text = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Cap:
    rule_id: str
    expense: str | None  # None for the total cap
    amount_cents: int
    per: str


@dataclass(frozen=True)
class Context:
    incident_date: date
    as_of_date: date
    police_report: str
    forensic_exam: bool


@dataclass(frozen=True)
class Item:
    item_id: str
    date: date
    amount_cents: int
    expense: str
    confirmed: bool
    insurance_paid_cents: int
    is_bill: bool
    units: int


@dataclass
class Line:
    item: Item
    expense: str
    status: str = ""
    allowed_cents: int = 0
    rule_ids: list[str] = field(default_factory=list)
    cap_rule_id: str | None = None
    flags: list[str] = field(default_factory=list)

    @property
    def requested_cents(self) -> int:
        return self.item.amount_cents

    def to_json(self) -> dict:
        return {
            "item_id": self.item.item_id,
            "expense": self.expense,
            "status": self.status,
            "requested_cents": self.requested_cents,
            "allowed_cents": self.allowed_cents,
            "rule_ids": list(self.rule_ids),
            "cap_rule_id": self.cap_rule_id,
            "flags": list(self.flags),
        }


class Law:
    """One jurisdiction's verified rules, indexed by the step that uses them."""

    def __init__(self, rules: dict, law_sha256: str | None = None):
        if not isinstance(rules, dict) or not isinstance(rules.get("rules"), list):
            raise EngineInputError("rules must be a verified jurisdiction object with a 'rules' list")
        jurisdiction = rules.get("jurisdiction")
        if not isinstance(jurisdiction, str) or not jurisdiction:
            raise EngineInputError("rules.jurisdiction must be a non-empty string")
        self.jurisdiction = jurisdiction
        self.law_sha256 = law_sha256 or canonical_sha256(rules)

        seen: set[str] = set()
        for rule in rules["rules"]:
            if not isinstance(rule, dict) or not isinstance(rule.get("id"), str) \
                    or not isinstance(rule.get("category"), str):
                raise EngineInputError("every rule needs a string id and category")
            if rule["id"] in seen:
                raise EngineInputError(f"duplicate rule id {rule['id']}")
            seen.add(rule["id"])
        self.rules: list[dict] = rules["rules"]

        def of(category: str) -> list[dict]:
            return [r for r in self.rules if r["category"] == category]

        # Reading: exam rules prove a hold only when they name forensic_exam or no expense. A rule
        # filed under exam_payment that names "medical" (e.g. nonforensic care the facility may
        # bill for) is not proof that the exam bill must be held.
        def exam_scoped(r: dict) -> bool:
            return rule_expense(r) in (None, "forensic_exam")

        self.exam_hold_ids = [r["id"] for r in of("exam_no_bill") if exam_scoped(r)] \
            + [r["id"] for r in of("exam_payment") if exam_scoped(r)]

        self.excluded: dict[str, list[str]] = {}
        self.coverage: dict[str, list[str]] = {}  # covered_expense and expense_cap, file order
        for r in self.rules:
            expense = rule_expense(r)
            if not expense:
                continue  # rules that only describe an item in text name no expense
            if r["category"] == "excluded_expense":
                self.excluded.setdefault(expense, []).append(r["id"])
            elif r["category"] in ("covered_expense", "expense_cap"):
                self.coverage.setdefault(expense, []).append(r["id"])

        self.collateral_ids = [r["id"] for r in of("collateral_source")]

        # Reading: a cap without amount_cents limits nothing (count_limit and weeks are not
        # enforced). Any per outside UNIT_PERS (claim, crime_scene, residence, or missing) is
        # a claim cap: a claim covers one crime scene and, as far as the engine knows, one home.
        self.rate_caps: list[Cap] = []
        self.claim_caps: list[Cap] = []
        for r in of("expense_cap"):
            expense = rule_expense(r)
            amount = _count(_params(r).get("amount_cents"))
            if not expense or amount is None:
                continue
            per = _params(r).get("per")
            per = per if isinstance(per, str) else "claim"
            cap = Cap(r["id"], expense, amount, per)
            (self.rate_caps if per in UNIT_PERS else self.claim_caps).append(cap)

        total_caps = []
        for r in of("total_cap"):
            amount = _count(_params(r).get("amount_cents"))
            if amount is not None:
                total_caps.append(Cap(r["id"], None, amount, "claim"))
        # The smallest total cap governs; min() keeps the first one on ties.
        self.total_cap = min(total_caps, key=lambda c: c.amount_cents) if total_caps else None

        self.minimum_loss_rules = of("minimum_loss")
        self.deadline_rules = of("filing_deadline")
        self.reporting_rules = of("reporting_requirement")
        self.info_rule_ids = [r["id"] for r in self.rules if r["category"] in INFO_CATEGORIES]

    def evaluate(self, engine_input: dict) -> dict:
        ctx, items = parse_input(engine_input, self.jurisdiction)
        run = _Evaluation(self, ctx)
        for item in sorted(items, key=lambda it: (it.date, it.item_id)):
            run.decide(item)
        return run.finish()


class _Evaluation:
    def __init__(self, law: Law, ctx: Context):
        self.law = law
        self.ctx = ctx
        self.lines: list[Line] = []
        self.trace: list[dict] = []

    def log(self, op: str, item_id: str | None = None, rule_id: str | None = None,
            delta_cents: int = 0) -> None:
        self.trace.append({"op": op, "item_id": item_id, "rule_id": rule_id,
                           "delta_cents": delta_cents})

    def settle(self, line: Line, status: str, rule_ids: list[str], delta_cents: int = 0) -> None:
        line.status = status
        line.rule_ids = list(rule_ids)
        self.log(status, line.item.item_id, rule_ids[0] if rule_ids else None, delta_cents)

    # Steps 1-6: the first matching step decides the line's status.
    def decide(self, item: Item) -> None:
        law, ctx = self.law, self.ctx
        line = Line(item, item.expense)
        self.lines.append(line)

        # 1. Costs outside [incident_date, as_of_date] are unrelated and never counted.
        if item.date < ctx.incident_date or item.date > ctx.as_of_date:
            self.settle(line, "out_of_window", [])
            return

        # 2. A survivor should never be billed for the forensic exam: hold it, do not claim it.
        if line.expense == "forensic_exam":
            if law.exam_hold_ids:
                self.settle(line, "held", law.exam_hold_ids)
                return
            line.expense = "medical"
            self.log("exam_as_medical", item.item_id)

        # 3. Excluded by law.
        excluded = law.excluded.get(line.expense)
        if excluded:
            self.settle(line, "excluded", excluded)
            return

        # 4. No rule covers this expense: shown, never counted.
        coverage = law.coverage.get(line.expense)
        if not coverage or line.expense == "unknown":
            self.settle(line, "unknown_rule", [])
            return

        # 5. Inferred lines wait for the survivor's yes.
        if not item.confirmed:
            self.settle(line, "needs_confirmation", coverage)
            return

        # 6. Eligible. The program pays after insurance when a collateral_source rule exists.
        line.allowed_cents = item.amount_cents
        self.settle(line, "eligible", coverage, item.amount_cents)
        if law.collateral_ids:
            after = max(0, line.allowed_cents - item.insurance_paid_cents)
            self.log("collateral", item.item_id, law.collateral_ids[0], after - line.allowed_cents)
            line.allowed_cents = after
            line.rule_ids += law.collateral_ids

    def cut(self, line: Line, cap: Cap, limit: int, op: str) -> None:
        if line.allowed_cents > limit:
            self.log(op, line.item.item_id, cap.rule_id, limit - line.allowed_cents)
            line.allowed_cents = limit
            line.cap_rule_id = cap.rule_id

    def walk(self, lines: list[Line], cap: Cap, op: str) -> None:
        # Reading: only a line whose allowed amount exceeds the remaining room is cut and gets
        # cap_rule_id. A later line already at 0 (say, paid in full by insurance) is left alone.
        room = cap.amount_cents
        for line in lines:
            self.cut(line, cap, room, op)
            room -= line.allowed_cents

    def finish(self) -> dict:
        law = self.law
        eligible = [line for line in self.lines if line.status == "eligible"]

        # 7a. Per-unit caps run before claim caps, so the claim walk sees rate-limited amounts.
        for cap in law.rate_caps:
            for line in eligible:
                if line.expense != cap.expense:
                    continue
                if line.item.units > 0:
                    self.cut(line, cap, cap.amount_cents * line.item.units, "rate_cap")
                else:
                    line.flags.append(f"rate_unverified:{cap.rule_id}")
                    self.log("rate_unverified", line.item.item_id, cap.rule_id)

        # 7b. Claim caps, each walked over its expense's eligible lines in (date, item_id) order.
        for cap in law.claim_caps:
            self.walk([line for line in eligible if line.expense == cap.expense], cap, "expense_cap")

        # 8. Total cap over every eligible line.
        if law.total_cap is not None:
            self.walk(eligible, law.total_cap, "total_cap")

        by_expense: dict[str, int] = {}
        for line in eligible:
            by_expense[line.expense] = by_expense.get(line.expense, 0) + line.allowed_cents
        totals = {
            "requested_cents": sum(line.requested_cents for line in eligible),
            "allowed_cents": sum(line.allowed_cents for line in eligible),
            "held_cents": sum(line.requested_cents for line in self.lines if line.status == "held"),
            "by_expense": dict(sorted(by_expense.items())),
        }

        minimum_loss = self.check_minimum_loss(totals["allowed_cents"])  # 9
        deadline = self.check_deadline()  # 10
        reporting = self.check_reporting()  # 11

        return {
            "jurisdiction": law.jurisdiction,
            "law_image_sha256": law.law_sha256,
            "lines": [line.to_json() for line in self.lines],
            "totals": totals,
            "checks": {"deadline": deadline, "minimum_loss": minimum_loss, "reporting": reporting},
            "info_rule_ids": list(law.info_rule_ids),  # 12. listed for display only
            "trace": self.trace,
        }

    def check_minimum_loss(self, total_allowed: int) -> dict:
        rules = self.law.minimum_loss_rules
        with_amount = [(r, a) for r in rules if (a := _count(_params(r).get("amount_cents"))) is not None]
        if with_amount:
            below = [r for r, amount in with_amount if total_allowed < amount]
            unwaived = [r for r in below if not self.waived(r)]
            if unwaived:
                status, rule_id = "not_met", unwaived[0]["id"]
            elif below:
                status, rule_id = "waived", below[0]["id"]
            else:
                status, rule_id = "met", None
        else:
            days_only = [r for r in rules if _count(_params(r).get("days_lost")) is not None]
            # Reading: no rule, or only rules with neither threshold (one says there is no
            # minimum), means there is nothing to fail.
            status, rule_id = ("unknown", days_only[0]["id"]) if days_only else ("met", None)
        self.log(f"minimum_loss_{status}", rule_id=rule_id)
        return {"status": status, "rule_ids": [r["id"] for r in rules]}

    def waived(self, rule: dict) -> bool:
        waived_for = _params(rule).get("waived_for")
        values = waived_for if isinstance(waived_for, list) else [waived_for]
        return self.ctx.forensic_exam and "sexual_assault" in values

    def check_deadline(self) -> dict:
        rules = self.law.deadline_rules
        best: tuple[date, str] | None = None
        for r in rules:
            p = _params(r)
            # Reading: a period that runs from the 18th birthday cannot be dated from the
            # incident; counting it from the incident would overstate an adult's deadline.
            if p.get("from") == "age_18":
                continue
            years, days = _count(p.get("years")), _count(p.get("days"))
            if years is not None:
                deadline = add_years(self.ctx.incident_date, years)
            elif days is not None:
                deadline = add_days(self.ctx.incident_date, days)
            else:
                continue
            if best is None or deadline > best[0]:
                best = (deadline, r["id"])

        if best is None:
            status, deadline_date, rule_id = "unknown", None, None
        else:
            status = "ok" if self.ctx.as_of_date <= best[0] else "late"
            deadline_date, rule_id = best[0].isoformat(), best[1]
        self.log(f"deadline_{status}", rule_id=rule_id)
        return {"status": status, "deadline_date": deadline_date, "rule_ids": [r["id"] for r in rules]}

    def check_reporting(self) -> dict:
        ctx, rules = self.ctx, self.law.reporting_rules

        def alternatives_of(r: dict) -> list:
            alts = _params(r).get("alternatives")
            return alts if isinstance(alts, list) else []

        alternatives: list = []
        for r in rules:
            for alt in alternatives_of(r):
                if alt not in alternatives:
                    alternatives.append(alt)
        # A rule without the required param still counts as a requirement.
        requiring = [r for r in rules if _params(r).get("required", True) is not False]
        exam_rule = next((r for r in rules if "forensic_exam" in alternatives_of(r)), None)

        if ctx.police_report == "yes":
            status, rule_id = "satisfied", None
        elif ctx.forensic_exam and exam_rule is not None:
            status, rule_id = "satisfied", exam_rule["id"]
        elif not requiring:
            status, rule_id = "satisfied", None
        # Reading: "no alternative applies" holds only when every listed alternative is one the
        # engine can rule out. Only forensic_exam is known; a protective order or advocate might
        # still apply, so those cases stay unknown rather than "required".
        elif ctx.police_report == "no" and all(alt == "forensic_exam" for alt in alternatives):
            status, rule_id = "required", requiring[0]["id"]
        else:
            status, rule_id = "unknown", requiring[0]["id"]
        self.log(f"reporting_{status}", rule_id=rule_id)
        return {"status": status, "rule_ids": [r["id"] for r in rules]}


def _date(value, where: str) -> date:
    if not isinstance(value, str) or not _DATE_RE.fullmatch(value):
        raise EngineInputError(f"{where} must be a YYYY-MM-DD date")
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise EngineInputError(f"{where} is not a calendar date: {value}") from None


def _int(value, where: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= MAX_SAFE_INT:
        raise EngineInputError(f"{where} must be a whole number from 0 to 2^53 - 1")
    return value


def _bool(value, where: str) -> bool:
    if not isinstance(value, bool):
        raise EngineInputError(f"{where} must be true or false")
    return value


def _get(obj: dict, key: str, default):
    value = obj.get(key)
    return default if value is None else value


def parse_input(data: dict, jurisdiction: str) -> tuple[Context, list[Item]]:
    if not isinstance(data, dict):
        raise EngineInputError("engine input must be a JSON object")
    claimed = _get(data, "jurisdiction", jurisdiction)
    if not isinstance(claimed, str) or claimed.upper() != jurisdiction.upper():
        raise EngineInputError(f"input is for {claimed!r} but the rules are for {jurisdiction}")

    raw_ctx = data.get("context")
    if not isinstance(raw_ctx, dict):
        raise EngineInputError("context must be an object")
    police_report = _get(raw_ctx, "police_report", "unknown")
    if police_report not in POLICE_REPORT_VALUES:
        raise EngineInputError("context.police_report must be yes, no, or unknown")
    ctx = Context(
        incident_date=_date(raw_ctx.get("incident_date"), "context.incident_date"),
        as_of_date=_date(raw_ctx.get("as_of_date"), "context.as_of_date"),
        police_report=police_report,
        forensic_exam=_bool(_get(raw_ctx, "forensic_exam", False), "context.forensic_exam"),
    )

    raw_items = _get(data, "items", [])
    if not isinstance(raw_items, list):
        raise EngineInputError("items must be a list")
    items: list[Item] = []
    seen: set[str] = set()
    for n, raw in enumerate(raw_items):
        where = f"items[{n}]"
        if not isinstance(raw, dict):
            raise EngineInputError(f"{where} must be an object")
        item_id = raw.get("item_id")
        if not isinstance(item_id, str) or not item_id:
            raise EngineInputError(f"{where}.item_id must be a non-empty string")
        if item_id in seen:
            raise EngineInputError(f"duplicate item_id {item_id!r}")
        seen.add(item_id)
        expense = _get(raw, "expense", "unknown")
        if not isinstance(expense, str):
            raise EngineInputError(f"{where}.expense must be a string")
        items.append(Item(
            item_id=item_id,
            date=_date(raw.get("date"), f"{where}.date"),
            amount_cents=_int(raw.get("amount_cents"), f"{where}.amount_cents"),
            expense=expense,
            confirmed=_bool(_get(raw, "confirmed", False), f"{where}.confirmed"),
            insurance_paid_cents=_int(_get(raw, "insurance_paid_cents", 0),
                                      f"{where}.insurance_paid_cents"),
            is_bill=_bool(_get(raw, "is_bill", False), f"{where}.is_bill"),
            units=_int(_get(raw, "units", 0), f"{where}.units"),
        ))
    return ctx, items


def evaluate(rules: dict, engine_input: dict, *, law_sha256: str | None = None) -> dict:
    """Evaluate one claim. `law_sha256` defaults to the sha256 of the canonical rules JSON."""
    return Law(rules, law_sha256).evaluate(engine_input)


def load_rules(path: str | Path) -> tuple[dict, str]:
    """Read a verified jurisdiction file; returns (rules, sha256 of the file bytes)."""
    raw = Path(path).read_bytes()
    return json.loads(raw), hashlib.sha256(raw).hexdigest()
