import json
import os
import re
import shutil
import stat
from dataclasses import fields
from pathlib import Path
from types import SimpleNamespace

import pytest

from history import EXPECTED
from seeder import labels_for
from tend_api.classify import (DEFAULT_CACHE_PATH, EXPENSES, FALLBACK_MODEL, MODEL_LABELS, PRIMARY_MODEL,
                               RESPONSE_SCHEMA, UNKNOWN, Classification, ClassificationCache, Classifier, TxnFacts,
                               classify_deterministic, classify_snapshot, clean_reason, content_key,
                               facts_from_snapshot, gemini_backend, link_care_rides)
from tend_api.nessie import load_persona_snapshot

REPO = Path(__file__).resolve().parents[2]
MODEL_ONLY = {"bedding", "hardware", "home_security_items", "otc"}


@pytest.fixture(scope="module")
def rowan():
    return load_persona_snapshot("rowan-mi")


@pytest.fixture
def committed_cache(tmp_path):
    path = tmp_path / "cache.json"
    shutil.copy(DEFAULT_CACHE_PATH, path)
    return ClassificationCache(path)


def offline(cache) -> Classifier:
    return Classifier(cache=cache, use_model=False)


def score(snapshot, results):
    misses = []
    for txn_id, label in labels_for(snapshot).items():
        want_expense, want_candidate = EXPECTED[label]
        got = results[txn_id]
        if got.candidate != want_candidate or (want_candidate and got.expense != want_expense):
            misses.append((label, got.expense, got.candidate, got.method))
    return misses


class FakeModel:
    def __init__(self, answer=None, fail=False):
        self.calls = []
        self.answer = answer
        self.fail = fail

    def __call__(self, rows):
        self.calls.append(rows)
        if self.fail:
            raise TimeoutError("model timed out")
        if self.answer:
            return self.answer(rows), "fake-model"
        labels = {"sheet set, pillows": "clothing_bedding", "door chain, motion sensor light": "security"}
        return {"results": [{"ref": r["ref"], "expense": labels.get(r["description"], UNKNOWN),
                             "reason": "What the purchase looks like"} for r in rows]}, "fake-model"


def test_expense_list_matches_the_schema_contract():
    text = (REPO / "rules" / "SCHEMA.md").read_text()
    section = text.split("## Expense types (`expense`)")[1].split("##")[0]
    assert tuple(re.findall(r"`([a-z_]+)`", section)) == EXPENSES
    assert MODEL_LABELS == EXPENSES + ("unknown",)
    assert RESPONSE_SCHEMA["properties"]["results"]["items"]["properties"]["expense"]["enum"] == list(MODEL_LABELS)


def test_snapshot_matches_ground_truth_offline(rowan, committed_cache):
    results = classify_snapshot(rowan, offline(committed_cache))
    assert score(rowan, results) == []
    model = [r for r in results.values() if r.method == "model"]
    assert len(model) == 4 and all(r.cached and not r.confirmed for r in model)


def test_without_model_or_cache_unclear_ones_are_flagged_not_guessed(rowan, tmp_path):
    results = classify_snapshot(rowan, offline(ClassificationCache(tmp_path / "empty.json")))
    misses = score(rowan, results)
    assert {m[0] for m in misses} <= MODEL_ONLY
    unresolved = [r for r in results.values() if r.method == "unresolved"]
    assert len(unresolved) == 4
    assert all(r.expense == UNKNOWN and r.candidate and not r.confirmed for r in unresolved)


def test_rides_link_to_same_day_counseling_and_start_unconfirmed(rowan, committed_cache):
    results = classify_snapshot(rowan, offline(committed_cache))
    labels = labels_for(rowan)
    txns = {t.id: t for t in rowan.txns}
    care = [results[i] for i, label in labels.items() if label == "care_ride"]
    assert len(care) == 14
    for r in care:
        assert (r.expense, r.candidate, r.confirmed, r.method) == ("transportation", True, False, "link")
        assert r.reason == "Same day as a counseling charge"
        [anchor] = r.linked_refs
        assert labels[anchor] == "counseling" and txns[anchor].date == txns[r.ref].date
    other = [results[i] for i, label in labels.items() if label == "ride"]
    assert other and all(not r.candidate and r.linked_refs == () for r in other)


