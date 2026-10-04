"""Paying a demo bill ties the payment to the bank's own bill record: the withdrawal names the bill and the
lines it pays, the bill keeps only the held line, named by its rule, and no line is ever paid twice."""

from __future__ import annotations

import sqlite3
import threading
import time

import pytest
from helpers import BILL_ID, CHECKING, client_for, make_services

from tend_api.bank import BankError, DryRunBank
from tend_api.clock import iso
from tend_api.models import ConfirmRequest, ProposeRequest

PAYEE = "Riverbend General Hospital (fictional)"  # the fixture bill's payee
PLAIN = {"from": CHECKING, "payee": PAYEE, "amount_cents": 11800}
HOLD = "$325.00 held under MCL 18.355a(2) (MI-EXAM-1)"


def propose(client, **over):
    r = client.post("/api/actions/propose", json={**PLAIN, **over})
    assert r.status_code == 200, r.text
    return r.json()


def confirm(client, action, code=None):
    return client.post("/api/actions/confirm", json={"action_id": action["action_id"], "confirm_code": code or action["confirm_code"]})


def wrong(code: str) -> str:
    return f"{(int(code) + 1) % 1_000_000:06d}"


def bill_withdrawals(services) -> list[dict]:
    return services.actions.banks["dry_run"].tagged_withdrawals(CHECKING, f"[bill:{BILL_ID}")


def test_a_plain_payment_of_what_is_left_on_a_bill_is_tied_to_it(client):
    p = propose(client)
    assert p["kind"] == "pay_bill" and p["bill_id"] == BILL_ID and len(p["item_ids"]) == 2
    assert p["bill"] == {
        "bill_id": BILL_ID,
        "lines": [1, 2],
        "total_cents": 44300,
        "held_cents": 32500,
        "held_rule_ids": ["MI-EXAM-1", "MI-EXAM-2", "MI-EXAM-3", "MI-EXAM-4", "MI-EXAM-5"],
        "held_note": HOLD,
    }
    done = confirm(client, p).json()
    assert done["status"] == "done" and done["read_back_matches"] is True
    assert done["readback"]["description"] == f"Payment to {PAYEE} [tend:{p['action_id']}] [bill:{BILL_ID}#1,2]"
    assert done["bill"] == {
        "bill_id": BILL_ID,
        "held_cents": 32500,
        "held_rule_ids": ["MI-EXAM-1", "MI-EXAM-2", "MI-EXAM-3", "MI-EXAM-4", "MI-EXAM-5"],
        "total_cents": 44300,
        "ok": True,
        "updated": True,
        "checks": {"amount": True, "status": True, "nickname": True},
        "status": "pending",
        "amount_cents": 32500,
        "paid_cents": 11800,
    }
    assert done["message"].startswith("Paid $118.00 to Riverbend General Hospital (fictional).")
    assert f"now shows $325.00 left: the {HOLD}. Tend will not pay it." in done["message"]


def test_the_bill_keeps_the_held_line_and_names_its_rule(client, services):
    confirm(client, propose(client))
    bill = services.actions.banks["dry_run"].read_bill(BILL_ID)
    assert bill == {
        "id": BILL_ID,
        "amount_cents": 32500,
        "status": "pending",
        "nickname": f"Riverbend General statement: {HOLD}. Do not pay.",
    }


def test_the_payee_is_matched_without_regard_to_case_or_spacing(client):
    p = propose(client, payee="riverbend  general hospital (FICTIONAL)")
    assert p["bill_id"] == BILL_ID


def test_a_payment_that_is_not_what_the_bill_has_left_stays_plain(client):
    assert propose(client, amount_cents=5000)["kind"] == "payment"
    assert propose(client, **{"from": "acct-cushion-0001"})["kind"] == "payment"  # the bill is on checking
    assert propose(client, payee="Someone Else (fictional)")["kind"] == "payment"


def test_paying_the_whole_bill_is_refused_because_of_the_held_line(client):
    r = client.post("/api/actions/propose", json={**PLAIN, "amount_cents": 44300})
    assert r.status_code == 409
    assert HOLD in r.json()["detail"] and "The rest of the bill is $118.00." in r.json()["detail"]


