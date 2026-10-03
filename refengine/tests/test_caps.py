"""SPEC steps 7-8: expense caps (per unit, then per claim) and the total cap."""

import pytest

from claims import add_rule, item, line, run, set_params, trace, without, zz


def allowed(out: dict) -> dict:
    return {entry["item_id"]: entry["allowed_cents"] for entry in out["lines"]}


def cap_ids(out: dict) -> dict:
    return {entry["item_id"]: entry["cap_rule_id"] for entry in out["lines"]}


# Claim caps (ZZ-CAP-6: relocation, $2,000 per claim)

def test_claim_cap_cuts_the_crossing_line_and_zeroes_later_ones():
    out = run(item("a", "relocation", 150_000, date="2026-07-01"),
              item("b", "relocation", 80_000, date="2026-07-02"),
              item("c", "relocation", 30_000, date="2026-07-03"))
    assert allowed(out) == {"a": 150_000, "b": 50_000, "c": 0}
    assert cap_ids(out) == {"a": None, "b": "ZZ-CAP-6", "c": "ZZ-CAP-6"}
    assert trace(out, "b")[-1] == ("expense_cap", "ZZ-CAP-6", -30_000)
    assert trace(out, "c")[-1] == ("expense_cap", "ZZ-CAP-6", -30_000)
    assert out["totals"]["by_expense"] == {"relocation": 200_000}


def test_reaching_the_cap_exactly_cuts_nothing():
    out = run(item("a", "relocation", 120_000, date="2026-07-01"),
              item("b", "relocation", 80_000, date="2026-07-02"))
    assert allowed(out) == {"a": 120_000, "b": 80_000}
    assert cap_ids(out) == {"a": None, "b": None}


def test_first_line_after_an_exact_fill_is_cut_to_zero():
    out = run(item("a", "relocation", 200_000, date="2026-07-01"),
              item("b", "relocation", 1, date="2026-07-02"))
    assert allowed(out) == {"a": 200_000, "b": 0}
    assert cap_ids(out)["b"] == "ZZ-CAP-6"


def test_every_line_after_the_crossing_records_the_cap():
    # b was already at 0 (insurance paid it); it still records the cap, with a zero delta.
    out = run(item("a", "relocation", 250_000, date="2026-07-01"),
              item("b", "relocation", 40_000, insurance=40_000, date="2026-07-02"))
    assert allowed(out) == {"a": 200_000, "b": 0}
    assert cap_ids(out) == {"a": "ZZ-CAP-6", "b": "ZZ-CAP-6"}
    assert trace(out, "b") == [("eligible", "ZZ-CAP-6", 40_000), ("collateral", "ZZ-COLL-1", -40_000),
                               ("expense_cap", "ZZ-CAP-6", 0)]


def test_zero_lines_before_the_crossing_are_left_alone():
    out = run(item("a", "relocation", 40_000, insurance=40_000, date="2026-07-01"),
              item("b", "relocation", 250_000, date="2026-07-02"))
    assert cap_ids(out) == {"a": None, "b": "ZZ-CAP-6"}


def test_cap_walk_uses_allowed_after_insurance():
    out = run(item("a", "relocation", 250_000, insurance=100_000, date="2026-07-01"),
              item("b", "relocation", 80_000, date="2026-07-02"))
    assert allowed(out) == {"a": 150_000, "b": 50_000}


def test_cap_walk_follows_date_then_item_id():
    out = run(item("b", "relocation", 150_000, date="2026-07-01"),
              item("a", "relocation", 150_000, date="2026-07-01"),
              item("0", "relocation", 150_000, date="2026-07-02"))
    assert allowed(out) == {"a": 150_000, "b": 50_000, "0": 0}
    assert [entry["item_id"] for entry in out["lines"]] == ["a", "b", "0"]


def test_unconfirmed_lines_take_no_room_under_the_cap():
    out = run(item("a", "relocation", 150_000, confirmed=False, date="2026-07-01"),
              item("b", "relocation", 150_000, date="2026-07-02"))
    assert allowed(out) == {"a": 0, "b": 150_000}


