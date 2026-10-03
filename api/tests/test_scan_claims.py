from __future__ import annotations

import dataclasses
import json
import sys

from helpers import FIXTURES, client_for, confirm_all, fake_classifier, make_services, scan_rowan


def test_scan_persona_offline(client):
    scan = scan_rowan(client)
    assert scan["fictional"] is True
    assert "mock bank" in scan["label"]
    assert scan["counts"]["transactions"] == scan["read_count"] == 9  # 7 purchases, 1 deposit, 1 bill
    assert scan["incident_date"] == "2026-06-14" and scan["as_of_date"] == "2026-10-03"
    assert scan["account"] == {"id": "acct-checking-0001", "nickname": "Checking", "mask": "0011"}
    ids = {i["item_id"] for i in scan["items"]}
    assert "nessie:p-0001" not in ids  # groceries are not a claim candidate
    inferred = [i for i in scan["items"] if i.get("source") != "bill"]
    assert inferred and all(i["confirmed"] is False for i in inferred)
    assert all("confidence" in i and "reason" in i for i in scan["items"])
    ctx = scan["engine_input"]["context"]
    assert ctx == {"incident_date": "2026-06-14", "as_of_date": "2026-10-03", "police_report": "unknown", "forensic_exam": True}
    assert set(scan["engine_input"]["items"][0]) == {
        "item_id",
        "date",
        "amount_cents",
        "expense",
        "confirmed",
        "insurance_paid_cents",
        "is_bill",
        "units",
        "description",
        "tags",
    }


def test_scan_itemizes_the_hospital_bill(client):
    scan = scan_rowan(client)
    ids = {i["item_id"] for i in scan["items"]}
    assert "nessie:b-riverbend-0001" not in ids  # the bank bill is replaced by its verified lines
    lines = [i for i in scan["items"] if i.get("source") == "bill"]
    assert [ln["amount_cents"] for ln in lines] == [7500, 4300, 32500]
    assert {ln["bill_id"] for ln in lines} == {"b-riverbend-0001"}
    assert [ln["expense"] for ln in lines] == ["medical", "medical", "forensic_exam"]
    assert all(ln["confirmed"] and ln["is_bill"] and ln["merchant"] for ln in lines)
    assert scan["documents"][0]["bill_id"] == "b-riverbend-0001" and scan["bill_errors"] == []
    audit = client.post("/api/bill/audit", json={"bill_id": lines[0]["bill_id"], "persona_id": "rowan-mi"}).json()
    assert [ln["item_id"] for ln in audit["lines"]] == [ln["item_id"] for ln in lines]


def test_scan_incident_date_override_and_state_switch(client):
    scan = scan_rowan(client, incident_date="2026-06-10")
    assert scan["engine_input"]["context"]["incident_date"] == "2026-06-10"
    wi = client.post("/api/scan", json={"persona_id": "rowan-mi", "st": "WI"}).json()
    assert wi["engine_input"]["jurisdiction"] == "WI"


def test_scan_by_customer_id_uses_snapshot(client):
    r = client.post("/api/scan", json={"customer_id": "cust-rowan-0001", "st": "MI"})
    assert r.status_code == 200
    assert r.json()["persona_id"] == "rowan-mi"
    assert client.post("/api/scan", json={"customer_id": "nobody", "st": "MI"}).status_code == 404


class LiveClient:
    def __init__(self, snapshot=None, error=None):
        self._snapshot, self._error = snapshot, error

    def snapshot(self, customer_id):
        if self._error:
            raise self._error
        return dict(self._snapshot)


def test_live_scan_when_enabled(settings, clock):
    snap = json.loads((FIXTURES / "seed" / "snapshots" / "rowan-mi.json").read_text())
    snap["meta"].pop("fictional")
    live = dataclasses.replace(settings, live_scan=True)
    client = client_for(make_services(live, clock, nessie_client_factory=lambda: LiveClient(snapshot=snap)))
    data = client.post("/api/scan", json={"customer_id": "live-customer", "st": "MI"}).json()
    assert data["fictional"] is False and data["display_name"] is None
    assert "mock bank" in data["label"]

    broken = client_for(make_services(live, clock, nessie_client_factory=lambda: LiveClient(error=TimeoutError("timed out"))))
    r = broken.post("/api/scan", json={"customer_id": "live-customer", "st": "MI"})
    assert r.status_code == 502
    assert "timed out" in r.json()["detail"]


def test_scan_errors(client):
    assert client.post("/api/scan", json={"persona_id": "nobody", "st": "MI"}).status_code == 404
    assert client.post("/api/scan", json={"persona_id": "rowan-mi", "st": "ZZ"}).status_code == 404
    assert client.post("/api/scan", json={"persona_id": "../etc", "st": "MI"}).status_code == 422


def test_scan_without_classifier_is_503(settings, clock, monkeypatch):
    monkeypatch.setitem(sys.modules, "tend_api.classify", None)
    client = client_for(make_services(settings, clock, classifier=None))
    r = client.post("/api/scan", json={"persona_id": "rowan-mi", "st": "MI"})
    assert r.status_code == 503
    assert "classifier" in r.json()["detail"]


def test_scan_rejects_float_money_from_classifier(settings, clock):
    def floaty(transactions, st):
        items = fake_classifier(transactions, st)
        items[0]["amount_cents"] = 150.0
        return items

    r = client_for(make_services(settings, clock, classifier=floaty)).post("/api/scan", json={"persona_id": "rowan-mi", "st": "MI"})
    assert r.status_code == 502


