"""What the Fetch.ai agent (agent/ on main) sends and reads, replayed against this API.

The request shapes are copied from agent/tend_agent/api.py and demo.py: the agent finds
/agent/answer and /agent/check through OpenAPI, sends scan_id back with a bill audit, and reads the
fields asserted here. A failure means the agent breaks when this API ships.
"""

from __future__ import annotations

from helpers import CHECKING

# navigator._strip_input: the engine fields the agent keeps (no description, no merchant text).
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

    # demo.confirmed_input, then navigator._strip_input
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
    # The agent clears its pending payment after the first answer, so it never sends this. A confirm that is sent
    # again (a lost answer) gets the first result back and moves nothing.
    again = client.post("/api/actions/confirm", json={"action_id": p["action_id"], "confirm_code": p["confirm_code"]})
    assert again.status_code == 200 and again.json()["replayed"] is True and again.json()["nessie_id"] == result["nessie_id"]
