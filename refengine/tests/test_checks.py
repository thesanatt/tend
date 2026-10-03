"""SPEC steps 9-12: minimum loss, deadline, reporting, and info rules."""

import pytest

from claims import add_rule, check_ops, item, replace_params, run, set_params, without, zz


def status(out: dict, check: str) -> str:
    return out["checks"][check]["status"]


def three_years() -> dict:
    # ZZ without its age-18 rule, so the 3-year rule (ZZ-DEAD-1) is the longest.
    return without(zz(), "ZZ-DEAD-3")


# Step 9: minimum loss (ZZ-MIN-1: $100, waived_for ["sexual_assault"])

def test_minimum_loss_met_at_exactly_the_threshold():
    out = run(item("a", "medical", 10_000), forensic_exam=False)
    assert out["checks"]["minimum_loss"] == {"status": "met", "rule_ids": ["ZZ-MIN-1"]}


def test_minimum_loss_not_met_below_the_threshold():
    assert status(run(item("a", "medical", 9_999), forensic_exam=False), "minimum_loss") == "not_met"


def test_minimum_loss_waived_for_sexual_assault_with_an_exam():
    assert status(run(item("a", "medical", 500), forensic_exam=True), "minimum_loss") == "waived"


def test_minimum_loss_counts_allowed_cents_after_insurance():
    out = run(item("a", "medical", 50_000, insurance=45_000), forensic_exam=False)
    assert status(out, "minimum_loss") == "not_met"


def test_held_and_unconfirmed_lines_do_not_count_toward_the_minimum():
    out = run(item("a", "forensic_exam", 90_000), item("b", "medical", 50_000, confirmed=False),
              forensic_exam=False)
    assert status(out, "minimum_loss") == "not_met"


@pytest.mark.parametrize("waived_for", ["sexual_assault", "victims of sexual_assault", ["x", "sexual_assault"]])
def test_waiver_matches_a_string_or_a_list_entry(waived_for):
    rules = set_params(zz(), "ZZ-MIN-1", waived_for=waived_for)
    assert status(run(item("a", "medical", 500), rules=rules), "minimum_loss") == "waived"


@pytest.mark.parametrize("waived_for", [["forensic_exam"], ["victims of sexual_assault"], "sexual assault", None])
def test_waiver_needs_the_sexual_assault_token(waived_for):
    # ["forensic_exam"] is how SC-MIN-2 encodes its exam waiver; the SPEC's test does not match it.
    rules = set_params(zz(), "ZZ-MIN-1", waived_for=waived_for)
    assert status(run(item("a", "medical", 500), rules=rules), "minimum_loss") == "not_met"


def test_any_unwaived_shortfall_is_not_met():
    rules = add_rule(zz(), "ZZ-MIN-9", "minimum_loss", amount_cents=5_000)
    assert status(run(item("a", "medical", 7_000), rules=rules), "minimum_loss") == "waived"
    out = run(item("a", "medical", 3_000), rules=rules)
    assert out["checks"]["minimum_loss"] == {"status": "not_met", "rule_ids": ["ZZ-MIN-1", "ZZ-MIN-9"]}


def test_only_days_lost_is_unknown():
    rules = replace_params(zz(), "ZZ-MIN-1", {"days_lost": 7})
    assert run(item("a", "medical", 500), rules=rules)["checks"]["minimum_loss"] == {"status": "unknown",
                                                                                    "rule_ids": ["ZZ-MIN-1"]}


def test_amount_and_days_lost_on_one_rule_uses_the_amount():
    rules = replace_params(zz(), "ZZ-MIN-1", {"amount_cents": 20_000, "days_lost": 5})
    assert status(run(item("a", "medical", 500), rules=rules, forensic_exam=False), "minimum_loss") == "not_met"


def test_rule_with_no_threshold_is_met():
    # NJ-MINLOSS-1 says there is no minimum; the SPEC only makes a days_lost-only rule unknown.
    rules = replace_params(zz(), "ZZ-MIN-1", {})
    assert run(item("a", "medical", 1), rules=rules)["checks"]["minimum_loss"] == {"status": "met",
                                                                                  "rule_ids": ["ZZ-MIN-1"]}


