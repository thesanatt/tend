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
# Parameter bounds tendc enforces, so a rule file both engines accept reads the same in both.
PARAM_LIMITS = {"amount_cents": 10**15, "years": 1000, "days": 1_000_000}
PARAM_KEYS = {
    "total_cap": ("amount_cents",), "expense_cap": ("amount_cents",), "minimum_loss": ("amount_cents",),
    "filing_deadline": ("years", "days"),
}

_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


class EngineInputError(ValueError):
    pass


def rule_expense(rule: dict) -> str | None:
    # A non-string expense names nothing, as in tendc.
    params = rule.get("params")
    for value in (rule.get("expense"), params.get("expense") if isinstance(params, dict) else None):
        if isinstance(value, str) and value:
            return value
    return None


def _params(rule: dict) -> dict:
    params = rule.get("params")
    return params if isinstance(params, dict) else {}


def _count(value) -> int | None:
    # A rule's numeric parameter, or None when absent or malformed.
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_SAFE_INT:
        return value
    return None


def add_years(start: date, years: int) -> date:
    # Calendar years; Feb 29 lands on Feb 28 in a non-leap year.
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
            _check_rule(rule)
        self.rules: list[dict] = rules["rules"]

        def ids(category: str) -> list[str]:
            return [r["id"] for r in self.rules if r["category"] == category]

        # Step 2 proof: every exam_no_bill rule, then every exam_payment rule.
        self.exam_hold_ids = ids("exam_no_bill") + ids("exam_payment")
        self.collateral_ids = ids("collateral_source")
        self.info_rule_ids = [r["id"] for r in self.rules if r["category"] in INFO_CATEGORIES]

        self.excluded: dict[str, list[str]] = {}
        self.coverage: dict[str, list[str]] = {}  # covered_expense and expense_cap, file order
        for r in self.rules:
            expense = rule_expense(r)
            if not expense:
                continue  # a rule that only describes an item in text names no expense
            if r["category"] == "excluded_expense":
                self.excluded.setdefault(expense, []).append(r["id"])
            elif r["category"] in ("covered_expense", "expense_cap"):
                self.coverage.setdefault(expense, []).append(r["id"])

        # Reading: a cap without amount_cents limits nothing (count_limit and weeks are not
        # enforced). A missing per means per claim. A per the engine cannot measure (residence,
        # crime_scene, month, item, ...) goes with the unit caps and flags every matching line.
        self.line_caps: list[Cap] = []  # unit caps and unmeasurable caps, file order
        self.claim_caps: list[Cap] = []
        for r in self.rules:
            if r["category"] != "expense_cap":
                continue
            expense, amount = rule_expense(r), _count(_params(r).get("amount_cents"))
            if not expense or amount is None:
                continue
            per = _params(r).get("per")
            cap = Cap(r["id"], expense, amount, per if isinstance(per, str) else "claim")
            (self.claim_caps if cap.per == "claim" else self.line_caps).append(cap)

        total_caps = [Cap(r["id"], None, a, "claim") for r in self.rules
                      if r["category"] == "total_cap" and (a := _count(_params(r).get("amount_cents"))) is not None]
        # The smallest total cap governs; min() keeps the first one on ties.
        self.total_cap = min(total_caps, key=lambda c: c.amount_cents) if total_caps else None

        self.minimum_loss_rules = [r for r in self.rules if r["category"] == "minimum_loss"]
        self.deadline_rules = [r for r in self.rules if r["category"] == "filing_deadline"]
        self.reporting_rules = [r for r in self.rules if r["category"] == "reporting_requirement"]

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

        # 3. Excluded by law.
        excluded = law.excluded.get(line.expense)
        if excluded:
            self.settle(line, "excluded", excluded)
            return

        # 4. No rule covers this expense: shown, never counted.
        coverage = law.coverage.get(line.expense)
        if not coverage:
            self.settle(line, "unknown_rule", [])
            return

        # 5. Inferred lines wait for the survivor's yes.
        if not item.confirmed:
            self.settle(line, "needs_confirmation", coverage)
            return

        # 6. Eligible. The program pays after insurance when a collateral_source rule exists.
        line.allowed_cents = item.amount_cents
        self.settle(line, "eligible", coverage + law.collateral_ids, item.amount_cents)
        if law.collateral_ids:
            after = max(0, line.allowed_cents - item.insurance_paid_cents)
            if after != line.allowed_cents:
                self.log("collateral", item.item_id, law.collateral_ids[0], after - line.allowed_cents)
                line.allowed_cents = after

    def cap(self, line: Line, cap: Cap, value: int, op: str) -> None:
        self.log(op, line.item.item_id, cap.rule_id, value - line.allowed_cents)
        line.allowed_cents = value
        line.cap_rule_id = cap.rule_id

    def flag(self, line: Line, cap: Cap) -> None:
        line.flags.append(f"rate_unverified:{cap.rule_id}")
        self.log("rate_unverified", line.item.item_id, cap.rule_id)

    def walk(self, lines: list[Line], cap: Cap, op: str) -> None:
        # The line that crosses the cap is cut to what is left; every later line goes to 0 and
        # records the cap, even a line that was already at 0.
        used, crossed = 0, False
        for line in lines:
            if crossed:
                self.cap(line, cap, 0, op)
            elif used + line.allowed_cents > cap.amount_cents:
                self.cap(line, cap, cap.amount_cents - used, op)
                crossed = True
            else:
                used += line.allowed_cents

    def finish(self) -> dict:
        law = self.law
        eligible = [line for line in self.lines if line.status == "eligible"]

        # 7a. Unit caps (and caps the engine cannot measure), before claim caps so the claim
        # walk sees rate-limited amounts.
        for cap in law.line_caps:
            for line in eligible:
                if line.expense != cap.expense:
                    continue
                if cap.per in UNIT_PERS and line.item.units > 0:
                    limit = cap.amount_cents * line.item.units
                    if line.allowed_cents > limit:
                        self.cap(line, cap, limit, "unit_cap")
                else:
                    self.flag(line, cap)

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

        minimum_loss = self.check("minimum_loss", self.law.minimum_loss_rules,
                                  self.minimum_loss_status(totals["allowed_cents"]))  # 9
        deadline_status, deadline_date = self.deadline()
        deadline = self.check("deadline", self.law.deadline_rules, deadline_status)  # 10
        reporting = self.check("reporting", self.law.reporting_rules, self.reporting_status())  # 11

        return {
            "jurisdiction": law.jurisdiction,
            "law_image_sha256": law.law_sha256,
            "lines": [line.to_json() for line in self.lines],
            "totals": totals,
            "checks": {
                "deadline": {"status": deadline["status"], "deadline_date": deadline_date,
                             "rule_ids": deadline["rule_ids"]},
                "minimum_loss": minimum_loss,
                "reporting": reporting,
            },
            "info_rule_ids": list(law.info_rule_ids),  # 12. listed for display only
            "trace": self.trace,
        }

    def check(self, name: str, rules: list[dict], status: str) -> dict:
        rule_ids = [r["id"] for r in rules]
        self.log(name, rule_id=rule_ids[0] if rule_ids else None)
        return {"status": status, "rule_ids": rule_ids}

    def minimum_loss_status(self, total_allowed: int) -> str:
        rules = self.law.minimum_loss_rules
        amounts = [(r, a) for r in rules if (a := _count(_params(r).get("amount_cents"))) is not None]
        if not amounts:
            # The SPEC makes only a days_lost-only rule unknown. Reading: a rule with neither
            # threshold (one says there is no minimum) leaves nothing to fail.
            days_only = any(_count(_params(r).get("days_lost")) is not None for r in rules)
            return "unknown" if days_only else "met"
        status = "met"
        for rule, amount in amounts:
            if total_allowed < amount:
                if self.ctx.forensic_exam and self.waivable(rule):
                    status = "waived" if status == "met" else status
                else:
                    status = "not_met"
        return status

    @staticmethod
    def waivable(rule: dict) -> bool:
        waived_for = _params(rule).get("waived_for")
        if isinstance(waived_for, str):
            return "sexual_assault" in waived_for
        return isinstance(waived_for, list) and "sexual_assault" in waived_for

    def deadline(self) -> tuple[str, str | None]:
        latest: date | None = None
        for r in self.law.deadline_rules:
            p = _params(r)
            years, days = _count(p.get("years")), _count(p.get("days"))
            if years is not None:
                deadline = add_years(self.ctx.incident_date, years)
            elif days is not None:
                deadline = add_days(self.ctx.incident_date, days)
            else:
                continue  # listed only
            latest = deadline if latest is None else max(latest, deadline)
        if latest is None:
            return "unknown", None
        return ("ok" if self.ctx.as_of_date <= latest else "late"), latest.isoformat()

    def reporting_status(self) -> str:
        ctx, rules = self.ctx, self.law.reporting_rules
        if not rules:
            return "satisfied"
        exam_alternative = other_alternative = required = False
        for r in rules:
            p = _params(r)
            required = required or p.get("required", True) is not False
            alts = p.get("alternatives")
            if isinstance(alts, str):
                exam_alternative = exam_alternative or "forensic_exam" in alts
                other_alternative = other_alternative or alts not in ("", "forensic_exam")
            elif isinstance(alts, list):
                for alt in alts:
                    exam_alternative = exam_alternative or alt == "forensic_exam"
                    other_alternative = other_alternative or alt != "forensic_exam"
        if ctx.police_report == "yes" or (ctx.forensic_exam and exam_alternative):
            return "satisfied"
        # Reading: "no alternative applies" holds only when every listed alternative is one the
        # engine can rule out. Only forensic_exam is known; an advocate or protective order might
        # still apply, so those cases stay unknown. Rules with required false never make it
        # required.
        if ctx.police_report == "no" and required and not other_alternative:
            return "required"
        return "unknown"


