"""Seeded random engine inputs shaped like a survivor's bank history after an incident.

Claims mix confirmed and inferred lines, insurance offsets, dates on both sides of the claim
window, and units for per-unit caps. Amounts and dates are aimed at the jurisdiction's own caps
and filing deadlines so cap walks and date boundaries get exercised, not just the easy path.
Descriptions are generic and fictional.
"""

from __future__ import annotations

import math
import random
from datetime import date, timedelta

from .engine import UNIT_PERS, add_days, add_years, rule_expense

# How often each expense shows up; "unknown" is a line the classifier could not place.
EXPENSE_WEIGHTS = {
    "medical": 18, "counseling": 14, "transportation": 10, "lost_wages": 9, "prescription": 7,
    "forensic_exam": 6, "unknown": 6, "relocation": 4, "temporary_housing": 4, "security": 4,
    "childcare": 3, "property_replacement": 3, "clothing_bedding": 3, "dental": 3, "other": 3,
    "crime_scene_cleanup": 2, "legal": 2, "tuition": 2, "funeral": 1,
}

# Typical single-line amount in cents, (low, high); drawn log-uniformly.
AMOUNT_RANGE = {
    "medical": (2_500, 450_000), "forensic_exam": (30_000, 180_000),
    "counseling": (6_000, 25_000), "lost_wages": (20_000, 180_000),
    "transportation": (400, 9_000), "prescription": (800, 30_000),
    "relocation": (40_000, 450_000), "temporary_housing": (9_000, 220_000),
    "security": (5_000, 150_000), "crime_scene_cleanup": (20_000, 600_000),
    "childcare": (3_000, 60_000), "property_replacement": (2_000, 120_000),
    "clothing_bedding": (2_000, 40_000), "dental": (5_000, 300_000),
    "funeral": (200_000, 1_200_000), "legal": (15_000, 300_000),
    "tuition": (50_000, 600_000), "other": (1_000, 50_000), "unknown": (300, 60_000),
}

# Weeks of wages, counseling sessions, miles driven.
UNIT_RANGE = {"lost_wages": (1, 26), "counseling": (1, 40), "transportation": (3, 600)}

DESCRIPTIONS = {
    "medical": ["Emergency department visit", "Urgent care follow-up", "Outpatient imaging", "Lab panel"],
    "forensic_exam": ["Medical forensic exam, facility fee", "Exam visit, provider bill"],
    "counseling": ["Counseling session", "Therapy, weekly session", "Counseling intake"],
    "lost_wages": ["Unpaid leave, payroll gap", "Missed shifts"],
    "transportation": ["Rideshare to clinic", "Mileage to appointments", "Transit pass"],
    "prescription": ["Pharmacy refill", "Prescription pickup"],
    "relocation": ["Moving truck rental", "Apartment deposit", "Movers, local"],
    "temporary_housing": ["Extended-stay hotel", "Short-term rental"],
    "security": ["Lock replacement", "Door camera and install", "Window repair"],
    "crime_scene_cleanup": ["Cleaning service", "Carpet replacement"],
    "childcare": ["Daycare, extra days", "Babysitter during appointments"],
    "property_replacement": ["Phone replacement", "Replacement laptop"],
    "clothing_bedding": ["Bedding replacement", "Clothing replacement"],
    "dental": ["Dental repair", "Dental visit"],
    "funeral": ["Funeral home invoice"],
    "legal": ["Attorney consultation", "Court filing fee"],
    "tuition": ["Tuition, withdrawn term"],
    "other": ["Card replacement fee", "Records request fee"],
    "unknown": ["Debit card purchase", "Online payment", "ATM withdrawal"],
}

CLAIM_SHAPES = ("everyday", "cap_pressure", "rate_units", "large", "sparse")
CLAIM_SHAPE_WEIGHTS = (5, 3, 2, 1, 1)


def claim_rng(seed: int, jurisdiction: str, index: int) -> random.Random:
    # String seeds hash with SHA-512, so claim N of a seed is the same on every machine.
    return random.Random(f"tend-claim:{seed}:{jurisdiction}:{index}")