def test_confident_direct_matches_start_confirmed(rowan, committed_cache):
    results = classify_snapshot(rowan, offline(committed_cache))
    labels = labels_for(rowan)
    for label in ("counseling", "rx", "locksmith", "moving_truck", "apartment_deposit", "new_phone"):
        picked = [results[i] for i, lab in labels.items() if lab == label]
        assert picked and all(r.confirmed and r.candidate for r in picked), label
    for label in ("bedding", "home_security_items"):
        picked = [results[i] for i, lab in labels.items() if lab == label]
        assert all(r.candidate and not r.confirmed and r.method == "model" for r in picked), label


@pytest.mark.parametrize("merchant, category, description, kind, expense, candidate", [
    ("Elm Court Apartments", "property management", "security deposit", "purchase", "relocation", True),
    ("Keyline Lock & Safe", "home services", "rekey and deadbolt install", "purchase", "security", True),
    ("Brightline Wireless", "telecom", "new phone", "purchase", "property_replacement", True),
    ("Brightline Wireless", "telecom", "monthly plan", "purchase", UNKNOWN, False),
    ("Hearthstone Pharmacy", "pharmacy", "Rx copay", "purchase", "prescription", True),
    ("Two Rivers Truck Rental", "truck rental", "10 ft truck, 1 day", "purchase", "relocation", True),
    ("Copper Kettle Coffee", "coffee shop", "coffee", "purchase", UNKNOWN, False),
    ("Wayfare Rides", "rideshare", "trip", "purchase", "transportation", False),
    ("", "", "ATM withdrawal", "withdrawal", UNKNOWN, False),
    ("", "", "Fernway Books payroll", "deposit", UNKNOWN, False),
    ("", "", "Save to Cushion [payee:abc]", "transfer", UNKNOWN, False),
    ("Riverbend General Hospital", "", "Riverbend General statement", "bill", "medical", True),
])
def test_deterministic_rules(merchant, category, description, kind, expense, candidate):
    got = classify_deterministic(TxnFacts("x", kind, merchant, category, description))
    assert got is not None and (got.expense, got.candidate) == (expense, candidate)


@pytest.mark.parametrize("description, expense", [
    ("Medical forensic exam, deductible applied", "forensic_exam"),
    ("Emergency department visit, copay", "medical"),
    ("Laboratory services, coinsurance", "medical"),
])
def test_bill_lines_are_read_by_their_own_text(description, expense):
    got = classify_deterministic(TxnFacts("line", "bill_line", "Riverbend General Hospital", "", description))
    assert got.expense == expense and got.method == "keyword"


def test_forensic_exam_beats_the_hospital_registry():
    got = classify_deterministic(TxnFacts("b", "bill", "Riverbend General Hospital", "", "SANE exam"))
    assert got.expense == "forensic_exam"


def test_bill_service_date_can_anchor_a_ride():
    facts = [TxnFacts("ride", "purchase", "Wayfare Rides", "rideshare", "trip", "2026-06-14")]
    base = offline(None).classify(facts)
    assert not base[0].candidate
    linked = link_care_rides(facts, base, extra_anchors=[("2026-06-14", "bill-line-1", "forensic_exam")])
    assert (linked[0].candidate, linked[0].confirmed, linked[0].linked_refs) == (True, False, ("bill-line-1",))
    assert linked[0].reason == "Same day as a medical charge"


def test_model_never_sees_amounts_and_each_content_is_sent_once(tmp_path):
    model = FakeModel()
    classifier = Classifier(cache=tmp_path / "c.json", model=model)
    facts = []
    for pid in ("rowan-mi", "rowan-tx"):
        facts += facts_from_snapshot(load_persona_snapshot(pid))
    classifier.classify(facts)
    assert len(model.calls) == 1
    rows = model.calls[0]
    assert len(rows) == 4  # four unclear descriptions, shared by both personas
    assert all(set(r) == {"ref", "kind", "merchant", "category", "description"} for r in rows)
    assert not any(re.search(r"\$|\d+\.\d\d|payee:", json.dumps(r)) for r in rows)
    again = Classifier(cache=tmp_path / "c.json", model=model).classify(facts)
    assert len(model.calls) == 1
    assert all(r.cached for r in again if r.method == "model")


