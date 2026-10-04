"""What the Fetch.ai agents (agent/: the Navigator, Law, and Bank+Packet agents) send and read, replayed
against this API.

The request shapes are copied from agent/tend_agent/api.py, demo.py, and bank.py: the Law agent posts
/agent/answer and /agent/check, the Bank+Packet agent sends scan_id back with a bill audit, pays with the
typed code, reads a payment's status, and stores a packet it sealed itself. A failure means the agents
break when this API ships.
"""

from __future__ import annotations

import base64
import os

from helpers import CHECKING, from_b64url

# demo.ENGINE_FIELDS: the engine fields the agent sends to /claim (no description, no merchant text).
AGENT_ITEM_FIELDS = ("item_id", "date", "amount_cents", "expense", "confirmed", "insurance_paid_cents", "is_bill", "units", "unit", "tags")


def body_fields(doc: dict, path: str) -> set[str]:
    schema = doc["paths"][path]["post"]["requestBody"]["content"]["application/json"]["schema"]
    name = schema["$ref"].rsplit("/", 1)[-1]
    return set(doc["components"]["schemas"][name]["properties"])


def test_the_agent_finds_answer_and_check_through_openapi(client):
    doc = client.get("/api/openapi.json").json()
    assert {"question", "st"} <= body_fields(doc, "/api/agent/answer")
    assert {"st", "incident_date", "forensic_exam", "police_report"} <= body_fields(doc, "/api/agent/check")


def test_answer_and_check_carry_what_the_agent_quotes(client):
    answer = client.post("/api/agent/answer", json={"question": "Can the hospital in Michigan bill me for the exam?", "st": "MI"}).json()
    assert answer["answered"] is True and isinstance(answer["answer"], str)
    assert answer["citations"] and all(c["quote"] and c["pinpoint"] and c["fragment_url"] for c in answer["citations"])

    check = client.post("/api/agent/check", json={"st": "MI", "incident_date": "2026-06-14", "forensic_exam": True, "police_report": "no"})
    data = check.json()
    assert data["deadline"]["status"] == "ok" and data["deadline"]["deadline_date"] and data["deadline"]["citations"]
    assert isinstance(data["deadline"]["flags"], list)
    assert data["reporting"]["status"] == "satisfied" and data["reporting"]["citations"]
    assert data["exam_billing"]["protection"][0]["quote"]


def test_the_agents_demo_scan_audit_claim_and_payment(client):
    scan = client.post("/api/scan", json={"persona_id": "rowan-mi", "st": "MI"}).json()
    # demo.demo_state and navigator._start_demo read these.
    assert scan["scan_id"] and scan["account"]["id"] == CHECKING and scan["display_name"] and scan["read_count"]
    bill_id = next(d["bill_id"] for d in scan["documents"] if d.get("bill_id"))

    audit = client.post("/api/bill/audit", json={"bill_id": bill_id, "persona_id": "rowan-mi", "scan_id": scan["scan_id"]})
    assert audit.status_code == 200, audit.text
    audit = audit.json()
    holds = {h["item_id"] for h in audit["holds"]}
    assert holds and audit["payable_cents"] == sum(ln["amount_cents"] for ln in audit["lines"] if ln["item_id"] not in holds)

    # demo.confirmed_input
    items = [dict(i, confirmed=True) for i in scan["engine_input"]["items"] if not i.get("is_bill")]
    items += [dict(i, confirmed=True) for i in audit["engine_items"]]
    body = {**scan["engine_input"], "items": [{k: i[k] for k in AGENT_ITEM_FIELDS if k in i} for i in items]}
    claim = client.post("/api/claim", params={"scan_id": scan["scan_id"]}, json=body)
    assert claim.status_code == 200, claim.text
    lines = claim.json()["lines"]
    assert {ln["item_id"] for ln in lines if ln["status"] == "held"} == holds

    # demo.payment_body
    pay = {
        "kind": "pay_bill",
        "bill_id": audit["bill_id"],
        "item_ids": [ln["item_id"] for ln in audit["lines"] if ln["item_id"] not in holds],
        "amount_cents": audit["payable_cents"],
        "from_account_id": scan["account"]["id"],
        "payee": audit["provider"],
    }
    proposal = client.post("/api/actions/propose", json=pay)
    assert proposal.status_code == 200, proposal.text
    p = proposal.json()
    assert {"action_id", "amount_cents", "confirm_code", "expires_at", "dry_run", "item_ids", "payee"} <= set(p)

    wrong = client.post(
        "/api/actions/confirm", json={"action_id": p["action_id"], "confirm_code": "000000" if p["confirm_code"] != "000000" else "111111"}
    )
    assert wrong.status_code == 403  # navigator._confirm: "That code does not match. Nothing moved."
    done = client.post("/api/actions/confirm", json={"action_id": p["action_id"], "confirm_code": p["confirm_code"]})
    assert done.status_code == 200, done.text
    result = done.json()
    assert result["message"].startswith("Paid $") and result["nessie_id"] and result["read_back_matches"] is True
    assert result["audit_id"].startswith("aud_")
    again = client.post("/api/actions/confirm", json={"action_id": p["action_id"], "confirm_code": p["confirm_code"]})
    assert again.status_code == 409  # a terminal status the agent clears its pending payment on
    # bank._status: what the Bank+Packet agent reads when a confirmation's reply was lost.
    view = client.get(f"/api/actions/{p['action_id']}").json()
    assert view["status"] == "done" and view["amount_cents"] == p["amount_cents"] and view["withdrawal_id"]
    assert view["readback"]["ok"] is True and isinstance(view["audit"][-1]["seq"], int)


def test_the_agents_sealed_packet_is_stored_as_sent(client):
    # share.seal and api.seal_share: base64url without padding, a 12-byte IV, and only these five fields.
    ciphertext = base64.urlsafe_b64encode(os.urandom(4096)).decode().rstrip("=")
    iv = base64.urlsafe_b64encode(os.urandom(12)).decode().rstrip("=")
    body = {"ciphertext": ciphertext, "iv": iv, "alg": "AES-256-GCM", "expires_hours": 72, "once": False}
    r = client.post("/api/shares", json=body)
    assert r.status_code == 201, r.text
    sealed = r.json()
    assert sealed["id"] and sealed["expires_at"]  # bank.py builds the link from these two
    opened = client.get(f"/api/shares/{sealed['id']}").json()
    assert from_b64url(opened["ciphertext"]) == from_b64url(ciphertext) and from_b64url(opened["iv"]) == from_b64url(iv)
