"""The bank history every persona shares: six months, two accounts, thirteen merchants, one bill.

A fixed seed drives every random choice, so a rebuild yields the same records and the seeder can
match what is already in Nessie by content. Amounts are whole dollars (Nessie truncates anything
else), kept here as integer cents. All names are fictional.
"""
from __future__ import annotations

import hashlib
import json
import random
from dataclasses import asdict, dataclass
from datetime import date, timedelta

from personas import Persona

HISTORY_SEED = "tend-history-v1"
START = date(2026, 4, 1)
END = date(2026, 10, 2)
INCIDENT_DATE = date(2026, 6, 14)
AS_OF_DATE = date(2026, 10, 3)

EMPLOYER = "Fernway Books"
# Biweekly pay: steady before the incident, three short checks after it, then back to normal.
PAYCHECKS = (412, 398, 419, 412, 406, 412, 236, 236, 236, 404, 412, 397, 418, 412)


@dataclass(frozen=True)
class MerchantSpec:
    key: str
    name: str
    category: str


MERCHANTS: tuple[MerchantSpec, ...] = (
    MerchantSpec("market", "Larkfield Market", "groceries"),
    MerchantSpec("coffee", "Copper Kettle Coffee", "coffee shop"),
    MerchantSpec("noodles", "Juniper Noodle House", "restaurant"),
    MerchantSpec("rides", "Wayfare Rides", "rideshare"),
    MerchantSpec("streaming", "Lumen Streaming", "entertainment"),
    MerchantSpec("wireless", "Brightline Wireless", "telecom"),
    MerchantSpec("counseling", "Clearwater Counseling Group", "health care"),
    MerchantSpec("pharmacy", "Hearthstone Pharmacy", "pharmacy"),
    MerchantSpec("locksmith", "Keyline Lock & Safe", "home services"),
    MerchantSpec("hardware", "Northside Hardware", "hardware"),
    MerchantSpec("linens", "Linen & Loom", "home goods"),
    MerchantSpec("trucks", "Two Rivers Truck Rental", "truck rental"),
    MerchantSpec("apartments", "Elm Court Apartments", "property management"),
)
MERCHANT_BY_KEY = {m.key: m for m in MERCHANTS}


@dataclass(frozen=True)
class AccountSpec:
    key: str
    type: str
    nickname: str
    opening_cents: int


ACCOUNTS: tuple[AccountSpec, ...] = (
    AccountSpec("checking", "Checking", "Checking", 2_850_00),
    AccountSpec("cushion", "Savings", "Cushion", 900_00),
)


@dataclass(frozen=True)
class PlannedTxn:
    key: str
    account: str
    kind: str
    date: str
    amount_cents: int
    description: str
    merchant: str | None = None
    payee_account: str | None = None
    label: str = ""


@dataclass(frozen=True)
class BillLine:
    line: int
    date: str
    description: str
    charge_cents: int
    insurance_paid_cents: int
    adjustment_cents: int
    patient_cents: int


@dataclass(frozen=True)
class PlannedBill:
    key: str
    account: str
    payee: str
    nickname: str
    amount_cents: int
    status: str
    payment_date: str
    recurring_date: int
    statement_date: str
    service_date: str
    insurer: str
    lines: tuple[BillLine, ...]


RIVERBEND_BILL = PlannedBill(
    key="riverbend",
    account="checking",
    payee="Riverbend General Hospital",
    nickname="Riverbend General statement",
    amount_cents=443_00,
    status="pending",
    payment_date="2026-10-20",
    recurring_date=20,  # Nessie needs it or the bill list breaks; it is the due day, not a schedule
    statement_date="2026-09-20",
    service_date="2026-06-14",
    insurer="Lakeshore Mutual Health Plan",
    lines=(
        BillLine(1, "2026-06-14", "Emergency department visit, copay", 1_180_00, 905_00, 200_00, 75_00),
        BillLine(2, "2026-06-14", "Medical forensic exam, deductible applied", 1_050_00, 725_00, 0, 325_00),
        BillLine(3, "2026-06-14", "Laboratory services, coinsurance", 215_00, 132_00, 40_00, 43_00),
    ),
)

