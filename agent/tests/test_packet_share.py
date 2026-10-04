"""The packet's words (still needed, where to file, the billing letter) and the sealed share format."""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import pytest
from fake_api import load

from tend_agent.demo import confirmed_input, held_lines
from tend_agent.knowledge import RuleBook
from tend_agent.letter import billing_letter
from tend_agent.packet import doc_scope, filing_routes, still_needed
from tend_agent.share import (
    AAD,
    ShareFormatError,
    aes_gcm_decrypt,
    check_packet,
    from_b64url,
    open_sealed,
    seal,
    share_link,
)

RULES = Path(__file__).resolve().parents[2] / "rules" / "verified"
MI = RuleBook(load("MI.json"))
SCAN, AUDIT, CLAIM = load("scan_rowan_mi.json"), load("audit_rowan_mi.json"), load("claim_rowan_mi.json")
INPUT = confirmed_input(SCAN, AUDIT, keep_text=True)


def ids(engine_input, output):
    return [i["rule_id"] for i in still_needed(MI, engine_input, output)]


# ---------------------------------------------------------------- still needed and where to file (web/lib/packet parity)


def test_still_needed_fits_the_costs_claimed():
    found = ids(INPUT, CLAIM)
    assert {"MI-DOC-5", "MI-DOC-10", "MI-DOC-11", "MI-DOC-21"} <= set(found)
    for absent in ("MI-DOC-26", "MI-DOC-28", "MI-DOC-3", "MI-DOC-4", "MI-DOC-1"):
        assert absent not in found, absent


def test_scopes_match_the_app():
    rule = {r["id"]: r for r in MI.rules}
    assert doc_scope(rule["MI-DOC-28"]) == {"kind": "skip", "why": "for a claim after a death"}
    assert doc_scope(rule["MI-DOC-3"])["kind"] == "late"
    assert doc_scope(rule["MI-DOC-13"]) == {"kind": "expenses", "expenses": ["lost_wages"]}
    assert doc_scope(rule["MI-DOC-2"])["kind"] == "always"  # a Social Security number is not home security


def test_late_reported_and_no_wages_change_the_list():
    late = copy.deepcopy(CLAIM)
    late["checks"]["deadline"]["status"] = "late"
    assert "MI-DOC-3" in ids(INPUT, late)
    reported = {**INPUT, "context": {**INPUT["context"], "police_report": "yes"}}
    assert "MI-DOC-1" in ids(reported, CLAIM)
    no_wages = {**CLAIM, "lines": [ln for ln in CLAIM["lines"] if ln["expense"] != "lost_wages"]}
    assert "MI-DOC-11" not in ids(INPUT, no_wages)


def test_itemized_bills_in_hand_only_when_every_cost_came_from_a_read_bill():
    medical = {**CLAIM, "lines": [ln for ln in CLAIM["lines"] if ln["expense"] == "medical"]}
    assert next(i for i in still_needed(MI, INPUT, medical) if i["rule_id"] == "MI-DOC-5")["have_it"] is True
    assert next(i for i in still_needed(MI, INPUT, CLAIM) if i["rule_id"] == "MI-DOC-5")["have_it"] is False


def test_still_needed_and_filing_match_the_app_in_every_jurisdiction():
    """web_packet_parity.json is the app's own output (scripts/web_parity.mts) for this claim in all 51."""
    expected = load("web_packet_parity.json")
    checked = 0
    for st, want in expected.items():
        raw = (RULES / f"{st}.json").read_bytes()
        if hashlib.sha256(raw).hexdigest() != want["rules_sha256"]:
            continue  # the rules changed since the snapshot; rerun scripts/web_parity.mts
        book = RuleBook(json.loads(raw))
        mine = still_needed(book, {**INPUT, "jurisdiction": st}, {**CLAIM, "jurisdiction": st})
        assert [[i["rule_id"], i["have_it"], i["document"]] for i in mine] == want["needed"], st
        assert [[r["method"], r["rule"]["id"]] for r in filing_routes(book)] == want["filing"], st
        checked += 1
    assert checked >= 45  # nearly all of the 51; a few may be mid-update on main


