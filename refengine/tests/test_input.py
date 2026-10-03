"""Input handling, ordering, output shape, and the Python API."""

import copy
import hashlib
import json
import random

import pytest

from claims import FIXTURES, add_rule, claim, item, line, replace_params, run, set_params, zz
from tend_ref import EngineInputError, Law, evaluate, load_rules


def test_lines_follow_date_then_item_id():
    out = run(item("b", date="2026-07-02"), item("c", date="2026-07-01"), item("a", date="2026-07-02"),
              item("B", date="2026-07-02"))
    assert [entry["item_id"] for entry in out["lines"]] == ["c", "B", "a", "b"]


def test_input_order_does_not_change_the_output():
    items = [item(f"i{n}", expense, amount, date=f"2026-07-{n % 28 + 1:02d}", units=n % 3)
             for n, (expense, amount) in enumerate([("medical", 900_000), ("counseling", 20_000),
                                                    ("relocation", 150_000), ("relocation", 90_000),
                                                    ("lost_wages", 1_700_000), ("counseling", 400_000)] * 3)]
    baseline = evaluate(zz(), claim(*items))
    rng = random.Random(7)
    for _ in range(20):
        rng.shuffle(items)
        assert evaluate(zz(), claim(*items)) == baseline


def test_empty_claim():
    out = run()
    assert out["lines"] == []
    assert out["totals"] == {"requested_cents": 0, "allowed_cents": 0, "held_cents": 0, "by_expense": {}}
    assert [t["op"] for t in out["trace"]] == ["minimum_loss", "deadline", "reporting"]
    assert out["checks"]["minimum_loss"]["status"] == "waived"


def test_output_has_exactly_the_spec_shape():
    out = run(item("a"))
    assert list(out) == ["jurisdiction", "law_image_sha256", "lines", "totals", "checks", "info_rule_ids", "trace"]
    assert list(out["lines"][0]) == ["item_id", "expense", "status", "requested_cents", "allowed_cents",
                                     "rule_ids", "cap_rule_id", "flags"]
    assert list(out["totals"]) == ["requested_cents", "allowed_cents", "held_cents", "by_expense"]
    assert list(out["checks"]) == ["deadline", "minimum_loss", "reporting"]
    assert list(out["trace"][0]) == ["op", "item_id", "rule_id", "delta_cents"]
    assert json.loads(json.dumps(out)) == out


def test_by_expense_keys_are_sorted():
    out = run(item("a", "relocation"), item("b", "counseling"), item("c", "medical"))
    assert list(out["totals"]["by_expense"]) == ["counseling", "medical", "relocation"]


def test_optional_item_fields_have_safe_defaults():
    out = evaluate(zz(), claim({"item_id": "a", "date": "2026-07-01", "amount_cents": 5_000}))
    assert out["lines"][0]["status"] == "unknown_rule"
    out = evaluate(zz(), claim({"item_id": "a", "date": "2026-07-01", "amount_cents": 5_000, "expense": "medical"}))
    assert out["lines"][0]["status"] == "needs_confirmation"


def test_null_optional_fields_take_defaults():
    raw = item("a", insurance=0)
    raw.update(insurance_paid_cents=None, units=None, is_bill=None)
    assert evaluate(zz(), claim(raw))["lines"][0]["allowed_cents"] == 10_000


def test_jurisdiction_must_match_exactly_or_be_absent():
    data = claim(item("a"))
    del data["jurisdiction"]
    assert evaluate(zz(), data)["jurisdiction"] == "ZZ"
    data["jurisdiction"] = None
    assert evaluate(zz(), data)["jurisdiction"] == "ZZ"
    with pytest.raises(EngineInputError):
        evaluate(zz(), claim(item("a"), jurisdiction="zz"))


@pytest.mark.parametrize("field, value", [
    ("amount_cents", 100.0), ("amount_cents", True), ("amount_cents", -1), ("amount_cents", "100"),
    ("amount_cents", 2**53), ("amount_cents", None), ("insurance_paid_cents", 1.5), ("units", -2),
    ("confirmed", "yes"), ("date", "2026-7-01"), ("date", "2026-02-30"), ("date", "20260701"),
    ("date", None), ("item_id", ""), ("item_id", 7), ("expense", 3),
])
def test_bad_item_field_is_rejected(field, value):
    raw = item("a")
    raw[field] = value
    with pytest.raises(EngineInputError):
        evaluate(zz(), claim(raw))


@pytest.mark.parametrize("field, value", [
    ("incident_date", "06/14/2026"), ("as_of_date", None), ("police_report", "maybe"), ("forensic_exam", 1),
])
def test_bad_context_field_is_rejected(field, value):
    data = claim(item("a"))
    data["context"][field] = value
    with pytest.raises(EngineInputError):
        evaluate(zz(), data)


