"""SPEC steps 9-12: minimum loss, filing deadline, reporting, and the info list."""

import pytest

from claims import check_ops, item, law, rule, run, zy, zz


def checks(*items, rules=None, **context):
    return run(*items, rules=rules, **context)["checks"]


# 9. Minimum loss (ZZ-MIN-1: $100, waived automatically for sexual assault; ZZ-MIN-2: 5 lost days)

def test_minimum_loss_met_by_amount_and_days():
    c = checks(item("m", amount=20_000), item("w", "lost_wages", 50_000, units=1, unit="week"))
    assert c["minimum_loss"] == {"status": "met", "rule_ids": ["ZZ-MIN-1", "ZZ-MIN-2"]}


def test_days_only_rule_without_lost_days_is_unknown():
    # ZZ-MIN-1 is met; ZZ-MIN-2 cannot be checked from the claim.
    assert checks(item("m", amount=20_000))["minimum_loss"]["status"] == "unknown"


def test_waived_and_unknown_combine_to_unknown():
    assert checks(item("m", amount=5_000))["minimum_loss"]["status"] == "unknown"


def test_waiver_no_longer_depends_on_the_exam():
    for exam in (True, False):
        c = checks(item("w", "lost_wages", 5_000, units=1, unit="week"), forensic_exam=exam)
        assert c["minimum_loss"]["status"] == "waived"  # $50 is under $100; the 5 days meet ZZ-MIN-2


@pytest.mark.parametrize("waiver,sa,status", [
    ("automatic", True, "waived"), ("discretionary", True, "may_be_waived"), ("other", True, "not_met"),
    ("none", True, "not_met"), ("automatic", False, "not_met"), ("discretionary", False, "not_met"),
])
def test_waiver_kinds(waiver, sa, status):
    ir = law([rule("T-MED", "covered", expense="medical"),
              rule("T-MIN", "minimum_loss", cap_cents=10_000, waiver=waiver, waiver_for_sexual_assault=sa)])
    assert checks(item("m", amount=5_000), rules=ir)["minimum_loss"]["status"] == status
    assert checks(item("m", amount=10_000), rules=ir)["minimum_loss"]["status"] == "met"


def test_amount_or_days_rule_like_michigan():
    ir = law([rule("T-W", "covered", expense="lost_wages"),
              rule("T-MIN", "minimum_loss", cap_cents=20_000, days_lost=5, waiver="discretionary", waiver_for_sexual_assault=True)])

    def status(*items):
        return checks(*items, rules=ir)["minimum_loss"]["status"]

    assert status(item("w", "lost_wages", 100, units=1, unit="week")) == "met"  # 5 days
    assert status(item("d", "lost_wages", 100, units=5, unit="day")) == "met"
    assert status(item("d", "lost_wages", 100, units=4, unit="day")) == "may_be_waived"
    assert status(item("d", "lost_wages", 25_000, units=0)) == "met"  # $250
    assert status(item("w", "lost_wages", 100, units=4, unit="day"), item("x", "lost_wages", 100, units=1, unit="day",
                                                                             date="2026-07-02")) == "met"  # days add up
    assert status(item("h", "lost_wages", 100, units=40, unit="hour")) == "may_be_waived"  # hours are not days
    assert status(item("p", "lost_wages", 100, units=9, unit="day", confirmed=False)) == "may_be_waived"


def test_lost_days_count_only_eligible_lost_wage_lines():
    ir = law([rule("T-C", "covered", expense="counseling"), rule("T-MIN", "minimum_loss", days_lost=3)])
    # lost_wages has no coverage here, so its days do not count.
    assert checks(item("w", "lost_wages", 100, units=9, unit="day"), rules=ir)["minimum_loss"]["status"] == "unknown"
    assert checks(item("c", "counseling", 100, units=9, unit="day"), rules=ir)["minimum_loss"]["status"] == "unknown"


def test_minimum_loss_uses_the_total_after_caps():
    ir = law([rule("T-MED", "covered", expense="medical"), rule("T-T", "total_cap", cap_cents=4_000),
              rule("T-MIN", "minimum_loss", cap_cents=5_000)])
    assert checks(item("m", amount=6_000), rules=ir)["minimum_loss"]["status"] == "not_met"


def test_no_minimum_loss_rule_is_met():
    c = checks(item("m"), rules=law([rule("T-MED", "covered", expense="medical")]))
    assert c["minimum_loss"] == {"status": "met", "rule_ids": []}


def test_a_zero_minimum_is_always_met():
    ir = law([rule("T-MIN", "minimum_loss", cap_cents=0, waiver="none", waiver_for_sexual_assault=False)])
    assert checks(rules=ir)["minimum_loss"]["status"] == "met"


