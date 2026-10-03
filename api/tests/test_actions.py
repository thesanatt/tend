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
    assert done["status"] == "done"
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
    assert confirm(client, action).json()["status"] == "done"


@pytest.mark.parametrize("over", [{"amount_cents": 11900}, {"from": "acct-cushion-0001"}, {"payee": "Someone Else"}])
def test_confirmation_must_match_what_was_proposed(client, over):
    action = propose(client)
    r = confirm(client, action, **over)
    assert r.status_code == 409
    assert confirm(client, action).json()["status"] == "done"


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


def bill_lines(client):
    scan = scan_rowan(client)
    audit = client.post("/api/bill/audit", json={"bill_id": "b-riverbend-0001", "persona_id": "rowan-mi"}).json()
    held = {h["item_id"] for h in audit["holds"]}
    return audit, [ln for ln in audit["lines"] if ln["item_id"] not in held], [ln for ln in audit["lines"] if ln["item_id"] in held], scan


def pay_bill(client, lines, **over):
    body = {
        "kind": "pay_bill",
        "bill_id": "b-riverbend-0001",
        "item_ids": [ln["item_id"] for ln in lines],
        "amount_cents": sum(ln["amount_cents"] for ln in lines),
        "from_account_id": "acct-checking-0001",
        "payee": "Riverbend General Hospital (fictional)",
    }
    return client.post("/api/actions/propose", json={**body, **over})


def test_paying_bill_lines_records_what_was_paid(client):
    _, payable, _, _ = bill_lines(client)
    proposal = pay_bill(client, payable)
    assert proposal.status_code == 200, proposal.text
    body = proposal.json()
    assert body["kind"] == "pay_bill" and body["item_ids"] == [ln["item_id"] for ln in payable] and body["amount_cents"] == 11800
    result = confirm(client, body).json()
    assert result["status"] == "done" and result["bill_id"] == "b-riverbend-0001" and result["item_ids"] == body["item_ids"]
    assert "Dry run" in result["message"]
    proposed_row = client.get("/api/audit").json()["rows"][0]
    assert proposed_row["data"]["item_ids"] == body["item_ids"]


def test_bill_payment_must_equal_its_lines(client):
    _, payable, _, _ = bill_lines(client)
    r = pay_bill(client, payable, amount_cents=12000)
    assert r.status_code == 409
    assert "$118.00" in r.json()["detail"]


def test_held_bill_line_cannot_be_paid_even_without_a_claim(client):
    _, payable, held, _ = bill_lines(client)
    r = pay_bill(client, payable + held)
    assert r.status_code == 409
    assert "held" in r.json()["detail"]


def test_unknown_bill_line_cannot_be_paid(client):
    r = pay_bill(client, [{"item_id": "bill:0000000000000000:9", "amount_cents": 500}])
    assert r.status_code == 404


def test_bill_is_paid_only_from_the_persona_accounts(client):
    _, payable, _, _ = bill_lines(client)
    r = pay_bill(client, payable, from_account_id="acct-someone-else")
    assert r.status_code == 403


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
    def withdraw(self, account_id, amount_cents, description, on_date):
        raise BankError("Nessie POST /accounts/x/withdrawals -> 400: invalid account")


class SilentBank(DryRunBank):
    """No answer comes back. With landed=True the write happened anyway."""

    def __init__(self, landed):
        super().__init__()
        self.landed = landed

    def withdraw(self, account_id, amount_cents, description, on_date):
        if self.landed:
            super().withdraw(account_id, amount_cents, description, on_date)
        raise BankError("read timed out", maybe_applied=True)


class ShortReadBank(DryRunBank):
    def read_withdrawal(self, withdrawal_id):
        record = super().read_withdrawal(withdrawal_id)
        record["amount_cents"] -= 100
        return record


def test_refused_payment_moves_no_money_and_is_logged(settings, clock):
    client = client_for(make_services(settings, clock, banks={"dry_run": FailingBank()}))
    action = propose(client)
    r = confirm(client, action)
    assert r.status_code == 502
    assert "no money moved" in r.json()["detail"]
    assert client.get(f"/api/actions/{action['action_id']}").json()["status"] == "failed"
    assert [row["event"] for row in client.get("/api/audit").json()["rows"]][-1] == "failed"
    assert confirm(client, action).status_code == 409


def test_unanswered_payment_is_never_called_safe(settings, clock):
    client = client_for(make_services(settings, clock, banks={"dry_run": SilentBank(landed=False)}))
    action = propose(client)
    r = confirm(client, action)
    assert r.status_code == 502
    assert "may have gone through" in r.json()["detail"] and action["action_id"] in r.json()["detail"]
    assert client.get(f"/api/actions/{action['action_id']}").json()["status"] == "unverified"


