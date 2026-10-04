"""SPEC v1.2 items from the classifier, and the committed classified/ snapshots the web can test against."""
import json
import re
from collections import Counter
from pathlib import Path

import pytest

from history import EXPECTED, SHORT_PAY, fingerprint
from personas import PERSONAS
from seeder import CLASSIFIED_DIR, CLASSIFIED_FORMAT, classified_doc, labels_for
from tend_api.classify import (Classifier, ClassificationCache, TxnFacts, classify_deterministic, classify_snapshot,
                               classify_statement, item_shape, snapshot_items, tags_for, wage_gaps)
from tend_api.nessie import load_persona_snapshot

DEFAULT_CACHE = Path(__file__).resolve().parents[1] / "cache" / "classify_cache.json"
ENGINE_FIELDS = {"item_id", "date", "amount_cents", "expense", "confirmed", "insurance_paid_cents", "is_bill", "units",
                 "description"}
CLASSIFIED_FIELDS = ENGINE_FIELDS | {"unit", "tags", "source", "reason", "confidence"}
UNITS = {"session", "week", "hour", "mile", "day", "month", "item", None}


def offline() -> Classifier:
    cache = ClassificationCache(DEFAULT_CACHE)
    cache.path = None  # read the committed answers, never write them
    return Classifier(cache=cache, use_model=False)


@pytest.fixture(scope="module")
def rowan():
    return load_persona_snapshot("rowan-mi")


@pytest.fixture(scope="module")
def rowan_items(rowan):
    return snapshot_items(rowan, classify_snapshot(rowan, offline()))


def test_counseling_charges_are_one_session_each(rowan_items):
    sessions = [i for i in rowan_items if i["expense"] == "counseling"]
    assert len(sessions) == 16 and all((i["unit"], i["units"]) == ("session", 1) for i in sessions)
    assert all(i["amount_cents"] == 150_00 and i["confirmed"] for i in sessions)


def test_rides_have_no_unit_and_wait_for_a_yes(rowan_items):
    rides = [i for i in rowan_items if i["expense"] == "transportation"]
    assert len(rides) == 14 and all(i["unit"] is None and i["units"] == 0 and not i["confirmed"] for i in rides)


def test_the_new_phone_is_tagged_so_an_exclusion_can_name_it(rowan_items):
    [phone] = [i for i in rowan_items if i["expense"] == "property_replacement"]
    assert phone["tags"] == ["phone"] and phone["amount_cents"] == 299_00


def test_short_paychecks_become_lost_wages_in_estimated_days(rowan_items):
    # $176 short of a biweekly $412 is about 4 of the period's 10 workdays (SPEC v1.2 days_lost), not 2 weeks.
    gaps = [i for i in rowan_items if i["expense"] == "lost_wages"]
    assert [(i["date"], i["amount_cents"], i["unit"], i["units"]) for i in gaps] == [
        ("2026-06-26", 176_00, "day", 4), ("2026-07-10", 176_00, "day", 4), ("2026-07-24", 176_00, "day", 4)]
    assert all(not i["confirmed"] and i["source"] == "rule" and "$236" in i["reason"] for i in gaps)
    assert all("estimate" in i["reason"] for i in gaps)
    assert (412_00 - SHORT_PAY * 100) * 3 == sum(i["amount_cents"] for i in gaps)


def test_inferred_items_always_start_unconfirmed(rowan):
    results = classify_snapshot(rowan, offline())
    for item in snapshot_items(rowan, results):
        r = results[item["item_id"].removeprefix("nessie:")]
        if r.method in ("model", "link", "inference", "unresolved"):
            assert item["confirmed"] is False, (r.method, item["description"])


def test_the_plan_agrees_on_lost_wages(rowan):
    results = classify_snapshot(rowan, offline())
    short = [ref for ref, label in labels_for(rowan).items() if label == "short_payroll"]
    assert EXPECTED["short_payroll"] == ("lost_wages", True)
    assert len(short) == 3 and all((results[ref].expense, results[ref].candidate) == ("lost_wages", True) for ref in short)


