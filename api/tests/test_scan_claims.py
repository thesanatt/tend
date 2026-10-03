from __future__ import annotations

import dataclasses
import json
import sqlite3
import sys

from helpers import FIXTURES, client_for, confirm_all, fake_classifier, make_services, scan_rowan

ENGINE_FIELDS = {
    "item_id",
    "date",
    "amount_cents",
    "expense",
    "confirmed",
    "insurance_paid_cents",
    "is_bill",
    "units",
    "unit",
    "description",
    "tags",
}


def test_scan_persona_offline(client):
    scan = scan_rowan(client)
    assert scan["fictional"] is True
    assert "mock bank" in scan["label"]
    assert scan["counts"]["transactions"] == scan["read_count"] == 9  # 7 purchases, 1 deposit, 1 bill
    assert scan["incident_date"] == "2026-06-14" and scan["as_of_date"] == "2026-10-03"
    assert scan["account"] == {"id": "acct-checking-0001", "nickname": "Checking", "mask": "0011"}
    assert "scan_id" not in scan  # nothing is kept, so there is nothing to look up later
    ids = {i["item_id"] for i in scan["items"]}
    assert "nessie:p-0001" not in ids  # groceries are not a claim candidate
    inferred = [i for i in scan["items"] if i.get("kind") != "bill_line"]
    assert inferred and all(i["confirmed"] is False for i in inferred)
    assert all("confidence" in i and "reason" in i for i in scan["items"])
    ctx = scan["engine_input"]["context"]
    assert ctx == {"incident_date": "2026-06-14", "as_of_date": "2026-10-03", "police_report": "unknown", "forensic_exam": True}
    assert set(scan["engine_input"]["items"][0]) == ENGINE_FIELDS


def test_scan_items_carry_v12_units_and_tags(client):
    items = {i["item_id"]: i for i in scan_rowan(client)["engine_input"]["items"]}
    assert (items["nessie:p-0005"]["unit"], items["nessie:p-0005"]["units"]) == ("session", 1)  # one counseling charge
    assert items["nessie:p-0004"]["tags"] == ["phone"]


def test_scan_itemizes_the_hospital_bill(client):
    scan = scan_rowan(client)
    ids = {i["item_id"] for i in scan["items"]}
    assert "nessie:b-riverbend-0001" not in ids  # the bank bill is replaced by its verified lines
    lines = [i for i in scan["items"] if i.get("kind") == "bill_line"]
    assert [ln["amount_cents"] for ln in lines] == [7500, 4300, 32500]
    assert {ln["bill_id"] for ln in lines} == {"b-riverbend-0001"}
    assert [ln["expense"] for ln in lines] == ["medical", "medical", "forensic_exam"]
    assert all(ln["confirmed"] and ln["is_bill"] and ln["merchant"] and ln["source"] == "rule" for ln in lines)
    assert scan["documents"][0]["bill_id"] == "b-riverbend-0001" and scan["bill_errors"] == []
    audit = client.post("/api/bill/audit", json={"bill_id": lines[0]["bill_id"], "persona_id": "rowan-mi"}).json()
    assert [ln["item_id"] for ln in audit["lines"]] == [ln["item_id"] for ln in lines]


def test_scan_with_the_real_classifier(settings, clock):
    # No classifier hook: tend_api.classify runs on the snapshot (rules and the committed cache, no model).
    scan = client_for(make_services(settings, clock, classifier=None)).post("/api/scan", json={"persona_id": "rowan-mi", "st": "MI"})
    assert scan.status_code == 200, scan.text
    items = {i["item_id"]: i for i in scan.json()["items"]}
    counseling = items["nessie:p-0005"]
    assert (counseling["expense"], counseling["unit"], counseling["units"], counseling["source"]) == ("counseling", "session", 1, "rule")
    assert all(not i["confirmed"] for i in items.values() if i.get("method") in ("model", "link", "inference", "unresolved"))


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
    assert "TimeoutError" in r.json()["detail"]


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


