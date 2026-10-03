"""The Fetch.ai agent's endpoints: cited answers that refuse, the Check summary, and typed-approval payments."""

from __future__ import annotations

import dataclasses
import re

import pytest
from helpers import BILL_ID, CHECKING, REPO, client_for, make_services

PAY = {"persona_id": "rowan-mi", "payee": "Riverbend General Hospital (fictional)", "amount_cents": 11800}
QUIET_WORDS = re.compile(r"\b(elevate|empower|unlock|seamless|robust|journey|qualify|you should)\b", re.I)


def ask(client, question, st="MI"):
    r = client.post("/api/agent/answer", json={"question": question, "st": st})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.parametrize(
    "question, expected",
    [
        ("How long do I have to apply?", {"MI-FILE-1"}),
        ("Do I need a police report?", {"MI-REPORT-1"}),
        ("Will they pay for therapy?", {"MI-COV-2"}),
        ("Can the hospital bill me for the rape kit?", {"MI-EXAM-1"}),
        ("Is my new phone covered?", {"MI-EXCL-1"}),
        ("What is the most I can get?", {"MI-CAP-1"}),
    ],
)
def test_answers_cite_the_rules_that_support_them(client, question, expected):
    data = ask(client, question)
    assert data["answered"] is True and data["st"] == "MI"
    cited = {p["rule_id"] for p in data["points"]}
    assert expected <= cited, (question, cited)
    for p in data["points"]:
        assert p["quote"] and p["pinpoint"] and p["source_sha256"] and p["text"]
    assert data["answer"] == data["points"][0]["text"]
    assert "The program decides" in data["note"]


def test_answers_carry_fragment_links_to_the_quote(client):
    exam = next(p for p in ask(client, "Can they bill me for the forensic exam?")["points"] if p["rule_id"] == "MI-EXAM-1")
    assert exam["pinpoint"] == "MCL 18.355a(2)" and "#:~:text=" in exam["fragment_url"]


@pytest.mark.parametrize("question", ["Can I get money for my dog's vet bills?", "What's the weather tomorrow?", "zzzz qqqq"])
def test_no_supporting_rule_means_no_answer(client, question):
    data = ask(client, question)
    assert data["answered"] is False and data["reason"] == "no_rule"
    assert "will not guess" in data["message"] and "877-251-7373" in data["message"]
    assert "points" not in data


def test_contact_questions_get_the_program_phone(client):
    data = ask(client, "What is the program's phone number?")
    assert data["answered"] is True and "877-251-7373" in data["answer"]
    assert data["contact"]["phone"] == "877-251-7373"


def test_the_state_can_come_from_the_question(client):
    assert ask(client, "How long do I have in Wisconsin?", st=None)["st"] == "WI"
    data = client.post("/api/agent/answer", json={"question": "How long do I have to apply?"}).json()
    assert data["answered"] is False and data["reason"] == "no_state"
    assert client.post("/api/agent/answer", json={"question": "deadline", "st": "ZZ"}).status_code == 404


def test_check_summary_from_verified_rules(client):
    r = client.post("/api/agent/check", json={"st": "MI", "incident_date": "2026-06-14", "forensic_exam": True, "police_report": "no"})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["headline"]["text"] == "You can likely apply in Michigan."
    assert data["deadline"]["text"] == "Apply by June 14, 2031." and data["deadline"]["status"] == "ok"
    assert "MI-FILE-1" in data["deadline"]["rule_ids"] and data["deadline"]["citations"]
    assert data["reporting"]["status"] == "satisfied" and "forensic exam counts" in data["reporting"]["text"]
    covered = {c["expense"]: c for c in data["covered"]}
    assert covered["counseling"]["text"].startswith("Counseling, up to $")
    assert data["total_cap"]["text"] == "Up to $45,000 in all."
    assert data["program"]["phone"] == "877-251-7373"
    assert data["engine"] == "reference" and data["law_ir"] is False  # fixture rules come without an IR
    for part in [data["headline"], data["deadline"], data["reporting"], *data["covered"]]:
        assert part["rule_ids"] or part is data["headline"], part
        assert not QUIET_WORDS.search(part["text"]) and "—" not in part["text"]


def test_check_without_a_date_or_an_exam_answer(client):
    data = client.get("/api/agent/check", params={"st": "mi"}).json()
    assert data["deadline"]["status"] == "unknown" and "5 years" in data["deadline"]["text"]
    assert data["engine"] is None and data["reporting_if_exam"] is None
    unsure = client.post("/api/agent/check", json={"st": "MI", "incident_date": "2026-06-14", "police_report": "not_yet"}).json()
    # Never assume an exam: with "not sure", both answers come back so the agent can ask.
    assert unsure["reporting"]["status"] == "required" and "forensic exam" in unsure["reporting"]["text"]
    assert unsure["reporting_if_exam"]["status"] == "satisfied"
    assert client.get("/api/agent/check", params={"st": "ZZ"}).status_code == 404


