"""Reading law IR version 2 the way tendc does: the same laws refused, with the same messages."""

import json
import subprocess

import pytest

from claims import FIXTURES, REPO, cap, law, rule
from tend_ref import Law, LawError, law_from_bytes, load_law

TENDC = REPO / "engine" / "build" / "tendc"
REFUSED = [
    ({}, "IR: ir_version must be 2"),
    ({"ir_version": 1, "jurisdiction": "ZZ", "rules": []}, "IR: ir_version must be 2"),
    ({"ir_version": 2.0, "jurisdiction": "ZZ", "rules": []}, "IR: ir_version must be 2"),
    ({"ir_version": True, "jurisdiction": "ZZ", "rules": []}, "IR: ir_version must be 2"),
    ({"ir_version": 2, "jurisdiction": "zz", "rules": []}, "IR: jurisdiction must be uppercase letters or digits"),
    ({"ir_version": 2, "jurisdiction": "", "rules": []}, "IR: jurisdiction must be a 1 to 8 character code"),
    ({"ir_version": 2, "jurisdiction": "ABCDEFGHI", "rules": []}, "IR: jurisdiction must be a 1 to 8 character code"),
    ({"ir_version": 2, "jurisdiction": "ÉÉÉÉÉ", "rules": []}, "IR: jurisdiction must be a 1 to 8 character code"),
    ({"ir_version": 2, "jurisdiction": "ZZ", "rules": {}}, "IR: rules must be a list"),
    ({"ir_version": 2, "jurisdiction": "ZZ", "rules": [], "skipped": {}}, "IR: skipped must be a list"),
    ({"ir_version": 2, "jurisdiction": "ZZ", "rules": [], "skipped": [{"reason": "x"}]}, "IR: a skipped entry has no id"),
    ({"ir_version": 2, "jurisdiction": "ZZ", "rules": [5]}, "rules[0] is not an object"),
    (law([rule("", "covered", expense="medical")]), "rules[0]: missing id"),
    (law([rule("T-1", "mystery")]), "T-1: unknown kind 'mystery'"),
    (law([rule("T-1", "skipped")]), "T-1: unknown kind 'skipped'"),
    (law([rule("T-1", "total_cap")]), "T-1: cap_cents is required"),
    (law([rule("T-1", "total_cap", cap_cents=-1)]), "T-1: cap_cents is out of range"),
    (law([rule("T-1", "total_cap", cap_cents=10**15 + 1)]), "T-1: cap_cents is out of range"),
    (law([rule("T-1", "total_cap", cap_cents=1.5)]), "T-1: cap_cents must be an integer"),
    (law([rule("T-1", "total_cap", cap_cents="5")]), "T-1: cap_cents must be an integer"),
    (law([rule("T-1", "total_cap", cap_cents=2**63)]), "T-1: cap_cents must be an integer"),
    (law([rule("T-1", "expense_cap", expense="medical", cap_cents=5, per="fortnight")]), "T-1: per must be claim or unit"),
    (law([rule("T-1", "expense_cap", expense="medical", cap_cents=5, per="unit")]), "T-1: a per-unit cap needs a unit"),
    (law([cap("T-1", "medical", 5, "fortnight")]), "T-1: unknown unit 'fortnight'"),
    (law([cap("T-1", "medical", 5, "session", count_limit=-1)]), "T-1: count_limit is out of range"),
    (law([cap("T-1", "medical", 5, alt_rule_ids="T-2")]), "T-1: alt_rule_ids must be a list"),
    (law([cap("T-1", "medical", 5, alt_rule_ids=[""])]), "T-1: alt_rule_ids must hold rule ids"),
    (law([cap("T-1", "medical", 5, alt_rule_ids=["T-404"])]), "T-1: alt rule T-404 is not in the IR"),
    (law([rule("T-1", "covered", expense="groceries")]), 'T-1: unknown expense "groceries"'),
    (law([rule("T-1", "covered", expense="unknown")]), 'T-1: unknown expense "unknown"'),
    (law([rule("T-1", "covered", expense=["medical", 5]),]), 'T-1: unknown expense ["medical",5]'),
    (law([rule("T-1", "covered")]), "T-1: expense is required"),
    (law([rule("T-1", "excluded")]), "T-1: an exclusion needs an expense or tags"),
    (law([rule("T-1", "excluded", tags=[])]), "T-1: an exclusion needs an expense or tags"),
    (law([rule("T-1", "excluded", tags="phone")]), "T-1: tags must be a list"),
    (law([rule("T-1", "excluded", tags=[""])]), "T-1: tags must be non-empty strings"),
    (law([rule("T-1", "excluded", tags=[f"t{i}" for i in range(32)])]), "more than 31 distinct tags"),
    (law([rule(f"T-{i}", "excluded", tags=[f"t{i}"]) for i in range(7)]), "more than 6 tagged exclusions apply to one expense"),
    (law([rule("T-1", "deadline")]), "T-1: days is required"),
    (law([rule("T-1", "deadline", days=1.5)]), "T-1: days must be an integer"),
    (law([rule("T-1", "deadline", days=4_000_001)]), "T-1: days is out of range"),
    (law([rule("T-1", "deadline", days=10, **{"from": "age_18"})]),
     "T-1: from must be crime, incident, discovery, injury, offense, or report"),
    (law([rule("T-1", "reporting", required="yes")]), "T-1: required must be true or false"),
    (law([rule("T-1", "reporting", alternatives="forensic_exam")]), "T-1: alternatives must be a list"),
    (law([rule("T-1", "minimum_loss", waiver="none")]), "T-1: a minimum loss rule needs cap_cents or days_lost"),
    (law([rule("T-1", "minimum_loss", cap_cents=5, waiver="sometimes")]), "T-1: unknown waiver 'sometimes'"),
    (law([rule("T-1", "minimum_loss", days_lost=-1)]), "T-1: days_lost is out of range"),
    (law([rule("T-1", "minimum_loss", cap_cents=5, waiver_for_sexual_assault="true")]),
     "T-1: waiver_for_sexual_assault must be true or false"),
    (law([rule("T-1", "covered", expense="medical"), rule("T-1", "covered", expense="dental")]), "IR: duplicate rule id T-1"),
    (law([rule("T-1", "covered", expense="medical")], skipped=[{"id": "T-1"}]), "IR: duplicate rule id T-1"),
    ({"ir_version": 2, "jurisdiction": "ZZ", "rules": [], "source_sha256": "abc"}, "IR: source_sha256 must be 64 hex characters"),
]
ACCEPTED = [
    law([]),
    law([cap("T-1", "medical", 5, count_limit=3)]),  # ignored on a per-claim cap, with a note
    law([rule("T-1", "reporting", alternatives=[5, "forensic_exam"])]),
    law([rule("T-1", "minimum_loss", days_lost=0, waiver=5)]),  # a non-string waiver reads as none
    law([rule("T-1", "info", category="collateral_source"), rule("T-2", "info", category="exam_payment")]),
    law([rule(f"T-{i}", "excluded", expense="medical", tags=[f"t{i}"]) for i in range(6)]
        + [rule("T-9", "excluded", expense="dental", tags=["x"])]),
    {"ir_version": 2, "jurisdiction": "Z9", "rules": [], "source_sha256": "A" * 64},
]