@pytest.mark.parametrize("statuses,combined", [
    (("waived", "may_be_waived"), "may_be_waived"), (("unknown", "may_be_waived"), "may_be_waived"),
    (("waived", "unknown"), "unknown"), (("may_be_waived", "not_met"), "not_met"), (("unknown", "not_met"), "not_met"),
])
def test_the_most_severe_rule_wins(statuses, combined):
    kinds = {"waived": dict(cap_cents=10_000, waiver="automatic", waiver_for_sexual_assault=True),
             "may_be_waived": dict(cap_cents=10_000, waiver="discretionary", waiver_for_sexual_assault=True),
             "not_met": dict(cap_cents=10_000, waiver="none", waiver_for_sexual_assault=False),
             "unknown": dict(days_lost=3)}
    ir = law([rule(f"T-{i}", "minimum_loss", **kinds[s]) for i, s in enumerate(statuses)])
    assert checks(rules=ir)["minimum_loss"]["status"] == combined


# 10. Deadline (ZZ-DEAD-1: 3 years from the crime; ZZ-DEAD-2: 180 days from discovery; ZZ-DEAD-5: 2 years from the report)

def test_latest_deadline_wins_and_report_anchors_are_flagged():
    d = checks()["deadline"]
    assert d == {"status": "ok", "deadline_date": "2029-06-13", "rule_ids": ["ZZ-DEAD-1", "ZZ-DEAD-2", "ZZ-DEAD-5"],
                 "flags": ["deadline_from_report"]}


def test_deadline_boundaries():
    assert checks(as_of="2029-06-13")["deadline"]["status"] == "ok"
    assert checks(as_of="2029-06-14")["deadline"]["status"] == "late"


def test_report_anchored_deadline_is_dated_from_the_incident():
    ir = law([rule("T-D", "deadline", days=730, **{"from": "report"})])
    d = checks(rules=ir)["deadline"]
    assert (d["deadline_date"], d["flags"]) == ("2028-06-13", ["deadline_from_report"])
    d = checks(rules=ir, as_of="2030-01-01")["deadline"]
    assert (d["status"], d["flags"]) == ("late", ["deadline_from_report"])  # a later report could leave time


def test_other_anchors_are_not_flagged():
    for anchor in ("crime", "incident", "discovery", "injury", "offense"):
        ir = law([rule("T-D", "deadline", days=30, **{"from": anchor})])
        assert checks(rules=ir)["deadline"]["flags"] == []
    assert checks(rules=law([rule("T-D", "deadline", days=30)]))["deadline"]["flags"] == []


def test_no_deadline_rule_is_unknown():
    d = checks(rules=zy())["deadline"]
    assert d == {"status": "unknown", "deadline_date": None, "rule_ids": [], "flags": []}


def test_dates_far_out_stop_at_9999():
    ir = law([rule("T-D", "deadline", days=4_000_000)])
    d = checks(rules=ir, incident="9990-01-01", as_of="9999-12-31")["deadline"]
    assert (d["status"], d["deadline_date"]) == ("ok", "9999-12-31")


def test_feb_29_incident():
    ir = law([rule("T-D", "deadline", days=365)])
    assert checks(rules=ir, incident="2024-02-29", as_of="2024-03-01")["deadline"]["deadline_date"] == "2025-02-28"


# 11. Reporting (ZZ-REPORT-1: required, an exam counts; ZZ-REPORT-2: not required)

@pytest.mark.parametrize("police,exam,status", [
    ("yes", False, "satisfied"), ("no", True, "satisfied"), ("no", False, "required"), ("unknown", False, "unknown"),
    ("unknown", True, "satisfied"),
])
def test_reporting(police, exam, status):
    assert checks(police_report=police, forensic_exam=exam)["reporting"] == {
        "status": status, "rule_ids": ["ZZ-REPORT-1", "ZZ-REPORT-2"]}


def test_alternatives_other_than_the_exam_do_not_satisfy():
    assert checks(rules=zy(), police_report="no", forensic_exam=True)["reporting"]["status"] == "required"


def test_no_required_rule_is_not_required():
    ir = law([rule("T-R", "reporting", required=False, alternatives=["advocate"])])
    assert checks(rules=ir, police_report="no", forensic_exam=False)["reporting"]["status"] == "not_required"
    assert checks(rules=law([]), police_report="no")["reporting"] == {"status": "not_required", "rule_ids": []}
    assert checks(rules=law([rule("T-R", "reporting")]), police_report="no")["reporting"]["status"] == "required"


# 12. Info rules and the check trace

def test_info_rule_ids_in_rule_order():
    assert run()["info_rule_ids"] == ["ZZ-COV-9", "ZZ-DEAD-3", "ZZ-DEAD-4", "ZZ-COLL-1", "ZZ-CONDUCT-1", "ZZ-EMERG-1",
                                      "ZZ-ELIG-1", "ZZ-RES-1"]


def test_checks_are_traced_last_in_a_fixed_order():
    assert check_ops(run(item("a"))) == [("minimum_loss", "ZZ-MIN-1"), ("deadline", "ZZ-DEAD-1"),
                                         ("reporting", "ZZ-REPORT-1")]
    assert check_ops(run(rules=law([]))) == [("minimum_loss", None), ("deadline", None), ("reporting", None)]


def test_zz_fixture_checks_are_what_the_tests_assume():
    kinds = {r["id"]: r for r in zz()["rules"]}
    assert kinds["ZZ-MIN-1"]["waiver"] == "automatic" and kinds["ZZ-MIN-2"]["days_lost"] == 5
    assert kinds["ZZ-DEAD-5"]["from"] == "report"