def test_filing_routes_in_the_apps_order():
    routes = filing_routes(MI)
    assert [r["method"] for r in routes] == ["email", "mail", "fax"]
    assert routes[0]["target"] == "MDHHS-MichiganCrimeVictim@Michigan.gov"


# ---------------------------------------------------------------- the billing letter


def test_the_letter_quotes_the_law_and_leaves_names_blank():
    letter = billing_letter(MI, held_lines(AUDIT))
    assert "    Medical forensic exam, deductible applied, June 14, 2026: $325.00" in letter
    assert 'Michigan law says I should not be billed for this exam:\n\n"A health care provider shall not submit a bill' in letter
    assert "(MCL 18.355a(2))" in letter and "The law names who pays for the exam instead" in letter and "(MCL 18.355a(7))" in letter
    assert "[Your name]" in letter and "[account number]" in letter and "Rowan" not in letter
    assert not any(ch in letter for ch in "—–’“”")


def test_no_exam_rules_means_no_letter():
    assert billing_letter(RuleBook({"jurisdiction": "ZZ", "name": "Testland", "rules": []}), held_lines(AUDIT)) == ""


# ---------------------------------------------------------------- the sealed share


def packet(**over):
    return {"st": "MI", "created_at": "2026-10-03T20:00:00Z", "input": INPUT, "output": CLAIM, "notes": "Fictional demo claim.", **over}


def test_seal_matches_the_web_format():
    ciphertext, iv, key = seal(packet(), rand=lambda n: bytes(range(n)))
    assert len(from_b64url(key)) == 32 and len(from_b64url(iv)) == 12 and "=" not in ciphertext + iv + key
    plain = json.loads(aes_gcm_decrypt(from_b64url(key), from_b64url(iv), from_b64url(ciphertext), AAD))
    assert plain["format"] == "tend.share/1" and plain["packet"]["st"] == "MI"
    assert open_sealed(ciphertext, iv, key)["output"]["totals"]["allowed_cents"] == 400800


def test_wrong_key_or_changed_ciphertext_does_not_open():
    ciphertext, iv, key = seal(packet())
    other = seal(packet())[2]
    with pytest.raises(ShareFormatError):
        open_sealed(ciphertext, iv, other)
    flipped = ciphertext[:-2] + ("A" if ciphertext[-2] != "A" else "B") + ciphertext[-1]
    with pytest.raises(ShareFormatError):
        open_sealed(flipped, iv, key)


@pytest.mark.parametrize(
    "change",
    [
        {"st": "Michigan"},
        {"notes": None},  # the viewer refuses null where it expects a missing key
        {"input": {**INPUT, "jurisdiction": "OH"}},
        {"input": {**INPUT, "context": {**INPUT["context"], "police_report": "not_yet"}}},
        {"output": {**CLAIM, "totals": {**CLAIM["totals"], "held_cents": 1.5}}},
        {"output": {**CLAIM, "lines": [{**CLAIM["lines"][0], "item_id": "not-an-item"}]}},
    ],
)
def test_packets_the_viewer_would_refuse_are_never_sealed(change):
    with pytest.raises(ShareFormatError):
        seal(packet(**change))


def test_the_input_without_text_still_passes_and_descriptions_never_are_null():
    check_packet(packet(input=confirmed_input(SCAN, AUDIT)))
    assert all("description" not in i or isinstance(i["description"], str) for i in INPUT["items"])


def test_share_link_shape():
    key = "k" * 43
    assert share_link("https://youreowed.tech/", "abcDEF12_-", key) == f"https://youreowed.tech/share#abcDEF12_-.{key}"
    with pytest.raises(ShareFormatError):
        share_link("https://youreowed.tech", "bad id!", key)