def _check_rule(rule: dict) -> None:
    # Reject what tendc rejects instead of reading a malformed number as "no limit".
    where = rule["id"]
    params = rule.get("params")
    if params is not None and not isinstance(params, dict):
        raise EngineInputError(f"{where}: params must be an object")
    params = params or {}
    expense = rule_expense(rule)
    if expense is not None and expense not in EXPENSES:
        raise EngineInputError(f"{where}: unknown expense {expense!r}")
    for key in PARAM_KEYS.get(rule["category"], ()):
        value = params.get(key)
        if value is None:
            continue
        if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= PARAM_LIMITS[key]:
            raise EngineInputError(f"{where}: params.{key} must be a whole number from 0 to {PARAM_LIMITS[key]}")
    if rule["category"] == "expense_cap" and params.get("per") is not None:
        if not isinstance(params["per"], str) or not params["per"]:
            raise EngineInputError(f"{where}: params.per must be a non-empty string")
    if rule["category"] == "reporting_requirement" and params.get("required") is not None:
        if not isinstance(params["required"], bool):
            raise EngineInputError(f"{where}: params.required must be true or false")
    for category, key in (("reporting_requirement", "alternatives"), ("minimum_loss", "waived_for")):
        value = params.get(key)
        if rule["category"] == category and value is not None and not isinstance(value, (str, list)):
            raise EngineInputError(f"{where}: params.{key} must be a string or a list")


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
    if claimed != jurisdiction:
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
        try:
            item_id.encode("utf-8")
        except UnicodeEncodeError:
            raise EngineInputError(f"{where}.item_id has an unpaired surrogate") from None
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
            expense=expense if expense in EXPENSES else "unknown",
            confirmed=_bool(_get(raw, "confirmed", False), f"{where}.confirmed"),
            insurance_paid_cents=_int(_get(raw, "insurance_paid_cents", 0),
                                      f"{where}.insurance_paid_cents"),
            is_bill=_bool(_get(raw, "is_bill", False), f"{where}.is_bill"),
            units=_int(_get(raw, "units", 0), f"{where}.units"),
        ))
    # Every total in the output is a sum of amounts, so this keeps them all JSON-safe.
    if sum(it.amount_cents for it in items) > MAX_SAFE_INT:
        raise EngineInputError("the amounts add up to more than 2^53 - 1 cents")
    return ctx, items


def evaluate(rules: dict, engine_input: dict, *, law_sha256: str | None = None) -> dict:
    """Evaluate one claim. `law_sha256` defaults to the sha256 of the canonical rules JSON."""
    return Law(rules, law_sha256).evaluate(engine_input)


def load_rules(path: str | Path) -> tuple[dict, str]:
    """Read a verified jurisdiction file; returns (rules, sha256 of the file bytes)."""
    raw = Path(path).read_bytes()
    return json.loads(raw), hashlib.sha256(raw).hexdigest()