def test_wrong_jurisdiction_is_rejected():
    with pytest.raises(EngineInputError, match="rules are for ZZ"):
        evaluate(zz(), claim(item("a"), jurisdiction="MI"))


def test_duplicate_item_id_is_rejected():
    with pytest.raises(EngineInputError, match="duplicate item_id"):
        evaluate(zz(), claim(item("a"), item("a", date="2026-07-02")))


def test_missing_context_or_bad_items_are_rejected():
    with pytest.raises(EngineInputError):
        evaluate(zz(), {"jurisdiction": "ZZ", "items": []})
    with pytest.raises(EngineInputError):
        evaluate(zz(), {**claim(), "items": {"a": 1}})
    with pytest.raises(EngineInputError):
        evaluate(zz(), [])


def test_malformed_rules_are_rejected():
    with pytest.raises(EngineInputError):
        Law({"jurisdiction": "ZZ"})
    rules = zz()
    rules["rules"].append(copy.deepcopy(rules["rules"][0]))
    with pytest.raises(EngineInputError, match="duplicate rule id"):
        Law(rules)


def test_evaluate_does_not_modify_its_arguments():
    rules, data = zz(), claim(item("a", "relocation", 900_000), item("b", "counseling", 50_000, units=0))
    rules_before, data_before = copy.deepcopy(rules), copy.deepcopy(data)
    evaluate(rules, data)
    assert rules == rules_before and data == data_before


def test_law_sha_defaults_to_the_canonical_rules_json():
    rules = zz()
    canonical = json.dumps(rules, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    assert run(item("a"))["law_image_sha256"] == hashlib.sha256(canonical).hexdigest()
    assert evaluate(rules, claim(), law_sha256="abc")["law_image_sha256"] == "abc"


def test_load_rules_returns_the_file_sha():
    rules, sha = load_rules(FIXTURES / "ZZ.json")
    assert rules["jurisdiction"] == "ZZ"
    assert sha == hashlib.sha256((FIXTURES / "ZZ.json").read_bytes()).hexdigest()


def test_law_object_can_be_reused():
    law = Law(zz())
    first = law.evaluate(claim(item("a", "relocation", 300_000)))
    second = law.evaluate(claim(item("b", "relocation", 100_000)))
    assert first["totals"]["allowed_cents"] == 200_000
    assert second["totals"]["allowed_cents"] == 100_000


def test_item_id_with_an_unpaired_surrogate_is_rejected():
    # The C++ engine rejects it too, and the output could not be written as UTF-8.
    data = json.loads('{"item_id": "\\ud800x"}')
    with pytest.raises(EngineInputError, match="unpaired surrogate"):
        evaluate(zz(), claim(item(data["item_id"])))
    assert line(run(item("\U0001f331")), "\U0001f331")["status"] == "eligible"


def test_amounts_that_add_up_past_2_53_are_rejected():
    big = 2**52
    evaluate(zz(), claim(item("a", amount=big), item("b", amount=big - 1)))
    with pytest.raises(EngineInputError, match="add up"):
        evaluate(zz(), claim(item("a", amount=big), item("b", amount=big)))


def test_a_rule_naming_the_unknown_expense_is_rejected():
    # Step 4: an "unknown" line is never counted, so no rule may cover it.
    with pytest.raises(EngineInputError, match="unknown expense"):
        Law(add_rule(zz(), "ZZ-X-1", "covered_expense", expense="unknown"))
    with pytest.raises(EngineInputError, match="unknown expense"):
        Law(add_rule(zz(), "ZZ-X-1", "excluded_expense", expense="vacation"))


@pytest.mark.parametrize("rule_id, params, message", [
    ("ZZ-CAP-1", {"amount_cents": "2500000"}, "amount_cents"),
    ("ZZ-CAP-1", {"amount_cents": 25000.0}, "amount_cents"),
    ("ZZ-CAP-1", {"amount_cents": -1}, "amount_cents"),
    ("ZZ-DEAD-1", {"years": True}, "years"),
    ("ZZ-DEAD-1", {"days": 1_000_001}, "days"),
    ("ZZ-REPORT-1", {"required": "false"}, "required"),
    ("ZZ-REPORT-1", {"alternatives": 3}, "alternatives"),
])
def test_malformed_rule_params_are_rejected_not_ignored(rule_id, params, message):
    # A cap written as a string must not read as "no cap".
    with pytest.raises(EngineInputError, match=message):
        Law(set_params(zz(), rule_id, **params))


def test_malformed_params_object_and_per_are_rejected():
    rules = replace_params(zz(), "ZZ-CAP-1", ["amount_cents", 1])
    with pytest.raises(EngineInputError, match="params must be an object"):
        Law(rules)
    with pytest.raises(EngineInputError, match="per"):
        Law(set_params(zz(), "ZZ-CAP-4", per=7))
