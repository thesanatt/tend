from collections import Counter
from datetime import date
from statistics import median

from history import (ACCOUNTS, EXPECTED, INCIDENT_DATE, MERCHANTS, RIVERBEND_BILL, build_history, counseling_days,
                     fingerprint, running_balances)

# Pinned so an accidental change to the story (or to Python's random) is noticed, not shipped.
FINGERPRINT = "3a7c4d83f7ea1e69f82fc13851563f06c9f27b8e182620b167f64071c231bd9c"
INCIDENT = INCIDENT_DATE.isoformat()


def by_label(label):
    return [t for t in build_history() if t.label == label]


def test_history_is_deterministic():
    assert build_history() == build_history()
    assert fingerprint() == FINGERPRINT


def test_sizes_match_the_brief():
    history = build_history()
    kinds = Counter(t.kind for t in history)
    assert 150 <= kinds["purchase"] <= 210
    assert len(MERCHANTS) == 13
    assert {t.merchant for t in history if t.merchant} == {m.key for m in MERCHANTS}
    assert history[0].date >= "2026-04-01" and history[-1].date <= "2026-10-02"
    assert len({t.key for t in history}) == len(history)


def test_every_amount_is_whole_dollars():
    assert all(t.amount_cents > 0 and t.amount_cents % 100 == 0 for t in build_history())
    assert all(a.opening_cents % 100 == 0 for a in ACCOUNTS)


def test_payroll_dips_for_three_checks_after_the_incident():
    pay = by_label("payroll")
    assert len(pay) == 14
    assert all(date.fromisoformat(t.date).weekday() == 4 for t in pay)
    before = [t.amount_cents for t in pay if t.date < INCIDENT]
    after = [t.amount_cents for t in pay if t.date > INCIDENT]
    assert median(before) == 412_00
    assert after[:3] == [236_00] * 3
    assert median(after[3:]) == 412_00


def test_counseling_is_weekly_after_the_incident():
    sessions = by_label("counseling")
    assert [t.date for t in sessions] == [d.isoformat() for d in counseling_days()]
    assert len(sessions) == 16 and all(t.amount_cents == 150_00 for t in sessions)
    assert min(t.date for t in sessions) > INCIDENT
    assert {t.merchant for t in sessions} == {"counseling"}


def test_care_rides_fall_on_counseling_days_and_others_do_not():
    session_days = {t.date for t in by_label("counseling")}
    care = by_label("care_ride")
    assert len(care) == 14 and {t.date for t in care} <= session_days
    assert all(t.description == "trip" and t.merchant == "rides" for t in care + by_label("ride"))
    assert not {t.date for t in by_label("ride")} & session_days


def test_story_one_offs():
    singles = {label: by_label(label) for label in ("locksmith", "new_phone", "moving_truck", "apartment_deposit",
                                                    "bedding", "home_security_items")}
    assert all(len(v) == 1 for v in singles.values())
    assert singles["new_phone"][0].amount_cents == 299_00
    assert all(t.date > INCIDENT for v in singles.values() for t in v)
    assert all(t.date > INCIDENT for t in by_label("rx"))
    assert not [t for t in build_history() if t.date == INCIDENT]


def test_balances_never_go_negative():
    series = running_balances(build_history())
    assert min(b for _, b in series["checking"]) > 0
    assert min(b for _, b in series["cushion"]) > 0
    assert series["checking"][-1][1] == 803_00
    assert series["checking"][-1][1] - 118_00 > 0  # the demo payment fits


def test_the_bill_adds_up():
    bill = RIVERBEND_BILL
    assert bill.amount_cents == 443_00 and bill.status == "pending"
    assert sum(line.patient_cents for line in bill.lines) == bill.amount_cents
    for line in bill.lines:
        assert line.charge_cents - line.insurance_paid_cents - line.adjustment_cents == line.patient_cents
    exam = [line for line in bill.lines if "forensic exam" in line.description]
    assert [line.patient_cents for line in exam] == [325_00]
    assert bill.amount_cents - exam[0].patient_cents == 118_00
    assert bill.service_date == INCIDENT


def test_every_label_has_ground_truth():
    assert {t.label for t in build_history()} == set(EXPECTED)