def test_unanswered_payment_that_landed_is_found_by_its_label(settings, clock):
    client = client_for(make_services(settings, clock, banks={"dry_run": SilentBank(landed=True)}))
    done = confirm(client, propose(client))
    assert done.status_code == 200
    assert done.json()["status"] == "done" and done.json()["readback"]["ok"] is True


def test_readback_mismatch_is_flagged_unverified(settings, clock):
    client = client_for(make_services(settings, clock, banks={"dry_run": ShortReadBank()}))
    done = confirm(client, propose(client)).json()
    assert done["status"] == "unverified"
    assert done["readback"]["checks"]["amount"] is False


class SlowBank(DryRunBank):
    def __init__(self):
        super().__init__()
        self.calls = 0

    def withdraw(self, account_id, amount_cents, description, on_date):
        self.calls += 1
        time.sleep(0.05)
        return super().withdraw(account_id, amount_cents, description, on_date)


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
    assert sorted(outcomes) == ["ActionError:409"] * 3 + ["done"]
    assert bank.calls == 1


@dataclasses.dataclass(frozen=True)
class Txn:
    id: str
    kind: str
    account_id: str
    date: str
    amount_cents: int
    status: str
    description: str


class FakeNessieClient:
    """Same calls as tend_api.nessie.NessieClient. Nessie itself keeps whole dollars."""

    def __init__(self, reported_account=None):
        self.stored = {}
        self.reported_account = reported_account

    def create_withdrawal(self, account_id, *, amount_cents, date, description, status="completed", medium="balance"):
        if amount_cents % 100:
            raise ValueError("Nessie stores whole dollars")
        wid = f"nessie-w-{len(self.stored) + 1}"
        self.stored[wid] = {
            "_id": wid,
            "payer_id": account_id,
            "transaction_date": str(date),
            "amount": amount_cents // 100,
            "description": description,
            "status": status,
        }
        return self.get_txn("withdrawal", wid, account_id)

    def get_txn(self, kind, txn_id, account_id=None):
        raw = self.stored[txn_id]
        return Txn(
            raw["_id"],
            kind,
            account_id or self.reported_account or raw["payer_id"],
            raw["transaction_date"],
            raw["amount"] * 100,
            raw["status"],
            raw["description"],
        )

    def find_txns(self, account_id, kind, marker):
        return [
            self.get_txn(kind, wid) for wid, raw in self.stored.items() if raw["payer_id"] == account_id and marker in raw["description"]
        ]


def live_client(settings, clock, nessie):
    live = dataclasses.replace(settings, bank_mode="nessie")
    return client_for(make_services(live, clock, banks={"dry_run": DryRunBank(), "nessie": NessieBank(nessie)}))


def test_live_mode_writes_through_the_nessie_client(settings, clock):
    nessie = FakeNessieClient()
    client = live_client(settings, clock, nessie)
    action = propose(client)
    assert action["dry_run"] is False
    done = confirm(client, action).json()
    assert done["status"] == "done" and done["withdrawal_id"] == "nessie-w-1"
    assert done["readback"]["checks"] == {"id": True, "tagged_with_action": True, "account": True, "amount": True}
    stored = nessie.stored["nessie-w-1"]
    assert stored["amount"] == 118 and stored["transaction_date"] == "2026-10-03"
    assert stored["description"].startswith(f"Tend {action['action_id']}")
    assert client.get("/api/audit").json()["rows"][-1]["data"]["bank"] == "nessie"

    rehearsal = propose(client, dry_run=True)
    assert rehearsal["dry_run"] is True
    assert confirm(client, rehearsal).json()["withdrawal_id"].startswith("dryrun-")
    assert len(nessie.stored) == 1


def test_live_readback_checks_the_bank_record_not_an_echo(settings, clock):
    client = live_client(settings, clock, FakeNessieClient(reported_account="acct-someone-else"))
    done = confirm(client, propose(client)).json()
    assert done["status"] == "unverified"
    assert done["readback"]["checks"]["account"] is False


def test_live_payments_must_be_whole_dollars(settings, clock):
    client = live_client(settings, clock, FakeNessieClient())
    r = client.post("/api/actions/propose", json={**PAYMENT, "amount_cents": 11850})
    assert r.status_code == 422
    assert "whole dollars" in r.json()["detail"]
    assert client.post("/api/actions/propose", json={**PAYMENT, "amount_cents": 11850, "dry_run": True}).status_code == 200


def test_live_payments_only_from_persona_accounts(settings, clock):
    nessie = FakeNessieClient()
    client = live_client(settings, clock, nessie)
    r = client.post("/api/actions/propose", json={**PAYMENT, "from": "someone-elses-account"})
    assert r.status_code == 403
    assert client.post("/api/actions/propose", json={**PAYMENT, "from": "acct-cushion-0001"}).status_code == 200
    assert nessie.stored == {}


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