def test_item_shape():
    assert item_shape("counseling", "purchase", "session") == ("session", 1, ())
    assert item_shape("counseling", "bill", "statement") == ("session", 0, ())  # a whole bill may hold many sessions
    assert item_shape("temporary_housing", "purchase", "Harbor Inn, 3 nights") == ("day", 3, ())
    assert item_shape("temporary_housing", "purchase", "Harbor Inn") == ("day", 0, ())
    assert item_shape("transportation", "purchase", "trip") == (None, 0, ())
    assert item_shape("property_replacement", "purchase", "Brightline Wireless new phone") == (None, 0, ("phone",))
    assert item_shape("security", "purchase", "new phone mount") == (None, 0, ())  # tags only on replaced property


@pytest.mark.parametrize("text, tags", [
    ("new cell phone", ("phone",)), ("replacement wallet and phone", ("phone", "purse")), ("gold jewelry", ("jewelry",)),
    ("monthly plan", ()), ("car seat", ("vehicle",)),
])
def test_tags_follow_the_normalizer_table(text, tags):
    assert tags_for(text) == tags


def test_phone_plans_and_phone_purchases_differ():
    plan = classify_deterministic(TxnFacts("a", "purchase", "Brightline Wireless", "telecom", "monthly plan"))
    phone = classify_deterministic(TxnFacts("b", "purchase", "Brightline Wireless", "telecom", "new phone"))
    assert not plan.candidate and plan.tags == ()
    assert phone.candidate and phone.tags == ("phone",)


def test_wage_gaps_need_a_date_a_usual_amount_and_a_real_dip():
    pay = [("d1", "2026-05-01", 412_00), ("d2", "2026-05-15", 398_00), ("d3", "2026-05-29", 419_00),
           ("d4", "2026-06-12", 412_00), ("d5", "2026-06-26", 236_00), ("d6", "2026-07-10", 400_00)]
    deposits = [(ref, day, cents, "Fernway Books payroll") for ref, day, cents in pay]
    gaps = wage_gaps(deposits, "2026-06-14")
    assert list(gaps) == ["d5"] and (gaps["d5"].gap_cents, gaps["d5"].days, gaps["d5"].usual_cents) == (176_00, 4, 412_00)
    assert gaps["d5"].period_days == 10
    assert wage_gaps(deposits, None) == {}  # no date, no inference
    assert wage_gaps(deposits[3:], "2026-06-14") == {}  # one check before the date is not a usual amount
    gifts = [(ref, day, cents, "Transfer from Mom") for ref, day, cents in pay]
    assert wage_gaps(gifts, "2026-06-14") == {}  # only pay can dip


def test_statement_and_snapshot_paths_agree(rowan):
    from_snapshot = snapshot_items(rowan, classify_snapshot(rowan, offline()))
    anchors = [(d["service_date"], d["bill_id"], "medical") for d in rowan.meta["documents"]]
    rows = rowan.statement(rowan.account_by_type("Checking").id)
    assert classify_statement(rows, "2026-06-14", offline(), anchors) == from_snapshot


@pytest.fixture(scope="module", params=sorted(PERSONAS))
def committed(request):
    return json.loads((CLASSIFIED_DIR / f"{request.param}.json").read_text())


def test_every_persona_has_a_classified_snapshot():
    assert sorted(p.stem for p in CLASSIFIED_DIR.glob("*.json")) == sorted(PERSONAS)


def test_committed_classified_snapshot_is_current(committed):
    snapshot = load_persona_snapshot(committed["persona_id"])
    assert committed == json.loads(json.dumps(classified_doc(snapshot, offline())))
    assert committed["format"] == CLASSIFIED_FORMAT and committed["history_fingerprint"] == fingerprint()
    assert committed["fictional"] is True and "Fictional" in committed["notice"]


def test_classified_items_follow_the_contract(committed):
    items = committed["items"]
    assert Counter(i["expense"] for i in items) == Counter(committed["by_expense"])
    for item in items:
        assert set(item) == CLASSIFIED_FIELDS
        assert isinstance(item["amount_cents"], int) and item["amount_cents"] > 0
        assert item["unit"] in UNITS and item["source"] in ("rule", "cloud_ai") and 0 <= item["confidence"] <= 1
        assert len(item["reason"].split()) <= 20 and not re.search("[–—‘’“”]", item["reason"])
        assert item["item_id"].startswith("nessie:")
        if item["source"] == "cloud_ai" or item["expense"] in ("transportation", "lost_wages"):
            assert item["confirmed"] is False
