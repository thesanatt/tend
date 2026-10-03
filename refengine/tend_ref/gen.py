"""Seeded random engine inputs shaped like a survivor's bank history after an incident.

Each claim is aimed at the law it runs against: amounts land under, on, and over its caps; items
count the units its per-unit caps measure (and sometimes other units, or none); count limits get
used up; tags hit its exclusions; lost-wage days and totals land on both sides of its minimum
loss rules; and the as-of date sits on both sides of every filing deadline, report-anchored ones
included. A slice of claims is then broken on purpose (bad values, repeated keys, malformed
text) so the two engines are compared on the inputs they refuse too. Descriptions are generic
and fictional.
"""

from __future__ import annotations

import json
import math
import random
from datetime import date, timedelta

from .law import ITEM_EXPENSES, UNITS, Law

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

# The unit a classifier would put on each expense, and how many.
NATURAL_UNIT = {"counseling": ("session", 1, 40), "lost_wages": ("week", 1, 26), "transportation": ("mile", 3, 600),
                "childcare": ("hour", 1, 60), "temporary_housing": ("day", 1, 60), "relocation": ("month", 1, 3),
                "property_replacement": ("item", 1, 6)}

EXTRA_TAGS = ("phone", "purse", "jewelry", "cash", "vehicle", "pain_suffering", "laptop", "groceries")

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

CLAIM_SHAPES = ("everyday", "cap_pressure", "rate_units", "count_limit", "large", "minimum_loss", "tags", "sparse")
CLAIM_SHAPE_WEIGHTS = (5, 3, 3, 2, 1, 2, 2, 1)
MAX_SAFE_INT = 2**53 - 1
INVALID_SHARE = 0.04  # claims broken on purpose


def claim_rng(seed: int, jurisdiction: str, index: int) -> random.Random:
    # String seeds hash with SHA-512, so claim N of a seed is the same on every machine.
    return random.Random(f"tend-claim:{seed}:{jurisdiction}:{index}")


