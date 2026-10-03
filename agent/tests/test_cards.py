from __future__ import annotations

import json

from fake_api import load
from uagents_core.contrib.protocols.chat.cards import create_card_content, extract_card, validate_card_payload

from tend_agent import cards
from tend_agent.demo import bill_summary, demo_state, groups, payment_view

SCAN, AUDIT = load("scan_rowan_mi.json"), load("audit_rowan_mi.json")


def roundtrip(payload):
    content = create_card_content(payload)
    meta = content.metadata
    assert meta["card_protocol_version"] == "1" and meta["requires_card_interaction"] == "true"
    assert len(meta["card_payload"].encode()) <= 64 * 1024
    assert validate_card_payload(meta["card_kind"], json.loads(meta["card_payload"]))
    card = extract_card(content)
    assert card is not None
    return meta["card_kind"], json.loads(meta["card_payload"])


def test_welcome_card():
    kind, data = roundtrip(cards.welcome_card())
    assert kind == "detail" and [c["selection"]["action"] for c in data["ctas"]] == ["check_form", "demo"]


def test_check_form_has_every_state_and_puts_the_named_one_first():
    kind, data = roundtrip(cards.check_form("OH"))
    assert kind == "form"
    states = data["fields"][0]["options"]
    assert len(states) == 51 and states[0]["value"] == "OH"
    names = [f["name"] for f in data["fields"]]
    assert names == ["st", "incident_date", "forensic_exam", "police_report"]
    assert "what happened" not in json.dumps(data).lower()


def test_count_costs_card():
    kind, data = roundtrip(cards.count_costs_card(groups(SCAN), bill_summary(AUDIT), scan_id=SCAN["scan_id"]))
    assert kind == "review"
    assert data["approve_cta"]["selection"] == {"action": "count_costs", "scan_id": SCAN["scan_id"]}
    assert any("Fictional" in r["value"] for r in data["summary_rows"])


def test_payment_card_shows_the_code_but_no_button_carries_it():
    demo = demo_state(SCAN, AUDIT, "rowan-mi")
    proposal = {
        "action_id": "act_1",
        "amount_cents": 11800,
        "confirm_code": "482913",
        "payee": "Riverbend General Hospital",
        "item_ids": demo["pay_item_ids"],
        "dry_run": True,
    }
    kind, data = roundtrip(cards.payment_card(payment_view(proposal, demo)))
    assert kind == "review"
    rows = {r["label"]: r["value"] for r in data["summary_rows"]}
    assert rows["Amount"] == "$118.00" and rows["Confirm code"] == "482913" and rows["Not paid"].startswith("Forensic exam line, $325.00")
    assert "482913" not in json.dumps(data["approve_cta"]) and "482913" not in json.dumps(data["reject_cta"])


def test_code_form_is_empty_for_the_person_to_fill():
    kind, data = roundtrip(cards.code_form("act_1", 11800))
    assert kind == "form" and data["fields"][0]["name"] == "code"
    assert data["submit_cta"]["selection"] == {"action": "pay_confirm", "action_id": "act_1"}