def test_check_after_the_deadline_says_so(client):
    data = client.post("/api/agent/check", json={"st": "MI", "incident_date": "2020-01-01"}).json()
    assert data["deadline"]["status"] == "late" and "Ask the program about exceptions" in data["headline"]["text"]


@pytest.fixture
def real(settings, clock):
    """The real corpus with its IR and the real Python reference engine."""
    real_settings = dataclasses.replace(
        settings, rules_dir=REPO / "rules" / "verified", ir_dir=REPO / "rules" / "ir", refengine_dir=REPO / "refengine"
    )
    return client_for(make_services(real_settings, clock, reference_evaluate=None))


def test_check_summary_reads_the_law_ir(real):
    data = real.post("/api/agent/check", json={"st": "MI", "incident_date": "2026-06-14", "forensic_exam": True}).json()
    assert data["law_ir"] is True
    covered = {c["expense"]: c["text"] for c in data["covered"]}
    assert covered["counseling"] == "Counseling, up to $125 a session"
    assert covered["lost_wages"] == "Lost pay, up to $1,000 a week"
    assert data["minimum_loss"]["text"].startswith("The program asks for at least $200")
    assert {"address_confidentiality", "record_confidentiality"} == {p["category"] for p in data["privacy"]}


@pytest.mark.parametrize("st", ["CA", "NY", "TX", "DC", "WY"])
def test_every_state_gets_a_cited_check_and_answers(real, st):
    data = real.post("/api/agent/check", json={"st": st, "incident_date": "2026-06-14"}).json()
    assert data["headline"]["text"].startswith(("You can likely apply", "The usual deadline"))
    assert data["program"]["phone"] or data["program"]["website"]
    answer = real.post("/api/agent/answer", json={"question": "How long do I have to apply?", "st": st}).json()
    assert answer["answered"] is False or all(p["quote"] for p in answer["points"])


def test_agent_pays_only_after_the_typed_amount(client):
    proposal = client.post("/api/agent/pay", json=PAY)
    assert proposal.status_code == 200, proposal.text
    body = proposal.json()
    assert body["from"] == CHECKING and body["confirm_phrase"] == "confirm 118.00"
    assert '"confirm 118.00"' in body["ask_user"]
    for typed in ("yes", "confirm", "confirm 117.99", "confirm 1180.00", "confirm 1,1", "confirm 118.00 to someone else"):
        r = client.post("/api/agent/confirm", json={"action_id": body["action_id"], "confirm_code": body["confirm_code"], "typed": typed})
        assert r.status_code == 409 and "Nothing was paid" in r.json()["detail"], typed
    done = client.post(
        "/api/agent/confirm", json={"action_id": body["action_id"], "confirm_code": body["confirm_code"], "typed": "Confirm $118"}
    )
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "done" and done.json()["audit"]["seq"] == 2


def test_agent_payment_needs_the_agent_route_and_app_payments_need_the_app(client):
    agent = client.post("/api/agent/pay", json=PAY).json()
    via_app = client.post("/api/actions/confirm", json={"action_id": agent["action_id"], "confirm_code": agent["confirm_code"]})
    assert via_app.status_code == 409 and "agent" in via_app.json()["detail"]
    app = client.post("/api/actions/propose", json={"from": CHECKING, "payee": "x", "amount_cents": 500}).json()
    via_agent = client.post(
        "/api/agent/confirm", json={"action_id": app["action_id"], "confirm_code": app["confirm_code"], "typed": "confirm 5.00"}
    )
    assert via_agent.status_code == 404


def test_agent_pays_a_bill_but_never_its_held_line(client):
    ok = client.post("/api/agent/pay", json={**PAY, "bill_id": BILL_ID})
    assert ok.status_code == 200, ok.text
    assert len(ok.json()["item_ids"]) == 2  # the exam line is held, so only the other two
    held = client.post("/api/agent/pay", json={**PAY, "bill_id": BILL_ID, "amount_cents": 44300})
    assert held.status_code == 409


def test_agent_pays_only_from_a_persona_account(settings, clock):
    live = client_for(make_services(dataclasses.replace(settings, bank_mode="nessie"), clock))
    r = live.post("/api/agent/pay", json={"from": "someone-else", "payee": "x", "amount_cents": 500})
    assert r.status_code == 403
    assert live.post("/api/agent/pay", json={"persona_id": "nobody", "payee": "x", "amount_cents": 500}).status_code == 404
    both = live.post("/api/agent/pay", json={"persona_id": "rowan-mi", "from": CHECKING, "payee": "x", "amount_cents": 500})
    assert both.status_code == 422