class _ClaimBuilder:
    def __init__(self, rng: random.Random, law: Law, incident: date, as_of: date):
        self.rng = rng
        self.law = law
        self.incident = incident
        self.as_of = as_of
        self.items: list[dict] = []
        self.ids: set[str] = set()
        self.dates: list[date] = []

    def item_id(self) -> str:
        rng = self.rng
        while True:
            r = rng.random()
            if r < 0.7:
                candidate = f"nessie:{rng.getrandbits(96):024x}"  # Nessie ids are 24 hex chars
            elif r < 0.95:
                candidate = f"receipt:{rng.getrandbits(48):012x}:{rng.randint(1, 9)}"
            else:
                # Ids that sort by bytes, not by what they look like.
                candidate = rng.choice(["Z", "a", "é", "日本", "~", "0", "A-1", "a b", "q\"uote"]) + f"-{rng.randint(0, 99)}"
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
        r = rng.random()
        if r < 0.01:
            return 0
        if r < 0.012:
            return MAX_SAFE_INT - rng.randint(0, 3)  # the largest amount an input may carry
        low, high = AMOUNT_RANGE.get(expense, (500, 50_000))
        cents = int(math.exp(rng.uniform(math.log(low), math.log(high))))
        return cents - cents % 100 if rng.random() < 0.4 else cents

    def insurance(self, amount: int, zero_bias: float = 0.62) -> int:
        rng = self.rng
        if rng.random() < zero_bias:
            return 0
        r = rng.random()
        if r < 0.5:
            return int(amount * rng.uniform(0.1, 0.9))
        if r < 0.75:
            return amount
        if r < 0.88:
            return min(MAX_SAFE_INT, amount + rng.randint(1, 50_000))
        return rng.randint(1, 2_000)

    def units(self, expense: str) -> tuple[int, str | None]:
        # Mostly the unit a classifier would pick, sometimes another one, sometimes none.
        rng = self.rng
        r = rng.random()
        if expense in NATURAL_UNIT and r < 0.6:
            unit, low, high = NATURAL_UNIT[expense]
            return rng.randint(low, high), unit
        if r < 0.75:
            return rng.randint(0, 12), rng.choice(UNITS)
        if r < 0.85:
            return rng.randint(1, 5), None
        return 0, None

    def tags(self) -> list[str]:
        rng = self.rng
        if rng.random() < 0.7:
            return []
        pool = list(self.law.tags) + list(EXTRA_TAGS)
        return rng.sample(pool, k=min(len(pool), rng.randint(1, 3)))

    def add(self, expense: str, *, amount: int | None = None, units: int | None = None, unit: str | None = "",
            when: date | None = None, confirmed: bool | None = None, insurance_zero_bias: float = 0.62,
            tags: list[str] | None = None) -> None:
        rng = self.rng
        when = when or self.any_date()
        amount = self.amount(expense) if amount is None else amount
        if units is None:
            units, picked = self.units(expense)
            unit = picked if unit == "" else unit
        elif unit == "":
            unit = None
        self.dates.append(when)
        item = {
            "item_id": self.item_id(),
            "date": when.isoformat(),
            "amount_cents": amount,
            "expense": expense,
            "confirmed": rng.random() < 0.8 if confirmed is None else confirmed,
            "insurance_paid_cents": self.insurance(amount, insurance_zero_bias),
            "is_bill": rng.random() < (0.7 if expense in ("forensic_exam", "medical", "dental") else 0.25),
            "units": units,
            "unit": unit,
            "tags": self.tags() if tags is None else tags,
            "description": rng.choice(DESCRIPTIONS.get(expense, ["Card purchase"])),
        }
        # Optional fields are sometimes left out or null, which reads as their default.
        for key in ("unit", "tags", "insurance_paid_cents", "units", "is_bill", "confirmed", "expense", "description"):
            r = rng.random()
            if r < 0.04 and not (key == "expense" and expense != "unknown"):
                del item[key]
            elif r < 0.06 and key in ("unit", "tags", "insurance_paid_cents", "units"):
                item[key] = None
        self.items.append(item)

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


def _as_of_date(rng: random.Random, incident: date, law: Law) -> date:
    r = rng.random()
    if r < 0.25 and law.deadlines:
        # On, just before, or just after a deadline (report-anchored ones are dated from the incident).
        rule = rng.choice(law.deadlines)
        try:
            return incident + timedelta(days=rule.days + rng.choice((-1, 0, 0, 1)))
        except OverflowError:
            pass
    elif r < 0.26:
        return incident - timedelta(days=rng.randint(1, 30))  # window runs backwards; all lines out
    elif r < 0.31:
        return incident
    return incident + timedelta(days=int(rng.triangular(1, 4000, 200)))