def test_cap_with_no_per_acts_per_claim():
    assert allowed(run(item("a", "relocation", 250_000), rules=set_params(zz(), "ZZ-CAP-6", per=None))) == {"a": 200_000}


def test_cap_without_an_amount_limits_nothing():
    out = run(item("a", "temporary_housing", 1_000_000))
    assert allowed(out) == {"a": 1_000_000}
    assert line(out, "a")["flags"] == []


def test_two_claim_caps_on_one_expense_apply_in_file_order():
    rules = add_rule(zz(), "ZZ-CAP-99", "expense_cap", expense="relocation", amount_cents=100_000, per="claim")
    out = run(item("a", "relocation", 80_000, date="2026-07-01"),
              item("b", "relocation", 80_000, date="2026-07-02"),
              item("c", "relocation", 80_000, date="2026-07-03"), rules=rules)
    # ZZ-CAP-6 ($2,000) cuts c to 40,000; then ZZ-CAP-99 ($1,000) cuts b to 20,000 and c to 0.
    assert allowed(out) == {"a": 80_000, "b": 20_000, "c": 0}
    assert cap_ids(out) == {"a": None, "b": "ZZ-CAP-99", "c": "ZZ-CAP-99"}
    assert [t for t in trace(out) if t[0] == "expense_cap"] == [
        ("expense_cap", "ZZ-CAP-6", -40_000), ("expense_cap", "ZZ-CAP-99", -60_000),
        ("expense_cap", "ZZ-CAP-99", -40_000)]


# Caps the engine cannot measure (ZZ-CAP-7 per residence, ZZ-CAP-10 per crime_scene)

def test_unmeasurable_caps_flag_every_line_and_cut_nothing():
    out = run(item("a", "security", 60_000, date="2026-07-01"),
              item("b", "security", 60_000, date="2026-07-02"),
              item("c", "crime_scene_cleanup", 600_000, units=3, date="2026-07-03"))
    assert allowed(out) == {"a": 60_000, "b": 60_000, "c": 600_000}
    assert cap_ids(out) == {"a": None, "b": None, "c": None}
    assert [line(out, i)["flags"] for i in "abc"] == [["rate_unverified:ZZ-CAP-7"], ["rate_unverified:ZZ-CAP-7"],
                                                       ["rate_unverified:ZZ-CAP-10"]]


@pytest.mark.parametrize("per", ["month", "item", "residence", "crime_scene"])
def test_any_unlisted_per_only_flags(per):
    rules = set_params(zz(), "ZZ-CAP-6", per=per)
    out = run(item("a", "relocation", 250_000, units=4), rules=rules)
    assert allowed(out) == {"a": 250_000}
    assert line(out, "a")["flags"] == ["rate_unverified:ZZ-CAP-6"]


def test_flags_follow_rule_order_across_unit_and_unmeasurable_caps():
    rules = add_rule(zz(), "ZZ-CAP-98", "expense_cap", expense="counseling", amount_cents=10_000, per="month")
    out = run(item("a", "counseling", 5_000), rules=rules)
    assert line(out, "a")["flags"] == ["rate_unverified:ZZ-CAP-3", "rate_unverified:ZZ-CAP-98"]


# Unit caps (ZZ-CAP-3: counseling $80/session; ZZ-CAP-5: wages $400/week; ZZ-CAP-8: $0.50/mile)

def test_unit_cap_limits_to_rate_times_units():
    out = run(item("a", "counseling", 30_000, units=2))
    assert allowed(out) == {"a": 16_000}
    assert cap_ids(out) == {"a": "ZZ-CAP-3"}
    assert trace(out, "a")[-1] == ("unit_cap", "ZZ-CAP-3", -14_000)


def test_unit_cap_at_or_under_the_limit_changes_nothing():
    out = run(item("a", "counseling", 16_000, units=2), item("b", "counseling", 9_000, units=2))
    assert allowed(out) == {"a": 16_000, "b": 9_000}
    assert cap_ids(out) == {"a": None, "b": None}
    assert all(op != "unit_cap" for op, _, _ in trace(out))


