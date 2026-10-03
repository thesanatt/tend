"""SPEC steps 1-6: the per-item decision, first matching step wins."""

from claims import AS_OF, INCIDENT, item, line, only, run, trace, without, zz

COUNSELING_PROOF = ["ZZ-CAP-3", "ZZ-CAP-4", "ZZ-COV-2"]


# Step 1: window

def test_line_before_the_incident_is_out_of_window():
    out = run(item("a", date="2026-06-13"))
    assert line(out, "a")["status"] == "out_of_window"
    assert line(out, "a")["rule_ids"] == []
    assert out["totals"]["requested_cents"] == 0


def test_line_after_as_of_is_out_of_window():
    out = run(item("a", date="2026-10-04"))
    assert line(out, "a")["status"] == "out_of_window"


def test_window_includes_both_ends():
    out = run(item("a", date=INCIDENT), item("b", date=AS_OF))
    assert line(out, "a")["status"] == "eligible"
    assert line(out, "b")["status"] == "eligible"


def test_window_comes_before_the_exam_hold():
    out = run(item("a", "forensic_exam", date="2026-06-01"))
    assert line(out, "a")["status"] == "out_of_window"
    assert out["totals"]["held_cents"] == 0


def test_backwards_window_puts_every_line_out():
    out = run(item("a"), incident="2026-08-01", as_of="2026-07-01")
    assert line(out, "a")["status"] == "out_of_window"


# Step 2: forensic exam

def test_forensic_exam_is_held_with_exam_rules_as_proof():
    out = run(item("a", "forensic_exam", 32_500, is_bill=True))
    a = line(out, "a")
    assert a["status"] == "held"
    assert a["rule_ids"] == ["ZZ-EXAM-1", "ZZ-EXAM-2"]
    assert a["allowed_cents"] == 0
    assert out["totals"]["held_cents"] == 32_500
    assert out["totals"]["requested_cents"] == 0
    assert trace(out, "a") == [("held", "ZZ-EXAM-1", 0)]


def test_exam_rule_naming_another_expense_is_not_proof():
    out = run(item("a", "forensic_exam"))
    assert "ZZ-EXAM-3" not in line(out, "a")["rule_ids"]


def test_unconfirmed_exam_is_still_held():
    out = run(item("a", "forensic_exam", confirmed=False))
    assert line(out, "a")["status"] == "held"


def test_exam_payment_alone_still_holds():
    out = run(item("a", "forensic_exam"), rules=without(zz(), "ZZ-EXAM-1"))
    assert line(out, "a")["status"] == "held"
    assert line(out, "a")["rule_ids"] == ["ZZ-EXAM-2"]


def test_exam_no_bill_alone_holds():
    out = run(item("a", "forensic_exam"), rules=without(zz(), "ZZ-EXAM-2"))
    assert line(out, "a")["rule_ids"] == ["ZZ-EXAM-1"]


def test_without_exam_rules_the_exam_is_medical():
    rules = without(zz(), "exam_no_bill", "exam_payment")
    out = run(item("a", "forensic_exam", 40_000, insurance=10_000), rules=rules)
    a = line(out, "a")
    assert a["expense"] == "medical"
    assert a["status"] == "eligible"
    assert a["rule_ids"] == ["ZZ-COV-1", "ZZ-COLL-1"]
    assert a["allowed_cents"] == 30_000
    assert out["totals"]["by_expense"] == {"medical": 30_000}
    assert trace(out, "a") == [("exam_as_medical", None, 0), ("eligible", "ZZ-COV-1", 40_000),
                               ("collateral", "ZZ-COLL-1", -10_000)]


def test_exam_rules_naming_only_medical_do_not_hold():
    rules = only(without(zz(), "exam_no_bill"), "exam_payment", "ZZ-EXAM-3")
    out = run(item("a", "forensic_exam"), rules=rules)
    assert line(out, "a")["status"] == "eligible"
    assert line(out, "a")["expense"] == "medical"


def test_exam_as_medical_without_medical_coverage_is_unknown_rule():
    rules = without(zz(), "exam_no_bill", "exam_payment", "ZZ-COV-1")
    out = run(item("a", "forensic_exam"), rules=rules)
    assert line(out, "a")["status"] == "unknown_rule"
    assert line(out, "a")["expense"] == "medical"


def test_exam_as_medical_still_waits_for_confirmation():
    rules = without(zz(), "exam_no_bill", "exam_payment")
    out = run(item("a", "forensic_exam", confirmed=False), rules=rules)
    assert line(out, "a")["status"] == "needs_confirmation"
    assert line(out, "a")["rule_ids"] == ["ZZ-COV-1"]


# Step 3: excluded

def test_excluded_expense_cites_the_exclusion():
    out = run(item("a", "property_replacement", 40_000))
    a = line(out, "a")
    assert (a["status"], a["rule_ids"], a["allowed_cents"]) == ("excluded", ["ZZ-EXCL-1"], 0)
    assert trace(out, "a") == [("excluded", "ZZ-EXCL-1", 0)]


def test_exclusion_wins_over_coverage():
    out = run(item("a", "childcare"))
    assert line(out, "a")["status"] == "excluded"
    assert line(out, "a")["rule_ids"] == ["ZZ-EXCL-3"]


