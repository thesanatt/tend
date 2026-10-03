from __future__ import annotations

import dataclasses
import sqlite3
import threading
import time

import pytest
from helpers import client_for, confirm_all, make_services, scan_rowan

from tend_api.bank import BankError, DryRunBank, NessieBank
from tend_api.models import ConfirmRequest, ProposeRequest
from tend_api.storage import verify_chain

PAYMENT = {"from": "acct-checking-0001", "payee": "Riverbend General Hospital (fictional)", "amount_cents": 11800}


def propose(client, **over):
    r = client.post("/api/actions/propose", json={**PAYMENT, **over})
    assert r.status_code == 200, r.text
    return r.json()


def confirm(client, action, code=None, **over):
    return client.post(
        "/api/actions/confirm", json={"action_id": action["action_id"], "confirm_code": code or action["confirm_code"], **over}
    )


def wrong(code: str) -> str:
    return f"{(int(code) + 1) % 1_000_000:06d}"


def test_propose_then_confirm_executes_once(client):
    action = propose(client)
    assert action["status"] == "proposed" and action["dry_run"] is True
    assert len(action["confirm_code"]) == 6 and action["confirm_code"].isdigit()
    assert action["expires_at"] == "2026-10-03T18:10:00.000000Z"

    r = confirm(client, action)
    assert r.status_code == 200, r.text
    done = r.json()
    assert done["status"] == "executed"
    assert done["withdrawal_id"].startswith("dryrun-")
    assert done["readback"]["ok"] is True
    assert done["readback"]["checks"] == {"id": True, "tagged_with_action": True, "account": True, "amount": True}
    assert action["action_id"] in done["readback"]["description"]

    again = confirm(client, action)
    assert again.status_code == 409
    assert "works once" in again.json()["detail"]

    events = [row["event"] for row in client.get("/api/audit").json()["rows"]]
    assert events == ["proposed", "confirmed", "executed"]


def test_audit_chain_links_every_row(client):
    for _ in range(2):
        action = propose(client)
        confirm(client, action)
    log = client.get("/api/audit").json()
    assert log["chain"]["ok"] is True and log["chain"]["rows"] == 6
    rows = log["rows"]
    assert rows[0]["prev_hash"] == "0" * 64
    assert all(rows[i]["prev_hash"] == rows[i - 1]["hash"] for i in range(1, len(rows)))


def test_wrong_code_is_rejected_then_locks_after_five(client):
    action = propose(client)
    for attempt in range(1, 5):
        r = confirm(client, action, code=wrong(action["confirm_code"]))
        assert r.status_code == 403, attempt
    r = confirm(client, action, code=wrong(action["confirm_code"]))
    assert r.status_code == 423
    assert confirm(client, action).status_code == 409  # the right code no longer works
    assert client.get(f"/api/actions/{action['action_id']}").json()["status"] == "locked"


def test_code_expires_after_ten_minutes(client, clock):
    action = propose(client)
    clock.advance(minutes=10, seconds=1)
    r = confirm(client, action)
    assert r.status_code == 410
    assert client.get(f"/api/actions/{action['action_id']}").json()["status"] == "expired"
    assert confirm(client, action).status_code == 409


def test_code_works_just_before_expiry(client, clock):
    action = propose(client)
    clock.advance(minutes=9, seconds=59)
    assert confirm(client, action).json()["status"] == "executed"


@pytest.mark.parametrize("over", [{"amount_cents": 11900}, {"from": "acct-cushion-0001"}, {"payee": "Someone Else"}])
def test_confirmation_must_match_what_was_proposed(client, over):
    action = propose(client)
    r = confirm(client, action, **over)
    assert r.status_code == 409
    assert confirm(client, action).json()["status"] == "executed"


def test_code_is_bound_to_the_stored_action(services, client):
    action = propose(client)
    # Editing the stored amount (as an attacker with database access might) breaks the code.
    conn = sqlite3.connect(services.settings.db_path)
    conn.execute("UPDATE actions SET amount_cents = 99999 WHERE action_id = ?", (action["action_id"],))
    conn.commit()
    conn.close()
    assert confirm(client, action).status_code == 403


def test_code_is_never_stored_or_logged(services, client):
    action = propose(client)
    code = action["confirm_code"]
    row = services.repo.get_action(action["action_id"])
    assert code not in str(row)
    assert all(code not in str(r["body"]) for r in services.repo.audit_rows())
    view = client.get(f"/api/actions/{action['action_id']}").json()
    assert "code_mac" not in view and "confirm_code" not in view


@pytest.mark.parametrize("amount", [0, -100, 118.0, "11800", True])
def test_amount_must_be_positive_integer_cents(client, amount):
    assert client.post("/api/actions/propose", json={**PAYMENT, "amount_cents": amount}).status_code == 422


def test_unknown_action_is_404(client):
    assert client.post("/api/actions/confirm", json={"action_id": "act_missing", "confirm_code": "123456"}).status_code == 404


def test_held_line_cannot_be_paid(client):
    scan = scan_rowan(client)
    audit = client.post("/api/bill/audit", json={"st": "MI", "persona_id": "rowan-mi", "scan_id": scan["scan_id"]}).json()
    claim_input = confirm_all({**scan["engine_input"], "items": audit["engine_items"]})
    claim = client.post("/api/claim", params={"scan_id": scan["scan_id"]}, json=claim_input).json()
    exam = audit["holds"][0]["item_id"]
    r = client.post("/api/actions/propose", json={**PAYMENT, "amount_cents": 32500, "claim_id": claim["claim_id"], "item_id": exam})
    assert r.status_code == 409
    assert "held" in r.json()["detail"]
    other = next(i["item_id"] for i in audit["engine_items"] if i["item_id"] != exam)
    ok = client.post("/api/actions/propose", json={**PAYMENT, "amount_cents": 7500, "claim_id": claim["claim_id"], "item_id": other})
    assert ok.status_code == 200
    assert client.post("/api/actions/propose", json={**PAYMENT, "claim_id": "clm_missing"}).status_code == 404