# Ground truth for each story label: (expense, should be offered as a recovery cost).
# None means ordinary spending, income, or money moving between Rowan's own accounts.
EXPECTED: dict[str, tuple[str | None, bool]] = {
    "payroll": (None, False),
    "savings_transfer": (None, False),
    "atm": (None, False),
    "groceries": (None, False),
    "coffee": (None, False),
    "takeout": (None, False),
    "streaming": (None, False),
    "phone_plan": (None, False),
    "otc": (None, False),
    "hardware": (None, False),
    "ride": ("transportation", False),
    "care_ride": ("transportation", True),
    "counseling": ("counseling", True),
    "rx": ("prescription", True),
    "locksmith": ("security", True),
    "home_security_items": ("security", True),
    "bedding": ("clothing_bedding", True),
    "new_phone": ("property_replacement", True),
    "apartment_deposit": ("relocation", True),
    "moving_truck": ("relocation", True),
}


def _days(start: date, end: date):
    day = start
    while day <= end:
        yield day
        day += timedelta(days=1)


def counseling_days() -> list[date]:
    return [date(2026, 6, 17) + timedelta(weeks=i) for i in range(16)]


def paydays() -> list[date]:
    return [date(2026, 4, 3) + timedelta(days=14 * i) for i in range(len(PAYCHECKS))]


def build_history() -> list[PlannedTxn]:
    rng = random.Random(HISTORY_SEED)
    rows: list[dict] = []

    def add(account: str, kind: str, day: date, dollars: int, description: str, merchant: str | None = None,
            payee: str | None = None, label: str = "") -> None:
        rows.append({"account": account, "kind": kind, "date": day.isoformat(), "amount_cents": dollars * 100,
                     "description": description, "merchant": merchant, "payee_account": payee, "label": label})

    for day, dollars in zip(paydays(), PAYCHECKS, strict=True):
        add("checking", "deposit", day, dollars, f"{EMPLOYER} payroll", label="payroll")
        if day < INCIDENT_DATE:
            add("checking", "transfer", day, 40, "Save to Cushion", payee="cushion", label="savings_transfer")
    add("cushion", "transfer", date(2026, 7, 2), 300, "Move to checking", payee="checking", label="savings_transfer")
    add("cushion", "transfer", date(2026, 8, 3), 250, "Move to checking", payee="checking", label="savings_transfer")

    for month in range(4, 10):
        add("checking", "purchase", date(2026, month, 9), 12, "monthly subscription", "streaming", label="streaming")
        add("checking", "purchase", date(2026, month, 22), 45, "monthly plan", "wireless", label="phone_plan")
        first_saturday = next(d for d in _days(date(2026, month, 1), date(2026, month, 7)) if d.weekday() == 5)
        add("checking", "withdrawal", first_saturday, 40 if month % 2 else 60, "ATM withdrawal", label="atm")

    sessions = counseling_days()
    lifts = {sessions[5], sessions[11]}  # a friend drove these days, so no ride charge
    for day in sessions:
        add("checking", "purchase", day, 150, "session", "counseling", label="counseling")
        if day not in lifts:
            add("checking", "purchase", day, rng.choice((12, 12, 12, 13, 14)), "trip", "rides", label="care_ride")

    add("checking", "purchase", date(2026, 4, 20), 11, "allergy relief", "pharmacy", label="otc")
    add("checking", "purchase", date(2026, 5, 10), 14, "light bulbs, tape", "hardware", label="hardware")
    add("checking", "purchase", date(2026, 6, 15), 25, "Rx copay", "pharmacy", label="rx")
    add("checking", "purchase", date(2026, 6, 16), 185, "rekey and deadbolt install", "locksmith", label="locksmith")
    add("checking", "purchase", date(2026, 6, 16), 96, "sheet set, pillows", "linens", label="bedding")
    add("checking", "purchase", date(2026, 6, 18), 64, "door chain, motion sensor light", "hardware",
        label="home_security_items")
    add("checking", "purchase", date(2026, 6, 20), 299, "new phone", "wireless", label="new_phone")
    add("checking", "purchase", date(2026, 6, 29), 15, "Rx copay", "pharmacy", label="rx")
    add("checking", "purchase", date(2026, 7, 15), 650, "security deposit", "apartments", label="apartment_deposit")
    add("checking", "purchase", date(2026, 7, 18), 189, "10 ft truck, 1 day", "trucks", label="moving_truck")
    add("checking", "purchase", date(2026, 7, 27), 15, "Rx copay", "pharmacy", label="rx")
    add("checking", "purchase", date(2026, 8, 24), 15, "Rx copay", "pharmacy", label="rx")

    care = set(sessions)
    for day in _days(START, END):
        if day == INCIDENT_DATE:
            continue
        weekday = day.weekday()
        after = day > INCIDENT_DATE
        if weekday == 6 or (weekday == 2 and rng.random() < 0.5):
            add("checking", "purchase", day, rng.randint(18, 74), "groceries", "market", label="groceries")
        if weekday in (0, 1, 3) and rng.random() < (0.35 if after else 0.6):
            add("checking", "purchase", day, rng.randint(4, 9), "coffee", "coffee", label="coffee")
        if weekday in (4, 5) and rng.random() < 0.5:
            add("checking", "purchase", day, rng.randint(13, 24), "takeout", "noodles", label="takeout")
        if weekday in (4, 5) and day not in care and rng.random() < 0.22:
            add("checking", "purchase", day, rng.randint(9, 18), "trip", "rides", label="ride")

    rows.sort(key=lambda r: (r["date"], r["account"], r["kind"], r["description"], r["amount_cents"]))
    counters: dict[str, int] = {}
    planned = []
    for row in rows:
        counters[row["kind"]] = counters.get(row["kind"], 0) + 1
        planned.append(PlannedTxn(key=f"{row['kind']}-{counters[row['kind']]:03d}", **row))
    return planned