class _RulesShape:
    """The numbers in a jurisdiction's rules that are worth aiming generated claims at."""

    def __init__(self, rules: dict):
        self.claim_caps: list[tuple[str, int]] = []
        self.rate_caps: list[tuple[str, int]] = []
        self.total_caps: list[int] = []
        self.periods: list[tuple[str, int]] = []
        for r in rules.get("rules", []):
            params = r.get("params") if isinstance(r.get("params"), dict) else {}
            amount = params.get("amount_cents")
            amount = amount if isinstance(amount, int) and not isinstance(amount, bool) and amount >= 0 else None
            if r.get("category") == "expense_cap" and amount is not None and rule_expense(r):
                target = self.rate_caps if params.get("per") in UNIT_PERS else self.claim_caps
                target.append((rule_expense(r), amount))
            elif r.get("category") == "total_cap" and amount is not None:
                self.total_caps.append(amount)
            elif r.get("category") == "filing_deadline":
                for kind in ("years", "days"):
                    n = params.get(kind)
                    if isinstance(n, int) and not isinstance(n, bool) and 0 <= n <= 200 * 366:
                        self.periods.append((kind, n))
                        break


class _ClaimBuilder:
    def __init__(self, rng: random.Random, incident: date, as_of: date):
        self.rng = rng
        self.incident = incident
        self.as_of = as_of
        self.items: list[dict] = []
        self.ids: set[str] = set()
        self.dates: list[date] = []

    def item_id(self) -> str:
        rng = self.rng
        while True:
            if rng.random() < 0.75:
                candidate = f"nessie:{rng.getrandbits(96):024x}"  # Nessie ids are 24 hex chars
            else:
                candidate = f"receipt:{rng.getrandbits(48):012x}:{rng.randint(1, 9)}"
            if candidate not in self.ids:
                self.ids.add(candidate)
                return candidate

    def window_date(self) -> date:
        span = max(0, (self.as_of - self.incident).days)
        return self.incident + timedelta(days=self.rng.randint(0, span))

    def any_date(self) -> date:
        rng = self.rng
        if self.dates and rng.random() < 0.15:
            return rng.choice(self.dates)  # several charges on one day; ties break on item_id
        r = rng.random()
        if r < 0.07:
            return self.incident - timedelta(days=rng.randint(1, 120))
        if r < 0.12:
            return self.as_of + timedelta(days=rng.randint(1, 45))
        if r < 0.18:
            return self.incident
        if r < 0.23:
            return self.as_of
        return self.window_date()

    def amount(self, expense: str) -> int:
        rng = self.rng
        if rng.random() < 0.01:
            return 0
        low, high = AMOUNT_RANGE.get(expense, (500, 50_000))
        cents = int(math.exp(rng.uniform(math.log(low), math.log(high))))
        return cents - cents % 100 if rng.random() < 0.4 else cents

    def insurance(self, amount: int, zero_bias: float = 0.62) -> int:
        rng = self.rng
        r = rng.random()
        if r < zero_bias:
            return 0
        r = rng.random()
        if r < 0.5:
            return int(amount * rng.uniform(0.1, 0.9))
        if r < 0.75:
            return amount
        if r < 0.88:
            return amount + rng.randint(1, 50_000)
        return rng.randint(1, 2_000)

    def units(self, expense: str) -> int:
        rng = self.rng
        if expense in UNIT_RANGE:
            return rng.randint(*UNIT_RANGE[expense]) if rng.random() < 0.65 else 0
        return rng.randint(1, 5) if rng.random() < 0.08 else 0

    def add(self, expense: str, *, amount: int | None = None, units: int | None = None,
            when: date | None = None, confirmed: bool | None = None,
            insurance_zero_bias: float = 0.62) -> None:
        rng = self.rng
        when = when or self.any_date()
        amount = self.amount(expense) if amount is None else amount
        self.dates.append(when)
        self.items.append({
            "item_id": self.item_id(),
            "date": when.isoformat(),
            "amount_cents": amount,
            "expense": expense,
            "confirmed": rng.random() < 0.8 if confirmed is None else confirmed,
            "insurance_paid_cents": self.insurance(amount, insurance_zero_bias),
            "is_bill": rng.random() < (0.7 if expense in ("forensic_exam", "medical", "dental") else 0.25),
            "units": self.units(expense) if units is None else units,
            "description": rng.choice(DESCRIPTIONS.get(expense, ["Card purchase"])),
        })

    def everyday(self, count: int) -> None:
        expenses, weights = zip(*EXPENSE_WEIGHTS.items())
        for expense in self.rng.choices(expenses, weights, k=count):
            self.add(expense)

    def split(self, total: int, parts: int) -> list[int]:
        # `parts` non-negative integers that sum to exactly `total`.
        cuts = sorted(self.rng.randint(0, total) for _ in range(parts - 1))
        return [b - a for a, b in zip([0] + cuts, cuts + [total])]


