"""SPEC steps 9-12: minimum loss, deadline, reporting, and info rules."""

from claims import add_rule, check_ops, item, replace_params, run, set_params, without, zz


def checks(out: dict) -> dict:
    return out["checks"]


# Step 9: minimum loss (ZZ-MIN-1: $100, waived_for ["sexual_assault"])

def test_minimum_loss_met_at_exactly_the_threshold():
    out = run(item("a", "medical", 10_000), forensic_exam=False)
    assert checks(out)["minimum_loss"] == {"status": "met", "rule_ids": ["ZZ-MIN-1"]}
    assert ("minimum_loss_met", None) in check_ops(out)


def test_minimum_loss_not_met_below_the_threshold():
    out = run(item("a", "medical", 9_999), forensic_exam=False)
    assert checks(out)["minimum_loss"]["status"] == "not_met"
    assert ("minimum_loss_not_met", "ZZ-MIN-1") in check_ops(out)


def test_minimum_loss_waived_for_sexual_assault_with_an_exam():
    out = run(item("a", "medical", 500), forensic_exam=True)
    assert checks(out)["minimum_loss"]["status"] == "waived"
    assert ("minimum_loss_waived", "ZZ-MIN-1") in check_ops(out)


def test_minimum_loss_counts_allowed_cents_after_insurance():
    out = run(item("a", "medical", 50_000, insurance=45_000), forensic_exam=False)
    assert checks(out)["minimum_loss"]["status"] == "not_met"


def test_held_and_unconfirmed_lines_do_not_count_toward_the_minimum():
    out = run(item("a", "forensic_exam", 90_000), item("b", "medical", 50_000, confirmed=False),
              forensic_exam=False)
    assert checks(out)["minimum_loss"]["status"] == "not_met"


def test_waiver_accepts_a_single_string():
    rules = set_params(zz(), "ZZ-MIN-1", waived_for="sexual_assault")
    assert checks(run(item("a", "medical", 500), rules=rules))["minimum_loss"]["status"] == "waived"


def test_waiver_needs_the_sexual_assault_token():
    # The SC-MIN-2 shape: waived_for ["forensic_exam"] does not match the SPEC's token.
    rules = set_params(zz(), "ZZ-MIN-1", waived_for=["forensic_exam"])
    assert checks(run(item("a", "medical", 500), rules=rules))["minimum_loss"]["status"] == "not_met"


def test_any_unwaived_shortfall_is_not_met():
    rules = add_rule(zz(), "ZZ-MIN-9", "minimum_loss", amount_cents=5_000)
    assert checks(run(item("a", "medical", 7_000), rules=rules))["minimum_loss"]["status"] == "waived"
    out = run(item("a", "medical", 3_000), rules=rules)
    assert checks(out)["minimum_loss"] == {"status": "not_met", "rule_ids": ["ZZ-MIN-1", "ZZ-MIN-9"]}
    assert ("minimum_loss_not_met", "ZZ-MIN-9") in check_ops(out)


def test_only_days_lost_is_unknown():
    rules = replace_params(zz(), "ZZ-MIN-1", {"days_lost": 7})
    out = run(item("a", "medical", 500), rules=rules)
    assert checks(out)["minimum_loss"] == {"status": "unknown", "rule_ids": ["ZZ-MIN-1"]}
    assert ("minimum_loss_unknown", "ZZ-MIN-1") in check_ops(out)


def test_amount_and_days_lost_on_one_rule_uses_the_amount():
    rules = replace_params(zz(), "ZZ-MIN-1", {"amount_cents": 20_000, "days_lost": 5})
    assert checks(run(item("a", "medical", 500), rules=rules, forensic_exam=False))["minimum_loss"]["status"] == "not_met"


def test_rule_with_no_threshold_is_met():
    rules = replace_params(zz(), "ZZ-MIN-1", {})
    assert checks(run(item("a", "medical", 1), rules=rules))["minimum_loss"] == {"status": "met", "rule_ids": ["ZZ-MIN-1"]}


def test_no_minimum_loss_rule_is_met():
    out = run(rules=without(zz(), "minimum_loss"), forensic_exam=False)
    assert checks(out)["minimum_loss"] == {"status": "met", "rule_ids": []}


# Step 10: deadline (ZZ-DEAD-1: 3 years; ZZ-DEAD-2: 180 days; ZZ-DEAD-3: 10 years from age 18; ZZ-DEAD-4: none)

ALL_DEADLINES = ["ZZ-DEAD-1", "ZZ-DEAD-2", "ZZ-DEAD-3", "ZZ-DEAD-4"]


def test_deadline_uses_the_longest_rule_and_lists_all():
    out = run()
    assert checks(out)["deadline"] == {"status": "ok", "deadline_date": "2029-06-14", "rule_ids": ALL_DEADLINES}
    assert ("deadline_ok", "ZZ-DEAD-1") in check_ops(out)


def test_deadline_is_ok_on_the_last_day_and_late_the_next():
    assert checks(run(as_of="2029-06-14"))["deadline"]["status"] == "ok"
    out = run(as_of="2029-06-15")
    assert checks(out)["deadline"]["status"] == "late"
    assert ("deadline_late", "ZZ-DEAD-1") in check_ops(out)


def test_deadline_in_days():
    rules = without(zz(), "ZZ-DEAD-1")
    out = run(rules=rules, as_of="2026-12-12")
    assert checks(out)["deadline"] == {"status": "late", "deadline_date": "2026-12-11",
                                       "rule_ids": ["ZZ-DEAD-2", "ZZ-DEAD-3", "ZZ-DEAD-4"]}