def running_balances(history: list[PlannedTxn]) -> dict[str, list[tuple[str, int]]]:
    """Per account, the balance after each day, the same way the client computes it."""
    balance = {a.key: a.opening_cents for a in ACCOUNTS}
    by_day: dict[str, list[tuple[str, int]]] = {a.key: [] for a in ACCOUNTS}
    for day in sorted({t.date for t in history}):
        for t in (t for t in history if t.date == day):
            balance[t.account] += t.amount_cents if t.kind == "deposit" else -t.amount_cents
            if t.kind == "transfer" and t.payee_account:
                balance[t.payee_account] += t.amount_cents
        for key in balance:
            by_day[key].append((day, balance[key]))
    return by_day


def fingerprint() -> str:
    payload = {
        "seed": HISTORY_SEED,
        "accounts": [asdict(a) for a in ACCOUNTS],
        "merchants": [asdict(m) for m in MERCHANTS],
        "history": [asdict(t) for t in build_history()],
        "bill": asdict(RIVERBEND_BILL),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def merchant_location(persona: Persona, index: int) -> tuple[dict[str, str], float, float]:
    street = persona.merchant_streets[index % len(persona.merchant_streets)]
    address = {"street_number": str(100 + 37 * index), "street_name": street, "city": persona.city,
               "state": persona.jurisdiction, "zip": persona.zip}
    lat = round(persona.lat + ((index * 37) % 11 - 5) * 0.004, 5)
    lng = round(persona.lng + ((index * 53) % 13 - 6) * 0.005, 5)
    return address, lat, lng


def hospital_address(persona: Persona) -> dict[str, str]:
    return {"street_number": "1200", "street_name": "Riverbend Pkwy", "city": persona.city,
            "state": persona.jurisdiction, "zip": persona.zip}