def test_scan_keeps_certain_items_confirmed_only_at_full_confidence(settings, clock):
    def certain(transactions, st):
        items = fake_classifier(transactions, st)
        items[0].update(confidence=1.0, confirmed=True)
        items[1].update(confidence=0.95, confirmed=True)
        return items

    scan = (
        client_for(make_services(settings, clock, classifier=certain)).post("/api/scan", json={"persona_id": "rowan-mi", "st": "MI"}).json()
    )
    assert scan["items"][0]["confirmed"] is True
    assert scan["items"][1]["confirmed"] is False


def test_claim_statuses_follow_the_rules(client):
    scan = scan_rowan(client)
    r = client.post("/api/claim", params={"scan_id": scan["scan_id"]}, json=confirm_all(scan["engine_input"]))
    assert r.status_code == 200, r.text
    claim = r.json()
    status = {ln["item_id"]: ln for ln in claim["lines"]}
    assert status["nessie:p-0004"]["status"] == "excluded"  # phone: MI lists a cell phone as not covered
    assert status["nessie:p-0004"]["rule_ids"] == ["MI-EXCL-1"]
    assert status["nessie:p-0002"]["status"] == "unknown_rule"  # no MI rule names prescriptions
    counseling = status["nessie:p-0005"]
    assert counseling["status"] == "eligible"
    assert counseling["allowed_cents"] <= counseling["requested_cents"]
    assert claim["evidence"] == {"checked": True, "scan_id": scan["scan_id"]}


def test_unconfirmed_lines_are_not_counted(client):
    scan = scan_rowan(client)
    claim = client.post("/api/claim", params={"scan_id": scan["scan_id"]}, json=scan["engine_input"]).json()
    bill_lines = {i["item_id"] for i in scan["items"] if i.get("source") == "bill"}
    # Only the itemized bill's own lines count before the survivor says yes; the exam line is held, not counted.
    assert claim["totals"]["allowed_cents"] == 7500 + 4300
    others = {ln["status"] for ln in claim["lines"] if ln["item_id"] not in bill_lines}
    assert others <= {"needs_confirmation", "excluded", "unknown_rule"}


def test_made_up_line_is_refused_with_a_reason(client):
    scan = scan_rowan(client)
    claim_input = confirm_all(scan["engine_input"])
    real = claim_input["items"][0]
    claim_input["items"] = [
        real,
        {**real, "item_id": "nessie:made-up", "amount_cents": 50000},
        {**claim_input["items"][1], "amount_cents": claim_input["items"][1]["amount_cents"] + 100},
        {**claim_input["items"][2], "date": "2026-06-30"},
    ]
    claim = client.post("/api/claim", params={"scan_id": scan["scan_id"]}, json=claim_input).json()
    refused = {r["item_id"]: r["reason"] for r in claim["refused"]}
    assert "nessie:made-up" in refused and "No transaction" in refused["nessie:made-up"]
    assert "amount does not match" in refused[claim_input["items"][2]["item_id"]]
    assert "date does not match" in refused[claim_input["items"][3]["item_id"]]
    assert [ln["item_id"] for ln in claim["lines"]] == [real["item_id"]]


def test_claim_without_scan_is_marked_unchecked(client):
    scan = scan_rowan(client)
    claim = client.post("/api/claim", json=scan["engine_input"]).json()
    assert claim["evidence"] == {"checked": False, "scan_id": None}
    assert client.post("/api/claim", params={"scan_id": "scan_missing"}, json=scan["engine_input"]).status_code == 404


def test_claim_rejects_narrative_fields_and_float_money(client):
    scan = scan_rowan(client)
    body = scan["engine_input"]
    with_story = {**body, "items": [{**body["items"][0], "what_happened": "x"}]}
    assert client.post("/api/claim", json=with_story).status_code == 422
    floaty = {**body, "items": [{**body["items"][0], "amount_cents": 150.5}]}
    assert client.post("/api/claim", json=floaty).status_code == 422
    assert client.post("/api/claim", json={**body, "notes": "x"}).status_code == 422


def test_claim_unknown_jurisdiction_is_404(client):
    body = {"jurisdiction": "ZZ", "context": {"incident_date": "2026-06-14", "as_of_date": "2026-10-03"}, "items": []}
    assert client.post("/api/claim", json=body).status_code == 404


def test_claim_view_joins_lines_to_verbatim_law(client):
    scan = scan_rowan(client)
    claim = client.post("/api/claim", params={"scan_id": scan["scan_id"]}, json=confirm_all(scan["engine_input"])).json()
    view = client.get(f"/api/claims/{claim['claim_id']}").json()
    rules = {r["id"]: r for r in client.get("/api/jurisdictions/MI").json()["rules"]}
    phone = next(ln for ln in view["lines"] if ln["item_id"] == "nessie:p-0004")
    cite = phone["citations"][0]
    assert cite["quote"] == rules["MI-EXCL-1"]["quote"]
    assert cite["source_sha256"] and cite["pinpoint"]
    assert phone["amount_cents"] == 29900 and phone["date"] == "2026-06-18"
    assert view["fictional"] is True and view["display_name"] == "Rowan Example"
    assert client.get("/api/claims/clm_missing").status_code == 404
