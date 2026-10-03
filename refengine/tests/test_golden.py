"""Golden cases, worked out by hand from the SPEC one step at a time.

zz_mixed: tests/golden/zz_mixed.input.json against tests/fixtures/ir/ZZ.json. The expected
document (zz_mixed.expected.json) was checked against the hand-computed values below, which stay
here so a reader can follow the arithmetic. engine golden: the C++ engine's own fixture and
golden output (engine/tests/golden/ZZ_claim.out.json), which the reference must reproduce byte
for byte when told the image's sha256.
"""

import json

from claims import FIXTURES, GOLDEN, REPO
from tend_ref import evaluate_json, load_law

LAW = FIXTURES / "ir" / "ZZ.json"

# (item_id, expense, status, requested, allowed, cap_rule_id, flags), in processing order.
LINES = [
    ("a1", "medical", "out_of_window", 5_000, 0, None, []),
    ("a2", "forensic_exam", "held", 32_500, 0, None, []),
    ("a3", "medical", "eligible", 120_000, 100_000, None, []),  # $1,200 less $200 insurance
    ("a4", "counseling", "eligible", 15_000, 15_000, None, ["rate_unverified:ZZ-CAP-11"]),  # 2 x $80 = $160 does not bind
    ("a5", "counseling", "eligible", 20_000, 20_000, None, ["rate_unverified:ZZ-CAP-3", "rate_unverified:ZZ-CAP-11"]),
    ("a6", "counseling", "eligible", 300_000, 80_000, "ZZ-CAP-3", ["rate_unverified:ZZ-CAP-11"]),  # 10 x $80
    # 25 sessions fit in the 28 left of 40; then the $3,000 counseling cap is crossed: 3000 - 150 - 200 - 800 = 1850.
    ("a7", "counseling", "eligible", 200_000, 185_000, "ZZ-CAP-4", ["rate_unverified:ZZ-CAP-11"]),
    ("a8", "counseling", "eligible", 9_000, 0, "ZZ-CAP-4", ["rate_unverified:ZZ-CAP-11"]),  # $80, then past the cap
    ("a9", "counseling", "eligible", 12_000, 0, "ZZ-CAP-4", ["rate_unverified:ZZ-CAP-3"]),  # 2 hours x $15, then past the cap
    ("a10", "property_replacement", "excluded", 40_000, 0, None, []),
    ("a11", "tuition", "unknown_rule", 50_000, 0, None, []),
    ("a12", "childcare", "excluded", 7_000, 0, None, []),
    ("a13", "transportation", "needs_confirmation", 4_000, 0, None, []),
    ("a14", "lost_wages", "eligible", 2_400_000, 240_000, "ZZ-CAP-5", []),  # 6 weeks x $400
    ("a15", "unknown", "excluded", 3_000, 0, None, []),  # pain and suffering, by tag
    # The $25,000 total cap: 1000 + 150 + 200 + 800 + 1850 + 2400 = 6400 used, so $18,600 is left.
    ("a18", "medical", "eligible", 2_000_000, 1_860_000, "ZZ-CAP-1", []),
    ("a17", "relocation", "eligible", 250_000, 0, "ZZ-CAP-1", []),  # cut to $2,000 by ZZ-CAP-6, then past the total cap
    ("a16", "medical", "out_of_window", 9_999, 0, None, []),
]