def test_unit_cap_without_units_flags_the_line_and_keeps_the_amount():
    out = run(item("a", "lost_wages", 900_000, units=0))
    a = line(out, "a")
    assert a["allowed_cents"] == 900_000
    assert a["flags"] == ["rate_unverified:ZZ-CAP-5"]
    assert a["cap_rule_id"] is None
    assert trace(out, "a")[-1] == ("rate_unverified", "ZZ-CAP-5", 0)


def test_mile_cap_is_cents_per_mile():
    assert allowed(run(item("a", "transportation", 10_000, units=100))) == {"a": 5_000}


def test_unit_caps_run_before_claim_caps():
    out = run(item("a", "counseling", 300_000, units=10, date="2026-07-01"),
              item("b", "counseling", 250_000, units=40, date="2026-07-02"))
    # Unit cap first: a -> 80,000. The claim cap of 300,000 then leaves 220,000 for b.
    assert allowed(out) == {"a": 80_000, "b": 220_000}
    assert cap_ids(out) == {"a": "ZZ-CAP-3", "b": "ZZ-CAP-4"}


def test_rate_flag_survives_a_later_claim_cut():
    out = run(item("a", "counseling", 290_000, units=40, date="2026-07-01"),
              item("b", "counseling", 50_000, units=0, date="2026-07-02"))
    b = line(out, "b")
    assert b["allowed_cents"] == 10_000
    assert b["flags"] == ["rate_unverified:ZZ-CAP-3"]
    assert b["cap_rule_id"] == "ZZ-CAP-4"


@pytest.mark.parametrize("per", ["week", "session", "hour", "mile", "day"])
def test_every_listed_per_is_a_unit_cap(per):
    rules = set_params(zz(), "ZZ-CAP-3", per=per)
    assert allowed(run(item("a", "counseling", 30_000, units=2), rules=rules)) == {"a": 16_000}


# Total cap (ZZ-CAP-1: $25,000; ZZ-CAP-2: $30,000)

def test_total_cap_uses_the_smallest_and_walks_every_expense():
    out = run(item("a", "medical", 2_000_000, date="2026-07-01"),
              item("b", "lost_wages", 1_000_000, date="2026-07-02"),
              item("c", "dental", 10_000, date="2026-07-03"))
    assert allowed(out) == {"a": 2_000_000, "b": 500_000, "c": 0}
    assert cap_ids(out) == {"a": None, "b": "ZZ-CAP-1", "c": "ZZ-CAP-1"}
    assert out["totals"]["allowed_cents"] == 2_500_000
    assert out["totals"]["requested_cents"] == 3_010_000


def test_total_cap_on_a_tie_uses_the_first_rule():
    rules = set_params(zz(), "ZZ-CAP-2", amount_cents=2_500_000)
    assert cap_ids(run(item("a", "medical", 2_600_000), rules=rules)) == {"a": "ZZ-CAP-1"}


def test_total_cap_overrides_an_earlier_cap_rule_id():
    out = run(item("a", "medical", 2_450_000, date="2026-07-01"),
              item("b", "relocation", 250_000, date="2026-07-02"))
    assert allowed(out) == {"a": 2_450_000, "b": 50_000}
    assert cap_ids(out)["b"] == "ZZ-CAP-1"
    assert [op for op, _, _ in trace(out, "b")] == ["eligible", "expense_cap", "total_cap"]


def test_total_cap_rule_without_an_amount_is_ignored():
    rules = set_params(without(zz(), "ZZ-CAP-1"), "ZZ-CAP-2", amount_cents=None)
    assert allowed(run(item("a", "medical", 5_000_000), rules=rules)) == {"a": 5_000_000}


def test_no_total_cap_rule_means_no_total_limit():
    assert run(item("a", "medical", 9_000_000), rules=without(zz(), "total_cap"))["totals"]["allowed_cents"] == 9_000_000


def test_trace_deltas_add_up_to_each_line():
    out = run(item("a", "counseling", 400_000, units=3, insurance=1_000, date="2026-07-01"),
              item("b", "counseling", 300_000, units=0, date="2026-07-02"),
              item("c", "medical", 2_400_000, insurance=5, date="2026-07-03"))
    for entry in out["lines"]:
        assert sum(d for _, _, d in trace(out, entry["item_id"])) == entry["allowed_cents"]