def test_a_bills_lines_are_never_paid_twice(client, services):
    first = confirm(client, propose(client)).json()
    assert first["status"] == "done"
    again = client.post("/api/actions/propose", json=PLAIN)
    assert again.status_code == 409 and "already paid" in again.json()["detail"]
    assert first["withdrawal_id"] in again.json()["detail"]
    explicit = client.post("/api/actions/propose", json={**PLAIN, "kind": "pay_bill", "bill_id": BILL_ID})
    assert explicit.status_code == 409
    audit = client.post("/api/bill/audit", json={"bill_id": BILL_ID, "persona_id": "rowan-mi"}).json()
    line_one = audit["lines"][0]
    one = client.post(
        "/api/actions/propose",
        json={**PLAIN, "bill_id": BILL_ID, "item_ids": [line_one["item_id"]], "amount_cents": line_one["amount_cents"]},
    )
    assert one.status_code == 409  # line 1 was part of the first payment
    assert len(bill_withdrawals(services)) == 1


def test_two_proposals_for_one_bill_pay_it_once(client, services):
    a, b = propose(client), propose(client)
    assert confirm(client, a).json()["status"] == "done"
    r = confirm(client, b)
    assert r.status_code == 409 and "already paid" in r.json()["detail"] and "Nothing moved" in r.json()["detail"]
    view = client.get(f"/api/actions/{b['action_id']}").json()
    assert view["status"] == "failed" and view["error_kind"] == "already_paid"
    assert [row["event"] for row in view["audit"]] == ["confirmed", "failed"]
    assert len(bill_withdrawals(services)) == 1


class SlowBank(DryRunBank):
    def withdraw(self, account_id, amount_cents, description, on_date):
        time.sleep(0.05)
        return super().withdraw(account_id, amount_cents, description, on_date)


def test_two_proposals_confirmed_at_once_pay_once(settings, clock):
    services = make_services(settings, clock, banks={"dry_run": SlowBank()})
    proposals = [services.actions.propose(ProposeRequest.model_validate(PLAIN)) for _ in range(2)]
    barrier = threading.Barrier(2)
    outcomes: list[str] = []

    def attempt(p):
        barrier.wait()
        try:
            outcomes.append(services.actions.confirm(ConfirmRequest(action_id=p["action_id"], confirm_code=p["confirm_code"]))["status"])
        except Exception as exc:  # noqa: BLE001
            outcomes.append(f"{type(exc).__name__}:{getattr(exc, 'status_code', '')}")

    threads = [threading.Thread(target=attempt, args=(p,)) for p in proposals]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(outcomes) == ["ActionError:409", "done"]
    assert len(bill_withdrawals(services)) == 1


def test_a_confirm_sent_again_gets_the_first_result(client, services):
    p = propose(client)
    first = confirm(client, p).json()
    again = confirm(client, p)
    assert again.status_code == 200
    body = again.json()
    assert body["replayed"] is True and body["status"] == "done"
    assert (body["withdrawal_id"], body["audit_id"], body["bill"]) == (first["withdrawal_id"], first["audit_id"], first["bill"])
    assert body["message"].startswith("Paid $118.00 earlier. Nothing moved this time.")
    assert len(bill_withdrawals(services)) == 1
    assert [r["event"] for r in client.get("/api/audit").json()["rows"]] == ["confirmed", "executed"]
    assert confirm(client, p, code=wrong(p["confirm_code"])).status_code == 409


class LateBank(DryRunBank):
    """The write lands, but no answer comes back, and the first look in the bank does not show it yet."""

    def __init__(self):
        super().__init__()
        self.lookups = 0

    def withdraw(self, account_id, amount_cents, description, on_date):
        super().withdraw(account_id, amount_cents, description, on_date)
        raise BankError("read timed out", maybe_applied=True)

    def find_withdrawal(self, account_id, marker):
        self.lookups += 1
        return None if self.lookups == 1 else super().find_withdrawal(account_id, marker)


