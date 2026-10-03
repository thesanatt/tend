from __future__ import annotations

import dataclasses
import sqlite3
import threading
import time

import pytest
from helpers import BILL_ID, CHECKING, client_for, make_services

from tend_api.bank import BankError, DryRunBank, NessieBank
from tend_api.db import verify_chain
from tend_api.models import ConfirmRequest, ProposeRequest

PAYEE = "Riverbend General Hospital (fictional)"
PAYMENT = {"from": CHECKING, "payee": PAYEE, "amount_cents": 11800}
MISSING_ACTION = "act_" + "0" * 20


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
    assert done["readback"]["description"].endswith(f"[tend:{action['action_id']}]")

    again = confirm(client, action)
    assert again.status_code == 409
    assert "works once" in again.json()["detail"]

    # The log holds confirmed payments only: a proposal that never gets its yes leaves no row.
    events = [row["event"] for row in client.get("/api/audit").json()["rows"]]
    assert events == ["confirmed", "executed"]


def test_an_unconfirmed_proposal_leaves_no_audit_row(client):
    propose(client)
    assert client.get("/api/audit").json() == {"chain": {"ok": True, "rows": 0, "head": "0" * 64}, "rows": []}


def test_audit_chain_links_every_row(client):
    for _ in range(2):
        confirm(client, propose(client))
    log = client.get("/api/audit").json()
    assert log["chain"]["ok"] is True and log["chain"]["rows"] == 4
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
    assert confirm(client, action).status_code == 423  # the right code no longer works
    view = client.get(f"/api/actions/{action['action_id']}").json()
    assert view["status"] == "locked" and view["attempts"] == 5 and view["payee"] is None
    assert client.get("/api/audit").json()["rows"] == []


def test_code_expires_after_ten_minutes(client, clock):
    action = propose(client)
    clock.advance(minutes=10, seconds=1)
    r = confirm(client, action)
    assert r.status_code == 410
    view = client.get(f"/api/actions/{action['action_id']}").json()
    assert view["status"] == "expired" and view["payee"] is None
    assert confirm(client, action).status_code == 410


def test_code_works_just_before_expiry(client, clock):
    action = propose(client)
    clock.advance(minutes=9, seconds=59)
    assert confirm(client, action).json()["status"] == "done"


def test_a_sweep_expires_proposals_nobody_confirmed(client, services, clock):
    action = propose(client)
    clock.advance(minutes=11)
    propose(client)  # every proposal sweeps first
    row = services.repo.get_action(action["action_id"])
    assert row["status"] == "expired" and row["payee"] is None
    clock.advance(days=2)
    propose(client)
    assert services.repo.get_action(action["action_id"]) is None  # finished rows go after a day


@pytest.mark.parametrize("over", [{"amount_cents": 11900}, {"from": "acct-cushion-0001"}, {"payee": "Someone Else"}])
def test_confirmation_must_match_what_was_proposed(client, over):
    action = propose(client)
    r = confirm(client, action, **over)
    assert r.status_code == 409
    assert confirm(client, action).json()["status"] == "done"


def test_code_is_bound_to_the_stored_action(services, client):
    action = propose(client)
    # Editing the stored amount (as an attacker with database access might) breaks the code.
    conn = sqlite3.connect(services.settings.database_url)
    conn.execute("UPDATE pending_actions SET amount_cents = 99999 WHERE action_id = ?", (action["action_id"],))
    conn.commit()
    conn.close()
    assert confirm(client, action).status_code == 403


def test_code_is_never_stored_or_logged(services, client):
    action = propose(client)
    code = action["confirm_code"]
    row = services.repo.get_action(action["action_id"])
    assert code not in str(row)
    confirm(client, action)
    assert all(code not in str(r["body"]) for r in services.repo.audit_rows())
    view = client.get(f"/api/actions/{action['action_id']}").json()
    assert "code_mac" not in view and "confirm_code" not in view


def test_finished_payment_keeps_no_payee_name(services, client):
    action = propose(client)
    assert services.repo.get_action(action["action_id"])["payee"] == PAYEE  # only while it waits for the code
    confirm(client, action)
    row = services.repo.get_action(action["action_id"])
    assert row["payee"] is None and row["status"] == "done"
    assert PAYEE not in str(row) and "Riverbend" not in str(row["readback"])
    assert all(
        "Riverbend" not in r["body"] if isinstance(r["body"], str) else "Riverbend" not in str(r["body"])
        for r in services.repo.audit_rows()
    )


@pytest.mark.parametrize("amount", [0, -100, 118.0, "11800", True])
def test_amount_must_be_positive_integer_cents(client, amount):
    assert client.post("/api/actions/propose", json={**PAYMENT, "amount_cents": amount}).status_code == 422


def test_unknown_action_is_404(client):
    assert client.post("/api/actions/confirm", json={"action_id": MISSING_ACTION, "confirm_code": "123456"}).status_code == 404
    assert client.get(f"/api/actions/{MISSING_ACTION}").status_code == 404
    assert client.get("/api/actions/act_1").status_code == 422


def bill_audit(client):
    audit = client.post("/api/bill/audit", json={"bill_id": BILL_ID, "persona_id": "rowan-mi"}).json()
    held = {h["item_id"] for h in audit["holds"]}
    return audit, [ln for ln in audit["lines"] if ln["item_id"] not in held], [ln for ln in audit["lines"] if ln["item_id"] in held]