def _incident_date(rng: random.Random) -> date:
    if rng.random() < 0.04:
        return date(rng.choice((2016, 2020, 2024)), 2, 29)
    start, end = date(2015, 1, 1), date(2026, 10, 3)
    return start + timedelta(days=rng.randint(0, (end - start).days))


def _as_of_date(rng: random.Random, incident: date, shape: _RulesShape) -> date:
    r = rng.random()
    if r < 0.2:
        if shape.periods:
            kind, n = rng.choice(shape.periods)
            deadline = add_years(incident, n) if kind == "years" else add_days(incident, n)
            if deadline.year < 9000:
                return deadline + timedelta(days=rng.choice((-1, 0, 0, 1)))  # both sides of the line
    elif r < 0.21:
        return incident - timedelta(days=rng.randint(1, 30))  # window runs backwards; all lines out
    elif r < 0.26:
        return incident
    return incident + timedelta(days=int(rng.triangular(1, 4000, 200)))


def generate(rules: dict, rng: random.Random, max_items: int = 24) -> dict:
    """One random engine input for the jurisdiction in `rules`."""
    shape = _RulesShape(rules)
    incident = _incident_date(rng)
    as_of = _as_of_date(rng, incident, shape)
    claim = _ClaimBuilder(rng, incident, as_of)
    kind = rng.choices(CLAIM_SHAPES, CLAIM_SHAPE_WEIGHTS)[0]

    if kind == "sparse":
        claim.everyday(rng.randint(0, 2))
    elif kind == "cap_pressure" and shape.claim_caps:
        # Several eligible lines of one capped expense that land under, on, or over the cap.
        expense, cap = rng.choice(shape.claim_caps)
        factor = rng.choice((1.0, rng.uniform(0.6, 1.0), rng.uniform(1.0, 1.8)))
        for part in claim.split(int(cap * factor), rng.randint(2, 6)):
            claim.add(expense, amount=part, when=claim.window_date(),
                      confirmed=rng.random() < 0.9, insurance_zero_bias=0.8)
        claim.everyday(rng.randint(0, 6))
    elif kind == "rate_units" and shape.rate_caps:
        expense, rate = rng.choice(shape.rate_caps)
        for _ in range(rng.randint(1, 5)):
            units = rng.randint(1, 30) if rng.random() < 0.75 else 0
            base = rate * max(units, 1)
            amount = base if rng.random() < 0.2 else int(base * rng.uniform(0.6, 1.5))
            claim.add(expense, amount=amount, units=units, when=claim.window_date(),
                      confirmed=rng.random() < 0.9, insurance_zero_bias=0.8)
        claim.everyday(rng.randint(0, 6))
    elif kind == "large":
        # Big costs across expenses, enough to reach the total cap.
        total = min(shape.total_caps) if shape.total_caps else 2_500_000
        expenses = ("medical", "relocation", "lost_wages", "temporary_housing", "counseling", "dental")
        for part in claim.split(int(total * rng.uniform(0.7, 1.6)), rng.randint(2, 8)):
            claim.add(rng.choice(expenses), amount=part, when=claim.window_date(),
                      confirmed=rng.random() < 0.9, insurance_zero_bias=0.8)
        claim.everyday(rng.randint(0, 4))
    else:
        claim.everyday(rng.randint(1, 14))

    items = claim.items[:max_items]
    rng.shuffle(items)  # input order is not processing order
    has_exam = any(it["expense"] == "forensic_exam" for it in items)
    return {
        "jurisdiction": rules["jurisdiction"],
        "context": {
            "incident_date": incident.isoformat(),
            "as_of_date": as_of.isoformat(),
            "police_report": rng.choices(("yes", "no", "unknown"), (4, 4, 2))[0],
            "forensic_exam": rng.random() < (0.9 if has_exam else 0.4),
        },
        "items": items,
    }