def test_a_payment_that_landed_without_an_answer_is_found_when_confirmed_again(settings, clock):
    bank = LateBank()
    client = client_for(make_services(settings, clock, banks={"dry_run": bank}))
    p = propose(client)
    first = confirm(client, p)
    assert first.status_code == 502 and "may have gone through" in first.json()["detail"]
    again = confirm(client, p)
    assert again.status_code == 200, again.text
    body = again.json()
    assert body["status"] == "done" and body["replayed"] is True and body["bill"]["ok"] is True
    assert [r["event"] for r in client.get("/api/audit").json()["rows"]] == ["confirmed", "unverified", "executed"]
    assert len(bank.tagged_withdrawals(CHECKING, "[tend:")) == 1  # found, never sent twice


def test_a_payment_whose_process_went_away_is_looked_up_after_a_minute(client, services, clock):
    p = propose(client)
    services.repo.transition_action(p["action_id"], "proposed", "executing", {"confirmed_at": iso(clock())})
    busy = confirm(client, p)
    assert busy.status_code == 409 and "being sent now" in busy.json()["detail"]
    clock.advance(seconds=61)
    gone = confirm(client, p)
    assert gone.status_code == 409 and "shows no payment labeled" in gone.json()["detail"]
    view = client.get(f"/api/actions/{p['action_id']}").json()
    assert view["status"] == "unverified" and view["error_kind"] == "no_answer"
    assert confirm(client, p).status_code == 409
    assert bill_withdrawals(services) == []  # nothing was sent in its place


class StubbornBank(DryRunBank):
    def update_bill(self, bill_id, **fields):
        raise BankError("Nessie PUT /bills -> 400")


def test_a_bill_update_the_bank_refuses_is_reported(settings, clock):
    client = client_for(make_services(settings, clock, banks={"dry_run": StubbornBank()}))
    done = confirm(client, propose(client)).json()
    assert done["status"] == "done"  # the money moved and read back
    assert done["bill"]["ok"] is False and done["bill"]["error_kind"] == "BankError"
    assert "did not take the bill update" in done["message"]
    assert client.get("/api/audit").json()["rows"][-1]["data"]["bill_updated"] is False


def test_editing_the_stored_payee_breaks_the_code(client, services):
    p = propose(client)
    conn = sqlite3.connect(services.settings.database_url)
    conn.execute("UPDATE pending_actions SET payee = 'Someone Else' WHERE action_id = ?", (p["action_id"],))
    conn.commit()
    conn.close()
    assert confirm(client, p).status_code == 403


def test_what_is_stored_names_no_one(client, services):
    p = propose(client)
    confirm(client, p)
    row = services.repo.get_action(p["action_id"])
    assert row["readback"]["bill"]["amount_cents"] == 32500
    assert "Riverbend" not in str(row) and "statement" not in str(row)
    for r in services.repo.audit_rows():
        assert "Riverbend" not in str(r["body"])
    assert services.repo.audit_rows(p["action_id"])[-1]["data"]["bill_id"] == BILL_ID


@pytest.mark.parametrize("amount", [7500, 4300])
def test_one_line_at_a_time_pays_each_once(client, services, amount):
    audit = client.post("/api/bill/audit", json={"bill_id": BILL_ID, "persona_id": "rowan-mi"}).json()
    line = next(ln for ln in audit["lines"] if ln["amount_cents"] == amount)
    body = {**PLAIN, "bill_id": BILL_ID, "item_ids": [line["item_id"]], "amount_cents": amount}
    done = confirm(client, propose(client, **body)).json()
    assert done["bill"]["amount_cents"] == 44300 - amount and done["bill"]["status"] == "pending"
    other = next(ln for ln in audit["lines"] if ln["status"] != "held" and ln["item_id"] != line["item_id"])
    second = confirm(client, propose(client, **{**body, "item_ids": [other["item_id"]], "amount_cents": other["amount_cents"]})).json()
    assert second["bill"]["amount_cents"] == 32500 and second["bill"]["paid_cents"] == 11800
    assert client.post("/api/actions/propose", json=body).status_code == 409
