from __future__ import annotations

import json
import re

import pytest
from helpers import confirm_all, scan_rowan

PAY = {"from": "acct-checking-0001", "payee": "Riverbend General Hospital (fictional)", "amount_cents": 11800}


def claim_with_bill(client) -> str:
    scan = scan_rowan(client)
    audit = client.post("/api/bill/audit", json={"st": "MI", "persona_id": "rowan-mi", "scan_id": scan["scan_id"]}).json()
    items = [i for i in scan["engine_input"]["items"] if not i["is_bill"]] + audit["engine_items"]
    body = confirm_all({**scan["engine_input"], "items": items})
    return client.post("/api/claim", params={"scan_id": scan["scan_id"]}, json=body).json()["claim_id"]


@pytest.fixture
def session(client):
    claim_id = claim_with_bill(client)
    link = client.post("/api/agent/link", json={"claim_id": claim_id}).json()
    redeemed = client.post("/api/agent/redeem", json={"link_code": link["link_code"]}).json()
    return {"claim_id": claim_id, "headers": {"Authorization": f"Bearer {redeemed['agent_token']}"}, **redeemed}


def test_public_checklist_is_cited_and_computes_the_deadline(client):
    data = client.get("/api/agent/checklist/mi", params={"incident_date": "2026-06-14"}).json()
    assert data["engine"] == "reference"
    assert data["deadline"]["status"] == "ok" and data["deadline"]["deadline_date"] == "2031-06-14"
    assert {c["rule_id"] for c in data["deadline"]["citations"]} >= {"MI-FILE-1"}
    protection = {c["rule_id"]: c for c in data["exam_billing"]["protection"]}
    assert protection["MI-EXAM-1"]["pinpoint"] == "MCL 18.355a(2)" and "#:~:text=" in protection["MI-EXAM-1"]["fragment_url"]
    assert "counseling" in {c["expense"] for c in data["covered"]}
    assert "MI-EXCL-1" in {c["rule_id"] for c in data["not_covered"]}
    assert data["program"]["phone"] == "877-251-7373"


def test_checklist_without_a_date_lists_the_deadline_rules(client):
    data = client.get("/api/agent/checklist/MI").json()
    assert data["deadline"]["status"] == "unknown" and data["engine"] is None
    assert {c["rule_id"] for c in data["deadline"]["citations"]} >= {"MI-FILE-1", "MI-FILE-2"}
    assert client.get("/api/agent/checklist/ZZ").status_code == 404


def test_link_code_is_one_time_and_forgiving_to_type(client):
    claim_id = claim_with_bill(client)
    link = client.post("/api/agent/link", json={"claim_id": claim_id}).json()
    assert re.fullmatch(r"[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}", link["link_code"])
    assert link["say_to_agent"] == f"link {link['link_code']}"
    typed = link["link_code"].replace("-", " ").lower()
    first = client.post("/api/agent/redeem", json={"link_code": typed})
    assert first.status_code == 200 and first.json()["claim_id"] == claim_id
    assert client.post("/api/agent/redeem", json={"link_code": link["link_code"]}).status_code == 404
    assert client.post("/api/agent/link", json={"claim_id": "clm_missing"}).status_code == 404


def test_link_code_expires(client, clock):
    link = client.post("/api/agent/link", json={"claim_id": claim_with_bill(client)}).json()
    clock.advance(minutes=30)
    assert client.post("/api/agent/redeem", json={"link_code": link["link_code"]}).status_code == 404


def test_summary_needs_a_valid_session(client, session, clock):
    assert client.get("/api/agent/claim").status_code == 401
    assert client.get("/api/agent/claim", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/api/agent/claim", headers=session["headers"]).status_code == 200
    clock.advance(hours=2)
    assert client.get("/api/agent/claim", headers=session["headers"]).status_code == 401


def test_summary_has_totals_and_rules_but_no_bill_text(client, session):
    summary = client.get("/api/agent/claim", headers=session["headers"]).json()
    assert summary["claim_id"] == session["claim_id"]
    assert summary["held_cents"] == 32500
    assert summary["held"][0]["message"] == "Hold this line. Ask billing to remove it first."
    assert "MI-EXAM-1" in {r["rule_id"] for r in summary["held"][0]["rules"]}
    expenses = {e["expense"]: e for e in summary["by_expense"]}
    assert expenses["counseling"]["lines"] == 2 and expenses["counseling"]["rules"]
    assert summary["amount_you_can_ask_for_cents"] == sum(e["allowed_cents"] for e in summary["by_expense"])
    text = json.dumps(summary)
    for private in ("description", "forensic exam, deductible", "Northside", "Rowan"):
        assert private not in text


def test_redeem_returns_a_packet_link(client, session):
    pdf = client.get(session["packet_path"])
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")


def test_agent_pays_only_after_the_typed_amount(client, session):
    proposed = client.post("/api/agent/pay", headers=session["headers"], json=PAY).json()
    assert proposed["confirm_phrase"] == "confirm 118.00"
    assert '"confirm 118.00"' in proposed["ask_user"]
    base = {"action_id": proposed["action_id"], "confirm_code": proposed["confirm_code"]}

    for typed in ("yes", "confirm", "confirm 117.00", "confirm 118.5", "please confirm 118.00"):
        r = client.post("/api/agent/confirm", headers=session["headers"], json={**base, "typed": typed})
        assert r.status_code == 409, typed
        assert "confirm 118.00" in r.json()["detail"]

    done = client.post("/api/agent/confirm", headers=session["headers"], json={**base, "typed": "Confirm $118"})
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "done"
    again = client.post("/api/agent/confirm", headers=session["headers"], json={**base, "typed": "confirm 118.00"})
    assert again.status_code == 409


def test_agent_payment_cannot_skip_the_typed_approval(client, session):
    proposed = client.post("/api/agent/pay", headers=session["headers"], json=PAY).json()
    r = client.post("/api/actions/confirm", json={"action_id": proposed["action_id"], "confirm_code": proposed["confirm_code"]})
    assert r.status_code == 409
    assert "agent" in r.json()["detail"]


def test_agent_cannot_confirm_app_payments_or_other_claims(client, session):
    app_action = client.post("/api/actions/propose", json=PAY).json()
    r = client.post(
        "/api/agent/confirm",
        headers=session["headers"],
        json={"action_id": app_action["action_id"], "confirm_code": app_action["confirm_code"], "typed": "confirm 118.00"},
    )
    assert r.status_code == 404


def test_agent_pays_only_from_the_persona_accounts(client, session):
    r = client.post("/api/agent/pay", headers=session["headers"], json={**PAY, "from": "acct-someone-else"})
    assert r.status_code == 403


def test_agent_cannot_pay_a_held_line(client, session):
    summary = client.get("/api/agent/claim", headers=session["headers"]).json()
    held = summary["held"][0]
    r = client.post(
        "/api/agent/pay", headers=session["headers"], json={**PAY, "amount_cents": held["amount_cents"], "item_id": held["item_id"]}
    )
    assert r.status_code == 409