def pay_bill(client, lines, **over):
    body = {
        "kind": "pay_bill",
        "bill_id": BILL_ID,
        "item_ids": [ln["item_id"] for ln in lines],
        "amount_cents": sum(ln["amount_cents"] for ln in lines),
        "from_account_id": CHECKING,
        "payee": PAYEE,
    }
    return client.post("/api/actions/propose", json={**body, **over})


def test_paying_bill_lines_records_what_was_paid(client):
    _, payable, _ = bill_audit(client)
    proposal = pay_bill(client, payable)
    assert proposal.status_code == 200, proposal.text
    body = proposal.json()
    assert body["kind"] == "pay_bill" and body["item_ids"] == [ln["item_id"] for ln in payable] and body["amount_cents"] == 11800
    result = confirm(client, body).json()
    assert result["status"] == "done" and result["bill_id"] == BILL_ID and result["item_ids"] == body["item_ids"]
    assert "Dry run" in result["message"]


def test_paying_a_bill_without_naming_lines_pays_what_is_not_held(client):
    proposal = client.post(
        "/api/actions/propose", json={"kind": "pay_bill", "bill_id": BILL_ID, "amount_cents": 11800, "from": CHECKING, "payee": PAYEE}
    )
    assert proposal.status_code == 200, proposal.text
    audit, payable, _ = bill_audit(client)
    assert proposal.json()["item_ids"] == [ln["item_id"] for ln in payable]
    whole = client.post(
        "/api/actions/propose", json={"kind": "pay_bill", "bill_id": BILL_ID, "amount_cents": 44300, "from": CHECKING, "payee": PAYEE}
    )
    assert whole.status_code == 409 and "$118.00" in whole.json()["detail"]


def test_bill_payment_must_equal_its_lines(client):
    _, payable, _ = bill_audit(client)
    r = pay_bill(client, payable, amount_cents=12000)
    assert r.status_code == 409
    assert "$118.00" in r.json()["detail"]


def test_held_bill_line_cannot_be_paid(client):
    # The law engine runs on the bill again at payment time, so nothing has to have been audited first.
    _, payable, held = bill_audit(client)
    r = pay_bill(client, payable + held)
    assert r.status_code == 409
    assert "held" in r.json()["detail"]
    assert pay_bill(client, held).status_code == 409


def test_unknown_bill_or_line_cannot_be_paid(client):
    assert pay_bill(client, [{"item_id": "bill:0000000000000000:9", "amount_cents": 500}]).status_code == 404
    unknown_bill = pay_bill(client, [{"item_id": "bill:0000000000000000:9", "amount_cents": 500}], bill_id="b-unknown")
    assert unknown_bill.status_code == 404 and "plain payment" in unknown_bill.json()["detail"]


def test_bill_is_paid_only_from_the_persona_accounts(client):
    _, payable, _ = bill_audit(client)
    r = pay_bill(client, payable, from_account_id="acct-someone-else")
    assert r.status_code == 403


def test_pay_bill_needs_the_bill(client):
    r = client.post("/api/actions/propose", json={**PAYMENT, "kind": "pay_bill"})
    assert r.status_code == 422


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
    view = client.get(f"/api/actions/{action['action_id']}").json()
    assert view["status"] == "failed" and view["error_kind"] == "BankError"
    assert [row["event"] for row in client.get("/api/audit").json()["rows"]] == ["confirmed", "failed"]
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
    assert client.get("/api/audit").json()["rows"][-1]["event"] == "unverified"


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
    # Tagged the way the classifier recognizes Tend's own payments, so it is never offered as a cost.
    assert stored["description"] == f"Payment to {PAYEE} [tend:{action['action_id']}]"
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


def test_audit_table_is_append_only_and_extends_only_its_head(services, client):
    confirm(client, propose(client))
    conn = sqlite3.connect(services.settings.database_url)
    with pytest.raises(sqlite3.DatabaseError, match="append-only"):
        conn.execute("UPDATE audit_log SET event = 'failed' WHERE seq = 1")
    with pytest.raises(sqlite3.DatabaseError, match="append-only"):
        conn.execute("DELETE FROM audit_log")
    with pytest.raises(sqlite3.DatabaseError, match="extend the chain"):
        conn.execute(
            "INSERT INTO audit_log (seq, ts, event, action_id, body, prev_hash, hash) VALUES (3, 't', 'executed', 'a', '{}', ?, ?)",
            ("1" * 64, "2" * 64),
        )
    conn.close()


def test_verify_chain_detects_tampering(services, client):
    confirm(client, propose(client))
    rows = services.repo.audit_rows()
    assert verify_chain(rows)["ok"] is True
    edited = [dict(r) for r in rows]
    edited[1] = {**edited[1], "body": {**edited[1]["body"], "data": {"amount_cents": 1}}}
    assert verify_chain(edited) == {"ok": False, "rows": 2, "broken_at": 2, "reason": "hash does not match the row body"}
    assert verify_chain([rows[1]])["broken_at"] == 2


def test_confirm_code_must_be_ascii_digits(client):
    action = propose(client)
    r = client.post("/api/actions/confirm", json={"action_id": action["action_id"], "confirm_code": "١" * 6})
    assert r.status_code == 422