def test_years_beat_days_on_one_rule():
    rules = replace_params(without(zz(), "ZZ-DEAD-1"), "ZZ-DEAD-2", {"years": 1, "days": 30})
    assert checks(run(rules=rules))["deadline"]["deadline_date"] == "2027-06-14"


def test_feb_29_plus_years_lands_on_feb_28():
    out = run(incident="2024-02-29", as_of="2027-02-28")
    assert checks(out)["deadline"]["deadline_date"] == "2027-02-28"
    assert checks(out)["deadline"]["status"] == "ok"
    assert checks(run(incident="2024-02-29", as_of="2027-03-01"))["deadline"]["status"] == "late"


def test_feb_29_into_a_leap_year_stays_feb_29():
    rules = set_params(zz(), "ZZ-DEAD-1", years=4)
    assert checks(run(rules=rules, incident="2024-02-29"))["deadline"]["deadline_date"] == "2028-02-29"


def test_age_18_rule_is_listed_but_not_dated():
    rules = without(zz(), "ZZ-DEAD-1", "ZZ-DEAD-2")
    out = run(rules=rules)
    assert checks(out)["deadline"] == {"status": "unknown", "deadline_date": None,
                                       "rule_ids": ["ZZ-DEAD-3", "ZZ-DEAD-4"]}
    assert ("deadline_unknown", None) in check_ops(out)


def test_age_18_rule_never_extends_the_deadline():
    rules = without(zz(), "ZZ-DEAD-2")
    assert checks(run(rules=rules))["deadline"]["deadline_date"] == "2029-06-14"


def test_no_deadline_rule_is_unknown():
    out = run(rules=without(zz(), "filing_deadline"))
    assert checks(out)["deadline"] == {"status": "unknown", "deadline_date": None, "rule_ids": []}


def test_huge_period_does_not_crash():
    rules = set_params(zz(), "ZZ-DEAD-1", years=100_000)
    assert checks(run(rules=rules))["deadline"]["deadline_date"] == "9999-12-31"


# Step 11: reporting (ZZ-REPORT-1: required, alternative forensic_exam; ZZ-REPORT-2: not required)

BOTH_REPORTING = ["ZZ-REPORT-1", "ZZ-REPORT-2"]


def test_police_report_satisfies():
    out = run(police_report="yes", forensic_exam=False)
    assert checks(out)["reporting"] == {"status": "satisfied", "rule_ids": BOTH_REPORTING}
    assert ("reporting_satisfied", None) in check_ops(out)


def test_forensic_exam_alternative_satisfies():
    out = run(police_report="no", forensic_exam=True)
    assert checks(out)["reporting"]["status"] == "satisfied"
    assert ("reporting_satisfied", "ZZ-REPORT-1") in check_ops(out)


def test_report_required_when_no_alternative_can_apply():
    out = run(police_report="no", forensic_exam=False)
    assert checks(out)["reporting"]["status"] == "required"
    assert ("reporting_required", "ZZ-REPORT-1") in check_ops(out)


def test_unknown_police_report_is_unknown():
    out = run(police_report="unknown", forensic_exam=False)
    assert checks(out)["reporting"]["status"] == "unknown"


def test_alternative_the_engine_cannot_see_keeps_it_unknown():
    rules = set_params(zz(), "ZZ-REPORT-2", alternatives=["advocate"])
    assert checks(run(rules=rules, police_report="no", forensic_exam=False))["reporting"]["status"] == "unknown"


def test_exam_alternative_on_a_not_required_rule_still_counts():
    rules = set_params(set_params(zz(), "ZZ-REPORT-1", alternatives=[]), "ZZ-REPORT-2", alternatives=["forensic_exam"])
    out = run(rules=rules, police_report="no", forensic_exam=True)
    assert checks(out)["reporting"]["status"] == "satisfied"
    assert ("reporting_satisfied", "ZZ-REPORT-2") in check_ops(out)


def test_rules_that_require_nothing_are_satisfied():
    rules = set_params(zz(), "ZZ-REPORT-1", required=False)
    out = run(rules=rules, police_report="no", forensic_exam=False)
    assert checks(out)["reporting"]["status"] == "satisfied"
    assert ("reporting_satisfied", None) in check_ops(out)


def test_rule_without_required_param_is_a_requirement():
    rules = replace_params(without(zz(), "ZZ-REPORT-2"), "ZZ-REPORT-1", {})
    assert checks(run(rules=rules, police_report="no", forensic_exam=True))["reporting"]["status"] == "required"


def test_no_reporting_rule_is_satisfied():
    out = run(rules=without(zz(), "reporting_requirement"), police_report="no", forensic_exam=False)
    assert checks(out)["reporting"] == {"status": "satisfied", "rule_ids": []}


# Step 12 and check order

def test_info_rules_are_listed_in_file_order():
    assert run()["info_rule_ids"] == ["ZZ-COLL-1", "ZZ-CONDUCT-1", "ZZ-EMERG-1", "ZZ-ELIG-1", "ZZ-RES-1"]


def test_conduct_rule_never_changes_an_amount():
    items = [item("a", "medical", 50_000), item("b", "counseling", 9_000, units=1)]
    with_conduct = run(*items)
    without_conduct = run(*items, rules=without(zz(), "conduct_reduction"))
    with_conduct["info_rule_ids"].remove("ZZ-CONDUCT-1")
    with_conduct.pop("law_image_sha256")
    without_conduct.pop("law_image_sha256")
    assert with_conduct == without_conduct


def test_checks_come_last_in_step_order():
    out = run(item("a"))
    assert [op for op, _ in check_ops(out)] == ["minimum_loss_met", "deadline_ok", "reporting_satisfied"]
    assert [t["op"] for t in out["trace"][-3:]] == ["minimum_loss_met", "deadline_ok", "reporting_satisfied"]