def test_exclusion_comes_before_confirmation():
    out = run(item("a", "property_replacement", confirmed=False))
    assert line(out, "a")["status"] == "excluded"


def test_text_only_exclusion_matches_no_expense():
    out = run(*[item(f"x{n}", expense) for n, expense in enumerate(
        ["medical", "counseling", "lost_wages", "transportation", "relocation", "prescription", "dental"])])
    assert all("ZZ-EXCL-2" not in entry["rule_ids"] for entry in out["lines"])


# Step 4: unknown_rule

def test_unknown_expense_is_never_counted():
    out = run(item("a", "unknown", 3_000))
    a = line(out, "a")
    assert (a["status"], a["rule_ids"], a["allowed_cents"]) == ("unknown_rule", [], 0)
    assert out["totals"]["requested_cents"] == 0


def test_expense_with_no_rule_is_unknown_rule():
    assert line(run(item("a", "tuition")), "a")["status"] == "unknown_rule"


def test_expense_outside_the_enum_is_unknown_rule():
    out = run(item("a", "groceries"))
    assert line(out, "a")["status"] == "unknown_rule"
    assert line(out, "a")["expense"] == "groceries"


def test_expense_covered_only_by_a_cap_is_eligible():
    out = run(item("a", "security", 50_000))
    assert line(out, "a")["status"] == "eligible"
    assert line(out, "a")["rule_ids"] == ["ZZ-CAP-7", "ZZ-COLL-1"]


def test_cap_without_amount_still_counts_as_coverage():
    out = run(item("a", "temporary_housing", 90_000))
    assert line(out, "a")["status"] == "eligible"
    assert line(out, "a")["rule_ids"] == ["ZZ-CAP-9", "ZZ-COLL-1"]


def test_unknown_rule_comes_before_confirmation():
    assert line(run(item("a", "tuition", confirmed=False)), "a")["status"] == "unknown_rule"


# Step 5: needs_confirmation

def test_unconfirmed_line_shows_its_rules_but_counts_nothing():
    out = run(item("a", "counseling", 15_000, confirmed=False, insurance=5_000))
    a = line(out, "a")
    assert a["status"] == "needs_confirmation"
    assert a["rule_ids"] == COUNSELING_PROOF
    assert a["allowed_cents"] == 0
    assert out["totals"] == {"requested_cents": 0, "allowed_cents": 0, "held_cents": 0, "by_expense": {}}
    assert trace(out, "a") == [("needs_confirmation", "ZZ-CAP-3", 0)]


# Step 6: eligible and collateral

def test_eligible_line_allows_the_amount_with_full_proof():
    out = run(item("a", "counseling", 15_000, units=2))
    a = line(out, "a")
    assert a["status"] == "eligible"
    assert a["allowed_cents"] == 15_000
    assert a["rule_ids"] == COUNSELING_PROOF + ["ZZ-COLL-1"]
    assert trace(out, "a") == [("eligible", "ZZ-CAP-3", 15_000), ("collateral", "ZZ-COLL-1", 0)]


def test_collateral_subtracts_insurance():
    out = run(item("a", "medical", 120_000, insurance=20_000))
    assert line(out, "a")["allowed_cents"] == 100_000
    assert line(out, "a")["requested_cents"] == 120_000
    assert out["totals"]["requested_cents"] == 120_000
    assert out["totals"]["allowed_cents"] == 100_000


def test_insurance_above_the_amount_floors_at_zero():
    out = run(item("a", "medical", 10_000, insurance=15_000))
    assert line(out, "a")["allowed_cents"] == 0
    assert trace(out, "a")[-1] == ("collateral", "ZZ-COLL-1", -10_000)


def test_without_a_collateral_rule_insurance_is_ignored():
    out = run(item("a", "medical", 10_000, insurance=4_000), rules=without(zz(), "collateral_source"))
    assert line(out, "a")["allowed_cents"] == 10_000
    assert line(out, "a")["rule_ids"] == ["ZZ-COV-1"]
    assert [op for op, _, _ in trace(out, "a")] == ["eligible"]


def test_every_collateral_rule_joins_the_proof():
    rules = zz()
    rules["rules"].append({**next(r for r in rules["rules"] if r["id"] == "ZZ-COLL-1"), "id": "ZZ-COLL-2"})
    out = run(item("a", "medical", insurance=1_000), rules=rules)
    assert line(out, "a")["rule_ids"] == ["ZZ-COV-1", "ZZ-COLL-1", "ZZ-COLL-2"]
    assert trace(out, "a")[-1] == ("collateral", "ZZ-COLL-1", -1_000)


def test_rule_expense_can_live_in_params_or_on_the_rule():
    # ZZ-CAP-3 names counseling only in params; ZZ-CAP-7 names security only on the rule.
    out = run(item("a", "counseling"), item("b", "security"))
    assert "ZZ-CAP-3" in line(out, "a")["rule_ids"]
    assert "ZZ-CAP-7" in line(out, "b")["rule_ids"]


def test_zero_amount_line_is_eligible_for_zero():
    out = run(item("a", "medical", 0))
    assert line(out, "a")["status"] == "eligible"
    assert line(out, "a")["allowed_cents"] == 0