TRACE = [
    ("out_of_window", "a1", None, 0),
    ("held", "a2", "ZZ-EXAM-1", 0),
    ("eligible", "a3", "ZZ-COV-1", 120_000), ("collateral", "a3", "ZZ-COLL-1", -20_000),
    ("eligible", "a4", "ZZ-CAP-3", 15_000),
    ("eligible", "a5", "ZZ-CAP-3", 20_000),
    ("eligible", "a6", "ZZ-CAP-3", 300_000),
    ("eligible", "a7", "ZZ-CAP-3", 200_000),
    ("eligible", "a8", "ZZ-CAP-3", 9_000),
    ("eligible", "a9", "ZZ-CAP-3", 12_000), ("collateral", "a9", "ZZ-COLL-1", -2_000),
    ("excluded", "a10", "ZZ-EXCL-1", 0),
    ("unknown_rule", "a11", None, 0),
    ("excluded", "a12", "ZZ-EXCL-3", 0),
    ("needs_confirmation", "a13", "ZZ-CAP-8", 0),
    ("eligible", "a14", "ZZ-CAP-5", 2_400_000),
    ("excluded", "a15", "ZZ-EXCL-2", 0),
    ("eligible", "a18", "ZZ-COV-1", 2_000_000),
    ("eligible", "a17", "ZZ-CAP-6", 250_000),
    ("out_of_window", "a16", None, 0),
    # 7a: ZZ-CAP-3 (per session, 40 sessions), ZZ-CAP-5 (per week), ZZ-CAP-8 (per mile, no line), ZZ-CAP-11 (per hour).
    ("rate_unverified", "a5", "ZZ-CAP-3", 0),
    ("unit_cap", "a6", "ZZ-CAP-3", -220_000),
    ("unit_cap", "a8", "ZZ-CAP-3", -1_000),
    ("rate_unverified", "a9", "ZZ-CAP-3", 0),
    ("unit_cap", "a14", "ZZ-CAP-5", -2_160_000),
    ("rate_unverified", "a4", "ZZ-CAP-11", 0), ("rate_unverified", "a5", "ZZ-CAP-11", 0),
    ("rate_unverified", "a6", "ZZ-CAP-11", 0), ("rate_unverified", "a7", "ZZ-CAP-11", 0),
    ("rate_unverified", "a8", "ZZ-CAP-11", 0),
    ("unit_cap", "a9", "ZZ-CAP-11", -7_000),
    # 7b: counseling ($3,000), then relocation ($2,000).
    ("expense_cap", "a7", "ZZ-CAP-4", -15_000), ("expense_cap", "a8", "ZZ-CAP-4", -8_000),
    ("expense_cap", "a9", "ZZ-CAP-4", -3_000),
    ("expense_cap", "a17", "ZZ-CAP-6", -50_000),
    # 8: the smaller total cap.
    ("total_cap", "a18", "ZZ-CAP-1", -140_000), ("total_cap", "a17", "ZZ-CAP-1", -200_000),
    ("minimum_loss", None, "ZZ-MIN-1", 0), ("deadline", None, "ZZ-DEAD-1", 0), ("reporting", None, "ZZ-REPORT-1", 0),
]


def evaluate_mixed(law_sha256=None) -> str:
    law = load_law(LAW, law_sha256=law_sha256)
    return evaluate_json(law, (GOLDEN / "zz_mixed.input.json").read_bytes())


def test_lines_match_the_hand_computation():
    out = json.loads(evaluate_mixed())
    got = [(x["item_id"], x["expense"], x["status"], x["requested_cents"], x["allowed_cents"], x["cap_rule_id"], x["flags"])
           for x in out["lines"]]
    assert got == LINES


def test_trace_matches_the_hand_computation():
    out = json.loads(evaluate_mixed())
    assert [(t["op"], t["item_id"], t["rule_id"], t["delta_cents"]) for t in out["trace"]] == TRACE


def test_totals_and_checks_match_the_hand_computation():
    out = json.loads(evaluate_mixed())
    assert out["totals"] == {"requested_cents": 5_326_000, "allowed_cents": 2_500_000, "held_cents": 32_500,
                             "by_expense": {"counseling": 300_000, "lost_wages": 240_000, "medical": 1_960_000,
                                            "relocation": 0}}
    assert out["checks"] == {
        "deadline": {"status": "ok", "deadline_date": "2029-06-13", "rule_ids": ["ZZ-DEAD-1", "ZZ-DEAD-2", "ZZ-DEAD-5"],
                     "flags": ["deadline_from_report"]},
        "minimum_loss": {"status": "met", "rule_ids": ["ZZ-MIN-1", "ZZ-MIN-2"]},  # $25,000, and 6 weeks = 30 days
        "reporting": {"status": "satisfied", "rule_ids": ["ZZ-REPORT-1", "ZZ-REPORT-2"]},  # the exam counts
    }
    assert out["info_rule_ids"] == ["ZZ-COV-9", "ZZ-DEAD-3", "ZZ-DEAD-4", "ZZ-COLL-1", "ZZ-CONDUCT-1", "ZZ-EMERG-1",
                                    "ZZ-ELIG-1", "ZZ-RES-1"]
    assert sum(t["delta_cents"] for t in out["trace"]) == out["totals"]["allowed_cents"]


def test_expected_file_is_the_whole_document():
    expected = (GOLDEN / "zz_mixed.expected.json").read_text(encoding="utf-8").rstrip("\n")
    sha = json.loads(expected)["law_image_sha256"]
    assert evaluate_mixed(sha) == expected


def test_reference_reproduces_the_cpp_golden_byte_for_byte():
    engine = REPO / "engine" / "tests"
    expected = (engine / "golden" / "ZZ_claim.out.json").read_text(encoding="utf-8").rstrip("\n")
    law = load_law(engine / "fixtures" / "ir" / "ZZ.json", law_sha256=json.loads(expected)["law_image_sha256"])
    assert evaluate_json(law, (engine / "fixtures" / "ZZ_claim.json").read_bytes()) == expected
