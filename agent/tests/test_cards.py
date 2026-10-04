"""Every card the agent sends is a valid ASI:One Interactive Card: checked against the schemas in uagents_core,
through the same MetadataContent the agent puts on the wire."""

from __future__ import annotations

import json
import uuid

from fake_api import load
from uagents_core.contrib.protocols.chat.cards import (
    create_card_response_content,
    extract_card,
    extract_card_response,
    validate_card_payload,
)

from tend_agent import cards
from tend_agent.chat import card_content, card_response
from tend_agent.demo import bill_summary, demo_ref, groups, payment_view

SCAN, AUDIT = load("scan_rowan_mi.json"), load("audit_rowan_mi.json")


def roundtrip(card: cards.Card):
    card_id = str(uuid.uuid4())
    content = card_content(card, card_id)
    meta = content.metadata
    assert meta["card_protocol_version"] == "1" and meta["requires_card_interaction"] == "true"
    assert len(meta["card_payload"].encode()) <= 64 * 1024
    assert validate_card_payload(meta["card_kind"], json.loads(meta["card_payload"]))
    parsed = extract_card(content)
    assert parsed is not None and str(parsed.card_id) == card_id
    return meta["card_kind"], json.loads(meta["card_payload"])


def test_welcome_card():
    kind, data = roundtrip(cards.welcome_card())
    assert kind == "detail" and [c["selection"]["action"] for c in data["ctas"]] == ["check_form", "demo"]
    assert "never ask" in json.dumps(data)


def test_check_form_has_every_state_and_puts_the_named_one_first():
    kind, data = roundtrip(cards.check_form("OH"))
    assert kind == "form"
    states = data["fields"][0]["options"]
    assert len(states) == 51 and states[0]["value"] == "OH"
    assert [f["name"] for f in data["fields"]] == ["st", "incident_date", "forensic_exam", "police_report"]
    assert "name" not in [f["label"].lower() for f in data["fields"]] and "what happened" not in json.dumps(data).lower()


def test_count_costs_card():
    kind, data = roundtrip(cards.count_costs_card(groups(SCAN), bill_summary(AUDIT), scan_id=SCAN["scan_id"]))
    assert kind == "review"
    assert data["approve_cta"]["selection"] == {"action": "count_costs", "scan_id": SCAN["scan_id"]}
    rows = {r["label"]: r["value"] for r in data["summary_rows"]}
    assert rows["Hospital bill (itemized)"] == "3 lines, $443.00" and "Fictional" in rows["Data"]


def test_next_steps_card():
    kind, data = roundtrip(cards.next_steps_card(11800, paid=False))
    assert kind == "detail" and [c["selection"]["action"] for c in data["ctas"]] == ["pay", "share"]
    assert data["ctas"][0]["label"] == "Pay the $118.00 left on the bill"
    _, paid = roundtrip(cards.next_steps_card(0, paid=True))
    assert [c["selection"]["action"] for c in paid["ctas"]] == ["share"] and paid["ctas"][0]["primary"] is True


def test_payment_card_shows_the_code_but_no_button_carries_it():
    demo = demo_ref(SCAN, AUDIT, "rowan-mi")
    proposal = {
        "action_id": "act_1",
        "amount_cents": 11800,
        "confirm_code": "482913",
        "payee": "Riverbend General Hospital",
        "dry_run": True,
    }
    kind, data = roundtrip(cards.payment_card(payment_view(proposal, demo)))
    assert kind == "review"
    rows = {r["label"]: r["value"] for r in data["summary_rows"]}
    assert rows["Amount"] == "$118.00" and rows["Confirm code"] == "482913" and rows["Not paid"].startswith("Forensic exam line, $325.00")
    assert rows["Pay to"] == "Riverbend General Hospital (fictional)" and rows["From"] == "Checking ending 0011 (Nessie mock bank)"
    assert "482913" not in json.dumps(data["approve_cta"]) and "482913" not in json.dumps(data["reject_cta"])


def test_code_form_is_empty_for_the_person_to_fill():
    kind, data = roundtrip(cards.code_form("act_1", 11800))
    assert kind == "form" and data["fields"][0]["name"] == "code" and "value" not in data["fields"][0]
    assert data["submit_cta"]["selection"] == {"action": "pay_confirm", "action_id": "act_1"}


def test_share_card():
    kind, data = roundtrip(cards.share_card("October 6, 2026", 14))
    rows = {r["label"]: r["value"] for r in data["summary_rows"]}
    assert kind == "detail" and rows["Still needed"] == "14 documents" and "cannot read" in rows["Tend's server"]


def test_card_responses_are_read_like_uagents_core_writes_them():
    card_id = uuid.uuid4()
    click = create_card_response_content(card_id=card_id, selection={"action": "pay_confirm", "code": "482913"})
    assert extract_card_response(click) is not None
    assert card_response(dict(click.metadata)) == {
        "selection": {"action": "pay_confirm", "code": "482913"},
        "cancelled": False,
        "text": None,
        "card_id": str(card_id),
    }
    dismissed = card_response(dict(create_card_response_content(cancelled=True).metadata))
    assert dismissed["cancelled"] is True and dismissed["selection"] is None
    assert card_response({"card_protocol_version": "1", "card_kind": "detail", "card_payload": "{}"}) is None  # a card, not a click
    assert card_response({"mime_type": "text/plain"}) is None