def test_no_minimum_loss_rule_is_met():
    out = run(rules=without(zz(), "minimum_loss"), forensic_exam=False)
    assert out["checks"]["minimum_loss"] == {"status": "met", "rule_ids": []}


# Step 10: deadline (ZZ-DEAD-1: 3 years; ZZ-DEAD-2: 180 days; ZZ-DEAD-3: 10 years from age 18; ZZ-DEAD-4: none)

def test_deadline_uses_the_longest_rule_and_lists_all():
    assert run()["checks"]["deadline"] == {"status": "ok", "deadline_date": "2036-06-14",
                                           "rule_ids": ["ZZ-DEAD-1", "ZZ-DEAD-2", "ZZ-DEAD-3", "ZZ-DEAD-4"]}
    assert run(rules=three_years())["checks"]["deadline"]["deadline_date"] == "2029-06-14"


def test_age_18_rule_is_counted_from_the_incident():
    # The SPEC dates every rule from incident_date; VA-DEADLINE-4 makes this matter (see README).
    rules = without(zz(), "ZZ-DEAD-1", "ZZ-DEAD-2")
    assert run(rules=rules)["checks"]["deadline"] == {"status": "ok", "deadline_date": "2036-06-14",
                                                      "rule_ids": ["ZZ-DEAD-3", "ZZ-DEAD-4"]}


def test_deadline_is_ok_on_the_last_day_and_late_the_next():
    assert status(run(rules=three_years(), as_of="2029-06-14"), "deadline") == "ok"
    assert status(run(rules=three_years(), as_of="2029-06-15"), "deadline") == "late"


def test_deadline_in_days():
    out = run(rules=without(zz(), "ZZ-DEAD-1", "ZZ-DEAD-3"), as_of="2026-12-12")
    assert out["checks"]["deadline"] == {"status": "late", "deadline_date": "2026-12-11",
                                         "rule_ids": ["ZZ-DEAD-2", "ZZ-DEAD-4"]}


def test_years_beat_days_on_one_rule():
    rules = replace_params(without(zz(), "ZZ-DEAD-1", "ZZ-DEAD-3"), "ZZ-DEAD-2", {"years": 1, "days": 30})
    assert run(rules=rules)["checks"]["deadline"]["deadline_date"] == "2027-06-14"


def test_feb_29_plus_years_lands_on_feb_28():
    out = run(rules=three_years(), incident="2024-02-29", as_of="2027-02-28")
    assert out["checks"]["deadline"]["deadline_date"] == "2027-02-28"
    assert status(out, "deadline") == "ok"
    assert status(run(rules=three_years(), incident="2024-02-29", as_of="2027-03-01"), "deadline") == "late"


def test_feb_29_into_a_leap_year_stays_feb_29():
    rules = set_params(three_years(), "ZZ-DEAD-1", years=4)
    assert run(rules=rules, incident="2024-02-29")["checks"]["deadline"]["deadline_date"] == "2028-02-29"


def test_rule_without_a_period_is_listed_only():
    out = run(rules=without(zz(), "ZZ-DEAD-1", "ZZ-DEAD-2", "ZZ-DEAD-3"))
    assert out["checks"]["deadline"] == {"status": "unknown", "deadline_date": None, "rule_ids": ["ZZ-DEAD-4"]}


def test_no_deadline_rule_is_unknown():
    out = run(rules=without(zz(), "filing_deadline"))
    assert out["checks"]["deadline"] == {"status": "unknown", "deadline_date": None, "rule_ids": []}


def test_huge_period_stops_at_the_last_date():
    rules = set_params(zz(), "ZZ-DEAD-1", years=100_000)
    assert run(rules=rules)["checks"]["deadline"]["deadline_date"] == "9999-12-31"


# Step 11: reporting (ZZ-REPORT-1: required, alternative forensic_exam; ZZ-REPORT-2: not required)

def test_police_report_satisfies():
    out = run(police_report="yes", forensic_exam=False)
    assert out["checks"]["reporting"] == {"status": "satisfied", "rule_ids": ["ZZ-REPORT-1", "ZZ-REPORT-2"]}


def test_forensic_exam_alternative_satisfies():
    assert status(run(police_report="no", forensic_exam=True), "reporting") == "satisfied"


def test_report_required_when_no_alternative_can_apply():
    assert status(run(police_report="no", forensic_exam=False), "reporting") == "required"