def test_no_field_can_carry_an_amount():
    assert not {f.name for f in fields(TxnFacts)} & {"amount", "amount_cents"}
    assert not {f.name for f in fields(Classification)} & {"amount", "amount_cents"}


def test_model_output_is_checked_and_cleaned(tmp_path):
    def answer(rows):
        return {"results": [
            {"ref": rows[0]["ref"], "expense": "luxury_goods", "reason": "x"},
            {"ref": "t99", "expense": "security", "reason": "not one of ours"},
            {"ref": rows[1]["ref"], "expense": "security",
             "reason": "A $64 door chain, lights from 2 aisles, which the state has covered before"},
        ]}

    facts = [TxnFacts("a", "purchase", "Odd Shop", "", "mystery item"),
             TxnFacts("b", "purchase", "Northside Hardware", "hardware", "door chain, motion sensor light")]
    results = Classifier(cache=tmp_path / "c.json", model=FakeModel(answer)).classify(facts)
    assert results[0].method == "unresolved" and results[0].expense == UNKNOWN
    assert results[1].expense == "security" and results[1].reason == "Looks like home security"


def test_clean_reason():
    long = " ".join(f"word{chr(97 + i % 26)}" for i in range(40))
    assert len(clean_reason(long, "security").split()) < 20
    dashed = "Door chain \u2014 adds a lock, 2 pieces for $64"
    assert clean_reason(dashed, "security") == "Door chain, adds a lock, pieces for"
    assert clean_reason("This is eligible", "security") == "Looks like home security"
    assert clean_reason("", UNKNOWN) == "Looks like ordinary spending"


def test_model_failure_leaves_items_for_review(tmp_path):
    classifier = Classifier(cache=tmp_path / "c.json", model=FakeModel(fail=True))
    results = classifier.classify([TxnFacts("a", "purchase", "Odd Shop", "", "mystery item")])
    assert results[0].method == "unresolved" and results[0].candidate
    assert classifier.model_errors and "timed out" in classifier.model_errors[0]


class FakeGenai:
    def __init__(self, primary_fails):
        self.calls = []
        self.models = SimpleNamespace(generate_content=self.generate_content)
        self.primary_fails = primary_fails

    def generate_content(self, model, contents, config):
        self.calls.append((model, config))
        if model == PRIMARY_MODEL and self.primary_fails:
            raise RuntimeError("503 UNAVAILABLE: high demand")
        rows = json.loads(contents)
        return SimpleNamespace(text=json.dumps({"results": [
            {"ref": r["ref"], "expense": "security", "reason": "Door hardware"} for r in rows]}))


@pytest.mark.parametrize("primary_fails, answered_by", [(False, PRIMARY_MODEL), (True, FALLBACK_MODEL)])
def test_gemini_backend_primary_then_fallback(primary_fails, answered_by):
    fake = FakeGenai(primary_fails)
    backend = gemini_backend("unused", client=fake)
    answer, model = backend([{"ref": "t1", "kind": "purchase", "merchant": "m", "category": "", "description": "d"}])
    assert model == answered_by and answer["results"][0]["expense"] == "security"
    primary_config = fake.calls[0][1]
    assert fake.calls[0][0] == PRIMARY_MODEL
    assert primary_config.thinking_config.thinking_level.value == "LOW"
    assert primary_config.response_json_schema == RESPONSE_SCHEMA
    if primary_fails:
        assert fake.calls[1][0] == FALLBACK_MODEL and fake.calls[1][1].thinking_config is None