class FailingBank(DryRunBank):
    def withdraw(self, account_id, amount_cents, description):
        raise BankError("Nessie returned 502")


class ShortReadBank(DryRunBank):
    def read_withdrawal(self, withdrawal_id):
        record = super().read_withdrawal(withdrawal_id)
        record["amount_cents"] -= 100
        return record


def test_bank_failure_is_reported_honestly_and_logged(settings, clock):
    client = client_for(make_services(settings, clock, banks={"dry_run": FailingBank()}))
    action = propose(client)
    r = confirm(client, action)
    assert r.status_code == 502
    assert "did not confirm" in r.json()["detail"] and action["action_id"] in r.json()["detail"]
    assert client.get(f"/api/actions/{action['action_id']}").json()["status"] == "failed"
    assert [row["event"] for row in client.get("/api/audit").json()["rows"]][-1] == "failed"
    assert confirm(client, action).status_code == 409


def test_readback_mismatch_is_flagged_unverified(settings, clock):
    client = client_for(make_services(settings, clock, banks={"dry_run": ShortReadBank()}))
    done = confirm(client, propose(client)).json()
    assert done["status"] == "unverified"
    assert done["readback"]["checks"]["amount"] is False


class SlowBank(DryRunBank):
    def __init__(self):
        super().__init__()
        self.calls = 0

    def withdraw(self, account_id, amount_cents, description):
        self.calls += 1
        time.sleep(0.05)
        return super().withdraw(account_id, amount_cents, description)


def test_concurrent_confirms_execute_exactly_once(settings, clock):
    bank = SlowBank()
    services = make_services(settings, clock, banks={"dry_run": bank})
    action = services.actions.propose(ProposeRequest.model_validate(PAYMENT))
    request = ConfirmRequest(action_id=action["action_id"], confirm_code=action["confirm_code"])
    barrier = threading.Barrier(4)
    outcomes: list[str] = []

    def attempt():
        barrier.wait()
        try:
            outcomes.append(services.actions.confirm(request)["status"])
        except Exception as exc:  # noqa: BLE001
            outcomes.append(f"{type(exc).__name__}:{getattr(exc, 'status_code', '')}")

    threads = [threading.Thread(target=attempt) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(outcomes) == ["ActionError:409"] * 3 + ["executed"]
    assert bank.calls == 1


class FakeNessieClient:
    """Mimics Nessie's envelope and whole-dollar amounts."""

    def __init__(self):
        self.created = {}

    def create_withdrawal(self, account_id, amount_cents, description):
        wid = f"nessie-w-{len(self.created) + 1}"
        self.created[wid] = {
            "_id": wid,
            "payer_id": account_id,
            "amount": amount_cents // 100,
            "description": description,
            "status": "pending",
            "medium": "balance",
            "type": "withdrawal",
        }
        return {"code": 201, "message": "Created withdrawal", "objectCreated": self.created[wid]}

    def get_withdrawal(self, withdrawal_id):
        return dict(self.created[withdrawal_id])


def test_live_mode_writes_through_the_nessie_client(settings, clock):
    nessie = FakeNessieClient()
    live = dataclasses.replace(settings, bank_mode="nessie")
    client = client_for(make_services(live, clock, banks={"dry_run": DryRunBank(), "nessie": NessieBank(nessie)}))
    action = propose(client)
    assert action["dry_run"] is False
    done = confirm(client, action).json()
    assert done["status"] == "executed" and done["withdrawal_id"] == "nessie-w-1"
    assert nessie.created["nessie-w-1"]["description"].startswith(f"Tend {action['action_id']}")
    assert client.get("/api/audit").json()["rows"][-1]["data"]["bank"] == "nessie"

    rehearsal = propose(client, dry_run=True)
    assert rehearsal["dry_run"] is True
    assert confirm(client, rehearsal).json()["withdrawal_id"].startswith("dryrun-")
    assert len(nessie.created) == 1


def test_dry_run_server_never_writes_live(client):
    action = propose(client, dry_run=False)
    assert action["dry_run"] is True


def test_audit_table_is_append_only(services, client):
    confirm(client, propose(client))
    conn = sqlite3.connect(services.settings.db_path)
    with pytest.raises(sqlite3.DatabaseError, match="append-only"):
        conn.execute("UPDATE audit SET event = 'nothing' WHERE seq = 1")
    with pytest.raises(sqlite3.DatabaseError, match="append-only"):
        conn.execute("DELETE FROM audit")
    conn.close()


def test_verify_chain_detects_tampering(services, client):
    confirm(client, propose(client))
    rows = services.repo.audit_rows()
    assert verify_chain(rows)["ok"] is True
    edited = [dict(r) for r in rows]
    edited[1] = {**edited[1], "body": {**edited[1]["body"], "data": {"amount_cents": 1}}}
    assert verify_chain(edited) == {"ok": False, "rows": 3, "broken_at": 2, "reason": "hash does not match the row body"}
    dropped = [rows[0], rows[2]]
    assert verify_chain(dropped)["broken_at"] == 3
