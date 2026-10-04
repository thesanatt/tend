"""rules/tools/normalize.py on the real corpus: what docs/SPEC.md v1.3 changed in the law IR, and why.

rules/ir must be exactly what normalize.py makes from rules/verified, so a change to either one is
caught here. Skips when the corpus is absent.
"""

import importlib.util
import json

import pytest

from claims import REPO, claim, item
from tend_ref import evaluate, load_law

VERIFIED = REPO / "rules" / "verified"
IR = REPO / "rules" / "ir"
HAVE_CORPUS = VERIFIED.is_dir() and IR.is_dir() and any(VERIFIED.glob("*.json"))
STATES = sorted(p.stem for p in VERIFIED.glob("*.json")) if HAVE_CORPUS else []
pytestmark = pytest.mark.skipif(not HAVE_CORPUS, reason="no rules corpus at the repo root")


def load_normalize(root=None):
    spec = importlib.util.spec_from_file_location("normalize_under_test", REPO / "rules" / "tools" / "normalize.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if root is not None:
        module.ROOT = root
    return module


N = load_normalize()


def verified(st: str) -> dict:
    return json.loads((VERIFIED / f"{st}.json").read_text(encoding="utf-8"))


def verified_rule(rule_id: str) -> dict:
    return next(r for r in verified(rule_id.split("-")[0])["rules"] if r["id"] == rule_id)


def ir_rule(rule_id: str) -> dict:
    doc = json.loads((IR / f"{rule_id.split('-')[0]}.json").read_text(encoding="utf-8"))
    for r in doc["rules"]:
        if r["id"] == rule_id:
            return r
    return {**next(r for r in doc["skipped"] if r["id"] == rule_id), "kind": "skipped"}


def run(st: str, *items: dict, **context) -> dict:
    return evaluate(load_law(IR / f"{st}.json"), claim(*items, jurisdiction=st, **context))


@pytest.mark.parametrize("st", STATES)
def test_ir_on_disk_is_what_normalize_makes(st):
    assert json.loads((IR / f"{st}.json").read_text(encoding="utf-8")) == N.normalize(st)


def test_every_reviewed_rule_is_in_the_corpus():
    ids = {r["id"] for st in STATES for r in verified(st)["rules"]}
    for table in (N.DISCOVERY_ALTERNATIVES, N.DISCOVERY_ELSEWHERE, N.NOT_PROGRAM_CAPS):
        assert set(table) <= ids


# 1. Deadlines counted from discovery.

# The rules the researchers dated from discovery, and the words in each quote that say so.
FROM_DISCOVERY = {
    "AZ-DEAD-1": "within two years after discovery of the criminally injurious conduct",
    "MA-DEAD-3": "the filing period shall not commence until the claimant discovered, or reasonably should have discovered",
    "MD-DEADLINE-1": "within 4 years after the later of: (i) the discovery of the occurrence of the crime",
    "ME-DEAD-2": "within 60 days of the discovery of injury or compensable loss",
    "NJ-FILE-3": "within five years after reasonable discovery of the injury",
    "PA-DEADLINE-1": "not later than five years after the discovery of the occurrence of the crime",
}
DISCOVERY_STATES = sorted({rid.split("-")[0] for rid in [*FROM_DISCOVERY, *N.DISCOVERY_ALTERNATIVES]})


def test_discovery_anchors_are_confirmed_by_their_quotes():
    for rid, words in FROM_DISCOVERY.items():
        r = verified_rule(rid)
        assert r["params"]["from"] == "discovery" and words in r["quote"], rid
        assert ir_rule(rid)["from"] == "discovery", rid
    # Rules dated from the crime whose quote also lets the period start at discovery: the IR moves the anchor.
    for rid, words in N.DISCOVERY_ALTERNATIVES.items():
        r = verified_rule(rid)
        assert r["category"] == "filing_deadline" and (r["params"].get("from") or "crime") == "crime", rid
        assert words in r["quote"], rid
        assert ir_rule(rid)["kind"] == "deadline" and ir_rule(rid)["from"] == "discovery", rid


def test_every_deadline_quote_that_mentions_discovery_was_reviewed():
    anchored = set()
    for st in STATES:
        for r in verified(st)["rules"]:
            if r["category"] != "filing_deadline":
                continue
            rule = ir_rule(r["id"])
            if rule["kind"] == "deadline" and rule["from"] == "discovery":
                anchored.add(r["id"])
            elif "discover" in r["quote"].lower():
                # No period to date (WA-DEADLINE-3), or the quote's discovery period is another rule's.
                assert rule["kind"] == "info" or r["id"] in N.DISCOVERY_ELSEWHERE, r["id"]
    assert anchored == set(FROM_DISCOVERY) | set(N.DISCOVERY_ALTERNATIVES)
    assert len(DISCOVERY_STATES) == 12


@pytest.mark.parametrize("st", STATES)
def test_a_deadline_that_can_count_from_discovery_is_never_plainly_late(st):
    d = run(st, as_of="2099-01-01")["checks"]["deadline"]
    assert ("deadline_from_discovery" in d["flags"]) == (st in DISCOVERY_STATES)
    if st in DISCOVERY_STATES:
        assert d["status"] == "late"  # dated from the incident, so late here, but flagged: discovery can come later


def test_rowans_michigan_deadline_is_unchanged():
    d = run("MI", police_report="no")["checks"]["deadline"]
    assert d == {"status": "ok", "deadline_date": "2031-06-14", "rule_ids": ["MI-FILE-1", "MI-FILE-2"],
                 "flags": ["deadline_from_report"]}


# 2. Caps whose quote is not the program's limit on the survivor's cost.

def test_nevada_expedited_wage_approval_is_not_a_cap():
    assert ir_rule("NV-CAP-WAGE-3") == {"id": "NV-CAP-WAGE-3", "kind": "info", "category": "expense_cap"}
    # Fifteen working days off at $100 a day: before, the $70 a day for 10 days cut this to $700.
    out = run("NV", item("w", "lost_wages", 150_000, units=15, unit="day"))
    line = out["lines"][0]
    assert (line["status"], line["allowed_cents"], line["cap_rule_id"]) == ("eligible", 150_000, None)
    assert line["flags"] == ["rate_unverified:NV-CAP-WAGE-1"]  # the weekly rate counts weeks, not days
    assert "NV-CAP-WAGE-3" in out["info_rule_ids"]
    # The program's own limits still apply: $350 a week.
    line = run("NV", item("w", "lost_wages", 150_000, units=3, unit="week"))["lines"][0]
    assert (line["allowed_cents"], line["cap_rule_id"]) == (105_000, "NV-CAP-WAGE-1")


def test_texas_emergency_medical_care_payment_is_not_a_medical_cap():
    assert ir_rule("TX-EXAM-3") == {"id": "TX-EXAM-3", "kind": "info", "category": "expense_cap"}
    line = run("TX", item("m", "medical", 3_000_000))["lines"][0]
    assert (line["allowed_cents"], line["cap_rule_id"]) == (3_000_000, None)  # was cut to $25,000
    line = run("TX", item("m", "medical", 6_000_000))["lines"][0]
    assert (line["allowed_cents"], line["cap_rule_id"]) == (5_000_000, "TX-CAP-1")


def test_alaska_initial_counseling_award_keeps_the_rate_not_the_count():
    rule = ir_rule("AK-COUNSEL-1")
    assert (rule["cap_cents"], rule["unit"], "count_limit" in rule) == (20_000, "session", False)
    line = run("AK", item("c", "counseling", 30 * 25_000, units=30, unit="session"))["lines"][0]
    assert (line["allowed_cents"], line["cap_rule_id"]) == (30 * 20_000, "AK-COUNSEL-1")  # was 24 sessions


@pytest.mark.parametrize("rid", ["MT-CAP-2", "WY-CAP-3"])
def test_caps_for_secondary_or_associated_victims_are_set_aside(rid):
    rule = ir_rule(rid)
    assert rule["kind"] == "skipped" and rule["reason"].startswith("applies_to"), rule
    st = rid.split("-")[0]
    line = run(st, item("c", "counseling", 600_000))["lines"][0]
    assert line["status"] == "eligible" and line["cap_rule_id"] != rid


def test_applies_to_reads_who_a_rule_is_for():
    other = N.applies_to_someone_else
    assert other({}) is None
    assert other({"applies_to": "victims who were employable but not employed"}) is None
    assert other({"applies_to": "domestic violence victims in imminent danger"}) is None
    for who in ("secondary_victims", "associated_victims", "derivative victims", "family members of the victim",
                "each parent of a victim under 18"):
        assert other({"applies_to": who}) is not None, who


@pytest.mark.parametrize("rid,quote", [
    ("NV-CAP-WAGE-3", "Lost wages are paid at $70 a day for up to 10 days."),
    ("NY-DEADLINE-1", "A claim must be filed within three years of the crime."),
])
def test_normalize_stops_when_a_reviewed_quote_changes(tmp_path, rid, quote):
    st = rid.split("-")[0]
    doc = verified(st)
    next(r for r in doc["rules"] if r["id"] == rid)["quote"] = quote
    (tmp_path / "rules" / "verified").mkdir(parents=True)
    (tmp_path / "rules" / "verified" / f"{st}.json").write_text(json.dumps(doc), encoding="utf-8")
    with pytest.raises(ValueError, match=f"{rid}: the quote no longer says"):
        load_normalize(tmp_path).normalize(st)