def test_content_key_ignores_tags_case_and_spacing():
    a = TxnFacts("1", "purchase", "Wayfare Rides", "rideshare", "Trip  [payee:123]")
    b = TxnFacts("2", "purchase", "wayfare rides ", "RIDESHARE", "trip")
    assert content_key(a) == content_key(b)
    assert content_key(a) != content_key(TxnFacts("3", "withdrawal", "Wayfare Rides", "rideshare", "trip"))


def test_cache_from_another_prompt_version_is_ignored(tmp_path):
    path = tmp_path / "c.json"
    path.write_text(json.dumps({"prompt_version": "classify-v0", "entries": {"k": {"expense": "security"}}}))
    assert len(ClassificationCache(path)) == 0


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores file permissions")
def test_read_only_cache_location_does_not_break_classification(tmp_path):
    locked = tmp_path / "locked"
    locked.mkdir()
    locked.chmod(stat.S_IRUSR | stat.S_IXUSR)
    try:
        classifier = Classifier(cache=locked / "c.json", model=FakeModel())
        results = classifier.classify([TxnFacts("b", "purchase", "Northside Hardware", "hardware",
                                                "door chain, motion sensor light")])
        assert results[0].expense == "security"
    finally:
        locked.chmod(stat.S_IRWXU)


def test_new_cache_entries_keep_no_transaction_text_by_default(tmp_path):
    path = tmp_path / "c.json"
    Classifier(cache=path, model=FakeModel()).classify(
        [TxnFacts("b", "purchase", "Northside Hardware", "hardware", "door chain, motion sensor light")])
    entry = next(iter(json.loads(path.read_text())["entries"].values()))
    assert set(entry) == {"expense", "reason", "model", "kind"}
    reviewed = tmp_path / "r.json"
    Classifier(cache=ClassificationCache(reviewed, record_text=True), model=FakeModel()).classify(
        [TxnFacts("b", "purchase", "Northside Hardware", "hardware", "door chain, motion sensor light")])
    entry = next(iter(json.loads(reviewed.read_text())["entries"].values()))
    assert entry["merchant"] == "Northside Hardware"


def test_unreadable_cache_starts_empty(tmp_path):
    path = tmp_path / "c.json"
    path.write_text("<<<<<<< HEAD\n{")
    assert len(ClassificationCache(path)) == 0


def test_itemized_bill_is_set_aside_so_its_dollars_are_not_offered_twice(rowan, committed_cache):
    results = classify_snapshot(rowan, offline(committed_cache))
    bill = results[rowan.bills[0].id]
    assert bill.expense == "medical" and not bill.candidate and not bill.confirmed
    assert "Itemized" in bill.reason


def test_tend_payment_is_set_aside_and_anchors_no_ride(rowan, committed_cache):
    from dataclasses import replace as dc_replace

    from tend_api.nessie import Txn

    checking = rowan.account_by_type("Checking").id
    payment = Txn("pay-1", "withdrawal", checking, "2026-10-03", 118_00, "completed",
                  "Riverbend General Hospital payment [tend:act-7]")
    ride = Txn("ride-1", "purchase", checking, "2026-10-03", 12_00, "completed", "trip",
               merchant_id=next(m.id for m in rowan.merchants if m.name == "Wayfare Rides"))
    snap = dc_replace(rowan, txns=[*rowan.txns, payment, ride])
    results = classify_snapshot(snap, offline(committed_cache))
    assert results["pay-1"].expense == "medical"
    assert (results["pay-1"].candidate, results["pay-1"].confirmed) == (False, False)
    assert not results["ride-1"].candidate


def test_document_service_date_anchors_rides_without_passing_it(rowan, committed_cache):
    from dataclasses import replace as dc_replace

    from tend_api.nessie import Txn

    checking = rowan.account_by_type("Checking").id
    ride = Txn("ride-14", "purchase", checking, "2026-06-14", 15_00, "completed", "trip",
               merchant_id=next(m.id for m in rowan.merchants if m.name == "Wayfare Rides"))
    results = classify_snapshot(dc_replace(rowan, txns=[*rowan.txns, ride]), offline(committed_cache))
    assert results["ride-14"].candidate and results["ride-14"].linked_refs == (rowan.bills[0].id,)
