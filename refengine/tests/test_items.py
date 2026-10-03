"""SPEC steps 1-6: the per-item decision, first matching step wins (hand-computed on the ZZ law)."""

from claims import AS_OF, INCIDENT, cap, item, law, line, rule, run, trace, with_rules, without, zz

COUNSELING_PROOF = ["ZZ-CAP-3", "ZZ-CAP-4", "ZZ-CAP-11", "ZZ-COV-2"]
HOLD_PROOF = ["ZZ-EXAM-1", "ZZ-EXAM-2", "ZZ-EXAM-3"]


# Step 1: window

def test_line_before_the_incident_is_out_of_window():
    out = run(item("a", date="2026-06-13"))
    assert line(out, "a")["status"] == "out_of_window"
    assert line(out, "a")["rule_ids"] == []
    assert out["totals"]["requested_cents"] == 0
    assert trace(out, "a") == [("out_of_window", None, 0)]


def test_line_after_as_of_is_out_of_window():
    assert line(run(item("a", date="2026-10-04")), "a")["status"] == "out_of_window"


def test_window_includes_both_ends():
    out = run(item("a", date=INCIDENT), item("b", date=AS_OF))
    assert [line(out, x)["status"] for x in "ab"] == ["eligible", "eligible"]


def test_window_comes_before_the_exam_hold():
    out = run(item("a", "forensic_exam", date="2026-06-01"))
    assert line(out, "a")["status"] == "out_of_window"
    assert line(out, "a")["expense"] == "forensic_exam"
    assert out["totals"]["held_cents"] == 0


def test_backwards_window_puts_every_line_out():
    out = run(item("a"), incident="2026-08-01", as_of="2026-07-01")
    assert line(out, "a")["status"] == "out_of_window"


# Step 2: forensic exam

def test_exam_is_held_with_no_bill_rules_then_payment_rules():
    out = run(item("a", "forensic_exam", 32_500, is_bill=True))
    a = line(out, "a")
    assert (a["status"], a["rule_ids"], a["allowed_cents"]) == ("held", HOLD_PROOF, 0)
    assert out["totals"]["held_cents"] == 32_500
    assert out["totals"]["requested_cents"] == 0
    assert trace(out, "a") == [("held", "ZZ-EXAM-1", 0)]


def test_hold_proof_order_does_not_depend_on_file_order():
    ir = zz()
    ir["rules"].sort(key=lambda r: r["kind"] != "exam_payment")  # payment rules first in the file
    assert line(run(item("a", "forensic_exam"), rules=ir), "a")["rule_ids"] == HOLD_PROOF


def test_unconfirmed_exam_is_still_held():
    assert line(run(item("a", "forensic_exam", confirmed=False)), "a")["status"] == "held"


def test_exam_hold_comes_before_exclusions():
    assert line(run(item("a", "forensic_exam", tags=["pain_suffering"])), "a")["status"] == "held"


def test_payment_rules_alone_do_not_hold_the_exam():
    # SPEC v1.2: without exam_no_bill the exam is medical, and the payment rules are info.
    out = run(item("a", "forensic_exam", 40_000), rules=without(zz(), "exam_no_bill"))
    a = line(out, "a")
    assert (a["status"], a["expense"], a["rule_ids"]) == ("eligible", "medical", ["ZZ-COV-1", "ZZ-COLL-1"])
    assert out["totals"]["held_cents"] == 0
    assert out["info_rule_ids"][:2] == ["ZZ-EXAM-2", "ZZ-EXAM-3"]


def test_payment_rules_are_not_info_when_the_exam_is_held():
    assert "ZZ-EXAM-2" not in run(item("a"))["info_rule_ids"]


def test_without_exam_rules_the_exam_is_medical():
    out = run(item("a", "forensic_exam", 40_000, insurance=10_000), rules=without(zz(), "exam_no_bill", "exam_payment"))
    a = line(out, "a")
    assert (a["expense"], a["status"], a["allowed_cents"]) == ("medical", "eligible", 30_000)
    assert a["rule_ids"] == ["ZZ-COV-1", "ZZ-COLL-1"]
    assert out["totals"]["by_expense"] == {"medical": 30_000}
    assert trace(out, "a") == [("eligible", "ZZ-COV-1", 40_000), ("collateral", "ZZ-COLL-1", -10_000)]


def test_exam_as_medical_without_medical_coverage_is_unknown_rule():
    out = run(item("a", "forensic_exam"), rules=without(zz(), "exam_no_bill", "ZZ-COV-1"))
    assert (line(out, "a")["status"], line(out, "a")["expense"]) == ("unknown_rule", "medical")


def test_exam_as_medical_still_waits_for_confirmation():
    out = run(item("a", "forensic_exam", confirmed=False), rules=without(zz(), "exam_no_bill"))
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
    assert (line(out, "a")["status"], line(out, "a")["rule_ids"]) == ("excluded", ["ZZ-EXCL-3"])


def test_exclusion_comes_before_confirmation():
    assert line(run(item("a", "property_replacement", confirmed=False)), "a")["status"] == "excluded"


def test_tag_only_exclusion_applies_to_every_expense():
    out = run(item("m", tags=["pain_suffering"]), item("u", "unknown", tags=["pain_suffering"]),
              item("p", "property_replacement", tags=["pain_suffering"]))
    assert line(out, "m")["rule_ids"] == ["ZZ-EXCL-2"]
    assert line(out, "u")["rule_ids"] == ["ZZ-EXCL-2"]
    assert line(out, "p")["rule_ids"] == ["ZZ-EXCL-1", "ZZ-EXCL-2"]  # every match, in rule order