@pytest.mark.parametrize("doc,message", REFUSED)
def test_reference_refuses_like_tendc(doc, message):
    with pytest.raises(LawError) as e:
        law_from_bytes(json.dumps(doc, ensure_ascii=False).encode())
    assert str(e.value) == message


@pytest.mark.parametrize("doc", ACCEPTED)
def test_reference_accepts_like_tendc(doc):
    assert isinstance(law_from_bytes(json.dumps(doc).encode()), Law)


def test_count_limit_on_a_claim_cap_leaves_a_note():
    loaded = Law(law([cap("T-1", "medical", 5, count_limit=3)]))
    assert loaded.notes == ["T-1: count_limit on a per-claim cap has no units to count and is ignored"]
    assert loaded.claim_caps[0].count_limit is None


def test_info_spellings_of_collateral_and_exam_payment():
    loaded = Law(law([rule("T-1", "info", category="collateral_source"), rule("T-2", "info", category="exam_payment")]))
    assert loaded.collateral_ids == ["T-1"] and [r.id for r in loaded.exam_payment] == ["T-2"]


def test_the_verified_file_binds_the_ir():
    ir = (FIXTURES / "ir" / "ZZ.json").read_bytes()
    verified = (FIXTURES / "verified" / "ZZ.json").read_bytes()
    loaded = law_from_bytes(ir, verified)
    assert loaded.by_id["ZZ-EXAM-1"].quote.startswith("A health care provider shall not bill")
    assert loaded.by_id["ZZ-EXAM-1"].pinpoint
    with pytest.raises(LawError, match="^stale IR: source_sha256 does not match the verified file"):
        law_from_bytes(ir, verified + b" ")
    doc = json.loads(ir)
    doc["rules"].append(rule("ZZ-NOT-VERIFIED", "covered", expense="legal"))
    with pytest.raises(LawError, match="^ZZ-NOT-VERIFIED is in the IR but not in the verified file$"):
        law_from_bytes(json.dumps(doc).encode(), verified)
    doc = json.loads(ir)
    doc["jurisdiction"] = "ZY"
    with pytest.raises(LawError, match="^the IR and the verified file are for different jurisdictions$"):
        law_from_bytes(json.dumps(doc).encode(), verified)


def test_every_real_ir_file_loads_with_its_verified_file():
    paths = sorted((REPO / "rules" / "ir").glob("*.json"))
    if not paths:
        pytest.skip("no rules/ir")
    for path in paths:
        loaded = load_law(path)
        assert loaded.jurisdiction == path.stem
        assert all(r.quote for r in loaded.rules), path.stem


@pytest.mark.skipif(not TENDC.is_file(), reason="engine/build/tendc is not built")
@pytest.mark.parametrize("doc,message", REFUSED + [(d, "") for d in ACCEPTED])
def test_tendc_agrees(doc, message, tmp_path):
    path = tmp_path / "law.json"
    path.write_text(json.dumps(doc, ensure_ascii=False))
    proc = subprocess.run([str(TENDC), "--quiet", "--no-verified", str(path), "-o", str(tmp_path / "law.tlaw")],
                          capture_output=True, text=True)
    if message:
        assert proc.returncode != 0
        assert proc.stderr.strip() == f"tendc: {path}: {message}"
    else:
        assert proc.returncode == 0, proc.stderr