def generate(law: Law, rng: random.Random, max_items: int = 24) -> dict:
    """One random, valid engine input for `law`."""
    incident = _incident_date(rng)
    as_of = _as_of_date(rng, incident, law)
    claim = _ClaimBuilder(rng, law, incident, as_of)
    kind = rng.choices(CLAIM_SHAPES, CLAIM_SHAPE_WEIGHTS)[0]
    claim_caps = [r for r in law.claim_caps]
    unit_caps = [r for r in law.unit_caps]
    limited = [r for r in unit_caps if r.count_limit is not None]

    if kind == "sparse":
        claim.everyday(rng.randint(0, 2))
    elif kind == "cap_pressure" and claim_caps:
        # Several eligible lines of one capped expense that land under, on, or over the cap.
        rule = rng.choice(claim_caps)
        factor = rng.choice((1.0, rng.uniform(0.6, 1.0), rng.uniform(1.0, 1.8)))
        for part in claim.split(int(rule.cap * factor), rng.randint(2, 6)):
            claim.add(rule.expense, amount=part, when=claim.window_date(), confirmed=rng.random() < 0.9,
                      insurance_zero_bias=0.8)
        claim.everyday(rng.randint(0, 6))
    elif kind in ("rate_units", "count_limit") and unit_caps:
        rule = rng.choice(limited if kind == "count_limit" and limited else unit_caps)
        for _ in range(rng.randint(1, 8 if kind == "count_limit" else 5)):
            units = rng.randint(1, 30) if rng.random() < 0.8 else 0
            if rule.count_limit is not None and rng.random() < 0.5:
                units = rng.randint(0, max(1, rule.count_limit))
            r = rng.random()
            unit = rule.unit if r < 0.75 else (rng.choice(UNITS) if r < 0.9 else None)
            base = rule.cap * max(units, 1)
            amount = base if rng.random() < 0.2 else int(base * rng.uniform(0.6, 1.5))
            claim.add(rule.expense, amount=min(amount, MAX_SAFE_INT), units=units, unit=unit,
                      when=claim.window_date(), confirmed=rng.random() < 0.9, insurance_zero_bias=0.8)
        claim.everyday(rng.randint(0, 6))
    elif kind == "large":
        # Big costs across expenses, enough to reach the total cap.
        total = law.total_cap.cap if law.total_cap else 2_500_000
        expenses = ("medical", "relocation", "lost_wages", "temporary_housing", "counseling", "dental")
        for part in claim.split(int(total * rng.uniform(0.7, 1.6)), rng.randint(2, 8)):
            claim.add(rng.choice(expenses), amount=part, when=claim.window_date(), confirmed=rng.random() < 0.9,
                      insurance_zero_bias=0.8)
        claim.everyday(rng.randint(0, 4))
    elif kind == "minimum_loss" and law.minimum_loss:
        # A small claim near a minimum loss threshold, by amount or by lost-wage days.
        rule = rng.choice(law.minimum_loss)
        days_only = rule.cap is not None and rule.days_lost is not None and rng.random() < 0.4
        if rule.cap is not None and not days_only:
            target = max(0, rule.cap + rng.choice((-1, 0, 1, -rule.cap // 2, rule.cap)))
            for part in claim.split(target, rng.randint(1, 3)):
                claim.add(rng.choice(("medical", "counseling", "prescription", "transportation")), amount=part,
                          when=claim.window_date(), confirmed=rng.random() < 0.95, insurance_zero_bias=0.9)
        if rule.days_lost is not None or rng.random() < 0.3:
            need = rule.days_lost if rule.days_lost is not None else 5
            # Small wage lines too, so the days can meet a rule the dollars do not.
            low_pay = rule.cap is not None and (days_only or rng.random() < 0.5)
            for _ in range(rng.randint(1, 3)):
                unit = rng.choice(("day", "day", "week", "hour", None))
                units = max(0, rng.choice((need, need - 1, need + 1, need // 5, 1)))
                amount = rng.randint(0, max(1, rule.cap // 8)) if low_pay else rng.randint(5_000, 200_000)
                claim.add("lost_wages", amount=amount, units=units, unit=unit,
                          when=claim.window_date(), confirmed=rng.random() < 0.9, insurance_zero_bias=0.9)
        if rule.cap is None or rng.random() < 0.5:
            claim.everyday(rng.randint(0, 2))
    elif kind == "tags" and law.excluded:
        # Lines carrying the tags (and expenses) the law's exclusions name.
        for _ in range(rng.randint(1, 5)):
            rule = rng.choice(law.excluded)
            expense = rule.expense or rng.choice(("property_replacement", "other", "unknown", "medical"))
            tags = sorted(rule.tags) if rule.tags and rng.random() < 0.7 else claim.tags()
            claim.add(expense, tags=tags, when=claim.window_date())
        claim.everyday(rng.randint(0, 5))
    else:
        claim.everyday(rng.randint(1, 14))

    items = claim.items[:max_items]
    rng.shuffle(items)  # input order is not processing order
    has_exam = any(it.get("expense") == "forensic_exam" for it in items)
    context = {
        "incident_date": incident.isoformat(),
        "as_of_date": as_of.isoformat(),
        "police_report": rng.choices(("yes", "no", "unknown", None), (4, 4, 2, 1))[0],
        "forensic_exam": rng.random() < (0.9 if has_exam else 0.4),
    }
    if rng.random() < 0.05:
        del context["police_report"]
    if rng.random() < 0.05:
        del context["forensic_exam"]
    doc = {"jurisdiction": law.jurisdiction, "context": context, "items": items}
    if rng.random() < 0.05:
        del doc["jurisdiction"]
    return doc


# Inputs broken on purpose. Each returns the claim text; most are refused with bad_input.

def _set(rng, doc, key, value):
    if doc["items"]:
        rng.choice(doc["items"])[key] = value
        return True
    return False


def _semantic(rng: random.Random, doc: dict, law: Law) -> None:
    items = doc["items"]
    choice = rng.randrange(28)
    if not items and choice < 20:
        choice = 20 + choice % 8
    if choice == 0:
        _set(rng, doc, "amount_cents", -rng.randint(1, 10_000))
    elif choice == 1:
        _set(rng, doc, "amount_cents", MAX_SAFE_INT + rng.randint(1, 3))
    elif choice == 2:
        _set(rng, doc, "amount_cents", -MAX_SAFE_INT - rng.randint(1, 3))
    elif choice == 3:
        _set(rng, doc, rng.choice(("amount_cents", "insurance_paid_cents", "units")), rng.choice((1.5, 2.0, "12", True, [3])))
    elif choice == 4:
        _set(rng, doc, rng.choice(("insurance_paid_cents", "units")), rng.choice((-1, MAX_SAFE_INT + 1, -(2**63))))
    elif choice == 5:
        _set(rng, doc, "expense", rng.choice(("groceries", "Medical", "", "forensic exam", "unknown ")))
    elif choice == 6:
        _set(rng, doc, "unit", rng.choice(("fortnight", "", "Week", "sessions", "km")))
    elif choice == 7:
        _set(rng, doc, rng.choice(("unit", "expense")), rng.choice((7, True, ["week"], {"u": 1})))
    elif choice == 8 and len(items) >= 2:
        a, b = rng.sample(items, 2)
        b["item_id"] = a["item_id"]  # a repeated id
    elif choice == 9:
        _set(rng, doc, "item_id", rng.choice(("", 42, None, ["x"])))
    elif choice == 10:
        rng.choice(items).pop(rng.choice(("item_id", "date", "amount_cents")), None)
    elif choice == 11:
        _set(rng, doc, "date", rng.choice(("2026-02-30", "2026-6-1", "2026/06/01", "20260601", "", 20260601, None,
                                           "0000-01-01", "2026-13-01")))
    elif choice == 12:
        _set(rng, doc, rng.choice(("confirmed", "is_bill")), rng.choice(("yes", 1, 0, "true", [])))
    elif choice == 13:
        _set(rng, doc, "tags", rng.choice(("phone", [1], ["phone", None], {"a": "b"}, 5)))
    elif choice == 14:
        items[rng.randrange(len(items))] = rng.choice((7, "item", None, []))
    elif choice in (15, 16, 17, 18, 19):
        _set(rng, doc, "amount_cents", rng.choice((0, MAX_SAFE_INT, MAX_SAFE_INT - 1)))  # legal edge values
    elif choice == 20:
        doc["context"][rng.choice(("incident_date", "as_of_date"))] = rng.choice(("2026-02-29", "June 1", None, 5, "1999-1-01"))
    elif choice == 21:
        doc["context"].pop(rng.choice(("incident_date", "as_of_date")), None)
    elif choice == 22:
        doc["context"]["police_report"] = rng.choice(("maybe", "Yes", "", 1, True, []))
    elif choice == 23:
        doc["context"]["forensic_exam"] = rng.choice(("yes", 1, "false", []))
    elif choice == 24:
        if rng.random() < 0.5:
            del doc["context"]
        else:
            doc["context"] = rng.choice((None, [], "context", 5))
    elif choice == 25:
        doc["items"] = rng.choice((None, {}, "items", 5))
    elif choice == 26:
        doc["jurisdiction"] = rng.choice(("ZZ" if law.jurisdiction != "ZZ" else "MI", law.jurisdiction.lower(), "", 5, None))
    else:
        doc[rng.choice(("note", "description", "extra"))] = rng.choice(([1, {"a": [2]}], "text", None, 1e300))


def _repeat_key(rng: random.Random, text: str) -> str:
    # Writes one known key twice (the C++ reader would otherwise keep the first and Python the last).
    keys = ['"amount_cents":', '"context":', '"incident_date":', '"units":', '"expense":', '"items":', '"unit":',
            '"jurisdiction":', '"tags":', '"item_id":']
    present = [k for k in keys if k in text]
    if not present:
        return text
    key = rng.choice(present)
    at = text.index(key)
    filler = {'"context":': '{"incident_date":"2026-06-14","as_of_date":"2026-10-03"},',
              '"items":': "[],", '"tags":': "[],", '"jurisdiction":': '"ZZ",', '"expense":': '"medical",',
              '"unit":': '"week",', '"item_id":': '"dup",', '"incident_date":': '"2026-06-14",'}.get(key, "5,")
    return text[:at] + key + filler + text[at:]


def _textual(rng: random.Random, text: str) -> bytes:
    r = rng.randrange(10)
    if r == 0:
        return _repeat_key(rng, text).encode()
    if r == 1:
        at = text.rfind("}")
        return (text[:at] + ',"extra":' + "[" * rng.choice((63, 64, 65, 80)) + "]" * rng.choice((63, 64, 65, 80)) + text[at:]).encode()
    if r == 2:
        return text.replace('"description":"', '"description":"\\ud800', 1).encode()
    if r == 3:
        token = rng.choice(("NaN", "Infinity", "-Infinity", "1e999", "-0", "0.0"))
        return text.replace('"amount_cents":', f'"note":{token},"amount_cents":', 1).encode()
    if r == 4:
        return (text + rng.choice((" x", "}", "\n", " ", "\0garbage"))).encode()
    if r == 5:
        data = text.encode()
        return data[: rng.randrange(max(1, len(data)))]
    if r == 6:
        return ("﻿" + text).encode()
    if r == 7:
        return text.replace('"amount_cents":', '"amount_cents":0' if rng.random() < 0.5 else '"amount_cents":+', 1).encode()
    data = bytearray(text.encode())
    for _ in range(rng.randint(1, 3)):  # raw byte damage
        if not data:
            break
        i = rng.randrange(len(data))
        op = rng.randrange(3)
        if op == 0:
            data[i] = rng.randrange(256)
        elif op == 1:
            del data[i]
        else:
            data.insert(i, rng.choice(b'{}[],:"\\\x00\xc3\xff'))
    return bytes(data)


def generate_text(law: Law, rng: random.Random, invalid_share: float = INVALID_SHARE) -> tuple[bytes, dict | None]:
    """Claim text for the difftest: (bytes, the valid document it encodes or None when broken)."""
    doc = generate(law, rng)
    r = rng.random()
    if r >= invalid_share:
        return json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode(), doc
    if r < invalid_share * 0.6:
        _semantic(rng, doc, law)
        return json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode(), None
    return _textual(rng, json.dumps(doc, ensure_ascii=False, separators=(",", ":"))), None


__all__ = ["CLAIM_SHAPES", "EXPENSE_WEIGHTS", "ITEM_EXPENSES", "claim_rng", "generate", "generate_text"]