def test_unknown_police_report_is_unknown():
    assert status(run(police_report="unknown", forensic_exam=False), "reporting") == "unknown"


def test_alternative_the_engine_cannot_see_keeps_it_unknown():
    rules = set_params(zz(), "ZZ-REPORT-2", alternatives=["advocate"])
    assert status(run(rules=rules, police_report="no", forensic_exam=False), "reporting") == "unknown"


def test_exam_alternative_on_a_not_required_rule_still_counts():
    rules = set_params(set_params(zz(), "ZZ-REPORT-1", alternatives=[]), "ZZ-REPORT-2", alternatives=["forensic_exam"])
    assert status(run(rules=rules, police_report="no", forensic_exam=True), "reporting") == "satisfied"


def test_rules_that_require_nothing_never_make_it_required():
    rules = set_params(zz(), "ZZ-REPORT-1", required=False)
    assert status(run(rules=rules, police_report="no", forensic_exam=False), "reporting") == "unknown"
    assert status(run(rules=rules, police_report="yes", forensic_exam=False), "reporting") == "satisfied"


def test_rule_without_required_param_is_a_requirement():
    rules = replace_params(without(zz(), "ZZ-REPORT-2"), "ZZ-REPORT-1", {})
    assert status(run(rules=rules, police_report="no", forensic_exam=True), "reporting") == "required"


@pytest.mark.parametrize("alternatives, exam, expected", [
    ("forensic_exam", True, "satisfied"),
    ("forensic_exam", False, "required"),
    ("advocate", False, "unknown"),
    ("", False, "required"),
])
def test_alternatives_given_as_a_string(alternatives, exam, expected):
    rules = set_params(without(zz(), "ZZ-REPORT-2"), "ZZ-REPORT-1", alternatives=alternatives)
    assert status(run(rules=rules, police_report="no", forensic_exam=exam), "reporting") == expected


def test_no_reporting_rule_is_satisfied():
    out = run(rules=without(zz(), "reporting_requirement"), police_report="no", forensic_exam=False)
    assert out["checks"]["reporting"] == {"status": "satisfied", "rule_ids": []}


# Step 12 and the check trace

def test_info_rules_are_listed_in_file_order():
    assert run()["info_rule_ids"] == ["ZZ-COLL-1", "ZZ-CONDUCT-1", "ZZ-EMERG-1", "ZZ-ELIG-1", "ZZ-RES-1"]


def test_categories_no_step_uses_are_ignored():
    # submission, required_document, and processing_time describe how to file; the SPEC uses
    # none of them in a decision or in info_rule_ids.
    rules = add_rule(zz(), "ZZ-SUB-1", "submission", method="mail", target="PO Box 1")
    rules = add_rule(rules, "ZZ-DOC-1", "required_document", document="receipts")
    rules = add_rule(rules, "ZZ-TIME-1", "processing_time", days=90)
    items = [item("a", "medical", 50_000), item("b", "counseling", 9_000, units=1)]
    out, plain = run(*items, rules=rules), run(*items)
    out.pop("law_image_sha256")
    plain.pop("law_image_sha256")
    assert out == plain


def test_conduct_rule_never_changes_an_amount():
    items = [item("a", "medical", 50_000), item("b", "counseling", 9_000, units=1)]
    with_conduct = run(*items)
    without_conduct = run(*items, rules=without(zz(), "conduct_reduction"))
    with_conduct["info_rule_ids"].remove("ZZ-CONDUCT-1")
    with_conduct.pop("law_image_sha256")
    without_conduct.pop("law_image_sha256")
    assert with_conduct == without_conduct


def test_checks_come_last_in_step_order_naming_their_first_rule():
    out = run(item("a"))
    assert check_ops(out) == [("minimum_loss", "ZZ-MIN-1"), ("deadline", "ZZ-DEAD-1"), ("reporting", "ZZ-REPORT-1")]
    assert [t["op"] for t in out["trace"][-3:]] == ["minimum_loss", "deadline", "reporting"]
    bare = run(item("a"), rules=without(zz(), "minimum_loss", "filing_deadline", "reporting_requirement"))
    assert check_ops(bare) == [("minimum_loss", None), ("deadline", None), ("reporting", None)]