def test_tags_the_law_never_names_change_nothing():
    out = run(item("a", tags=["groceries", "laptop"]))
    assert line(out, "a")["status"] == "eligible"


def test_a_narrow_exclusion_needs_its_tag():
    ir = law([rule("T-PROP", "covered", expense="property_replacement"),
              rule("T-PHONE", "excluded", expense="property_replacement", tags=["phone", "purse"])])
    out = run(item("phone", "property_replacement", tags=["phone"]), item("shirt", "property_replacement", tags=[]),
              item("bag", "property_replacement", tags=["purse"]), item("none", "property_replacement"), rules=ir)
    assert [line(out, x)["status"] for x in ("phone", "shirt", "bag", "none")] == \
        ["excluded", "eligible", "excluded", "eligible"]


# Step 4: unknown_rule

def test_expense_no_rule_names_is_unknown_rule():
    out = run(item("a", "funeral"), item("b", "unknown"))
    for x in "ab":
        assert (line(out, x)["status"], line(out, x)["rule_ids"]) == ("unknown_rule", [])
        assert trace(out, x) == [("unknown_rule", None, 0)]


def test_an_expense_cap_alone_covers_its_expense():
    out = run(item("a", "security", 5_000))
    assert (line(out, "a")["status"], line(out, "a")["rule_ids"]) == ("eligible", ["ZZ-CAP-7", "ZZ-COLL-1"])


# Step 5: needs_confirmation

def test_unconfirmed_line_shows_its_rules_and_is_not_counted():
    out = run(item("a", "counseling", 15_000, confirmed=False))
    a = line(out, "a")
    assert (a["status"], a["rule_ids"], a["allowed_cents"]) == ("needs_confirmation", COUNSELING_PROOF, 0)
    assert out["totals"] == {"requested_cents": 0, "allowed_cents": 0, "held_cents": 0, "by_expense": {}}
    assert trace(out, "a") == [("needs_confirmation", "ZZ-CAP-3", 0)]


def test_missing_confirmed_means_not_confirmed():
    data = item("a")
    del data["confirmed"]
    assert line(run(data), "a")["status"] == "needs_confirmation"


# Step 6: eligible

def test_eligible_line_cites_coverage_then_collateral():
    out = run(item("a", "counseling", 6_000, units=1, unit="session"))
    a = line(out, "a")
    assert (a["status"], a["allowed_cents"]) == ("eligible", 6_000)
    assert a["rule_ids"] == COUNSELING_PROOF + ["ZZ-COLL-1"]
    assert trace(out, "a")[0] == ("eligible", "ZZ-CAP-3", 6_000)


def test_insurance_comes_off_and_never_below_zero():
    out = run(item("a", amount=10_000, insurance=2_500), item("b", amount=10_000, insurance=99_000),
              item("c", amount=10_000))
    assert [line(out, x)["allowed_cents"] for x in "abc"] == [7_500, 0, 10_000]
    assert trace(out, "b") == [("eligible", "ZZ-COV-1", 10_000), ("collateral", "ZZ-COLL-1", -10_000)]
    assert trace(out, "c") == [("eligible", "ZZ-COV-1", 10_000)]  # nothing taken off, no entry


def test_without_a_collateral_rule_insurance_is_ignored():
    out = run(item("a", amount=10_000, insurance=2_500), rules=without(zz(), "collateral"))
    assert line(out, "a")["allowed_cents"] == 10_000
    assert line(out, "a")["rule_ids"] == ["ZZ-COV-1"]


def test_alternate_caps_are_listed_on_counted_and_waiting_lines():
    ir = law([cap("T-S1", "counseling", 12_500, "session", alt_rule_ids=["T-S0"]),
              cap("T-C1", "counseling", 500_000, alt_rule_ids=["T-C0", "T-C2"]), rule("T-MED", "covered", expense="medical")],
             skipped=[{"id": x, "category": "expense_cap", "reason": "less generous"} for x in ("T-S0", "T-C0", "T-C2")])
    out = run(item("c", "counseling"), item("w", "counseling", confirmed=False), item("m"), rules=ir)
    assert line(out, "c")["alt_cap_rule_ids"] == ["T-S0", "T-C0", "T-C2"]
    assert line(out, "w")["alt_cap_rule_ids"] == ["T-S0", "T-C0", "T-C2"]
    assert line(out, "m")["alt_cap_rule_ids"] == []


# Order

def test_lines_come_out_by_date_then_item_id_bytes():
    out = run(item("b", date="2026-07-02"), item("é", date="2026-07-01"), item("Z", date="2026-07-01"),
              item("a", date="2026-07-01"))
    assert [x["item_id"] for x in out["lines"]] == ["Z", "a", "é", "b"]


def test_input_order_does_not_matter():
    items = [item("b", "counseling", units=2, unit="session", date="2026-07-02"), item("a", "relocation", 150_000),
             item("c", "relocation", 90_000, date="2026-06-20"), item("d", "forensic_exam")]
    assert run(*items) == run(*reversed(items))


def test_requested_is_always_the_amount():
    out = run(item("a", "funeral", 700), item("b", date="2026-01-01", amount=900), item("c", amount=50))
    assert [x["requested_cents"] for x in out["lines"]] == [900, 700, 50]


def test_rules_added_later_do_not_change_earlier_steps():
    ir = with_rules(zz(), rule("T-LATE", "covered", expense="funeral"))
    assert line(run(item("a", "funeral", 700), rules=ir), "a")["status"] == "eligible"