def test_scan_keeps_direct_matches_confirmed_and_never_inferred_ones(settings, clock):
    def certain(transactions, st):
        items = fake_classifier(transactions, st)
        items[0].update(confirmed=True, method="registry")
        items[1].update(confirmed=True, method="model", source="cloud_ai")
        items[2].update(confirmed=True, method="link")
        return items

    scan = (
        client_for(make_services(settings, clock, classifier=certain)).post("/api/scan", json={"persona_id": "rowan-mi", "st": "MI"}).json()
    )
    assert [i["confirmed"] for i in scan["items"][:3]] == [True, False, False]


def test_claim_statuses_follow_the_rules(client):
    scan = scan_rowan(client)
    r = client.post("/api/claim", json=confirm_all(scan["engine_input"]))
    assert r.status_code == 200, r.text
    claim = r.json()
    status = {ln["item_id"]: ln for ln in claim["lines"]}
    assert status["nessie:p-0004"]["status"] == "excluded"  # phone: MI lists a cell phone as not covered
    assert status["nessie:p-0004"]["rule_ids"] == ["MI-EXCL-1"]
    assert status["nessie:p-0002"]["status"] == "unknown_rule"  # no MI rule names prescriptions
    counseling = status["nessie:p-0005"]
    assert counseling["status"] == "eligible"
    assert counseling["allowed_cents"] <= counseling["requested_cents"]


def test_unconfirmed_lines_are_not_counted(client):
    scan = scan_rowan(client)
    claim = client.post("/api/claim", json=scan["engine_input"]).json()
    bill_lines = {i["item_id"] for i in scan["items"] if i.get("kind") == "bill_line"}
    # Only the itemized bill's own lines count before the survivor says yes; the exam line is held, not counted.
    assert claim["totals"]["allowed_cents"] == 7500 + 4300
    others = {ln["status"] for ln in claim["lines"] if ln["item_id"] not in bill_lines}
    assert others <= {"needs_confirmation", "excluded", "unknown_rule"}


def test_claim_is_evaluated_and_never_stored(client, services):
    scan = scan_rowan(client)
    assert client.post("/api/claim", json=confirm_all(scan["engine_input"])).status_code == 200
    conn = sqlite3.connect(services.settings.database_url)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    conn.close()
    assert not tables & {"claims", "scans", "evidence", "shares", "agent_links", "agent_sessions"}
    assert services.repo.audit_rows() == []


def test_claim_accepts_classified_items_as_sent_by_the_device(client):
    scan = scan_rowan(client)
    # ClassifiedItem rows (engine fields plus source, reason, confidence) go straight to the engine.
    items = [
        {**{k: i[k] for k in ENGINE_FIELDS}, "source": i["source"] if "source" in i else "rule", "reason": "x", "confidence": 0.9}
        for i in scan["items"]
    ]
    r = client.post("/api/claim", json={**scan["engine_input"], "items": items})
    assert r.status_code == 200, r.text


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


def test_claim_view_joins_lines_to_verbatim_law(client, services):
    from tend_api.models import ClaimInput

    scan = scan_rowan(client)
    output, engine, payload = services.claims.evaluate(ClaimInput.model_validate(confirm_all(scan["engine_input"])))
    view = services.claims.view(payload, output, engine, persona_id="rowan-mi")
    rules = {r["id"]: r for r in client.get("/api/jurisdictions/MI").json()["rules"]}
    phone = next(ln for ln in view["lines"] if ln["item_id"] == "nessie:p-0004")
    cite = phone["citations"][0]
    assert cite["quote"] == rules["MI-EXCL-1"]["quote"]
    assert cite["source_sha256"] and cite["pinpoint"]
    assert phone["amount_cents"] == 29900 and phone["date"] == "2026-06-18"
    assert view["fictional"] is True and view["display_name"] == "Rowan Example"
    assert view["claim_id"].startswith("T-") and view["claim_id"] == services.claims.view(payload, output, engine)["claim_id"]
    assert services.claims.view(payload, output, engine)["display_name"] is None  # no persona, no name
