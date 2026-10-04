"""The demo of the program paying: one labeled deposit into a fictional persona's checking account, read back."""

from __future__ import annotations

import dataclasses
import json
import shutil

from helpers import CHECKING, client_for, make_services

from tend_api.bank import BankError, DryRunBank, NessieBank

URL = "/api/bank/rowan-mi/payout"
PROGRAM = "Michigan Crime Victim Compensation"


class FakeDepositClient:
    """The NessieClient calls the payout makes. Nessie keeps whole dollars and gives deposits no account field."""

    def __init__(self):
        self.deposits: dict[str, dict] = {}
        self.posts = 0

    def create_deposit(self, account_id, *, amount_cents, date, description, status="completed", medium="balance"):
        if amount_cents % 100:
            raise ValueError("Nessie stores whole dollars")
        self.posts += 1
        did = f"nessie-d-{self.posts}"
        self.deposits[did] = {
            "account": account_id,
            "_id": did,
            "transaction_date": str(date),
            "amount": amount_cents // 100,
            "description": description,
            "status": status,
        }
        return {"_id": did}

    def find_txns(self, account_id, kind, marker):
        assert kind == "deposit"
        return [self._public(d) for d in self.deposits.values() if d["account"] == account_id and marker in d["description"]]

    def get_txn(self, kind, txn_id, account_id=None):
        return self._public(self.deposits[txn_id])

    def delete_txn(self, kind, txn_id):
        self.deposits.pop(txn_id, None)

    @staticmethod
    def _public(d):
        return {k: v for k, v in d.items() if k != "account"}


def live(settings, clock, nessie):
    return client_for(
        make_services(
            dataclasses.replace(settings, bank_mode="nessie"), clock, banks={"dry_run": DryRunBank(), "nessie": NessieBank(nessie)}
        )
    )


def test_a_dry_run_records_the_demo_deposit_here_only(client):
    r = client.post(URL, json={"st": "MI", "amount_cents": 400800})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dry_run"] is True and body["amount_cents"] == 400800 and body["program"] == PROGRAM
    assert body["readback"] == {"ok": True, "checks": {"id": True, "amount": True, "tagged": True, "account": True}}
    assert body["account"] == {"id": CHECKING, "nickname": "Checking", "mask": "0011"}
    assert body["fictional"] is True and body["replayed"] is False
    assert "here only" in body["message"] and body["message"].endswith("The program decides what it pays, and when.")


def test_the_same_demo_payment_again_is_the_same_deposit(client):
    first = client.post(URL, json={"st": "MI", "amount_cents": 400800}).json()
    again = client.post(URL, json={"st": "MI", "amount_cents": 400800}).json()
    assert again["deposit_id"] == first["deposit_id"] and again["replayed"] is True


def test_a_different_amount_replaces_the_earlier_demo_deposit(client, services):
    # A device cleared without its undo must not leave the demo stuck behind the old deposit.
    first = client.post(URL, json={"st": "MI", "amount_cents": 400800}).json()
    other = client.post(URL, json={"st": "MI", "amount_cents": 120000})
    assert other.status_code == 200, other.text
    body = other.json()
    assert body["replaced"] == [first["deposit_id"]] and body["deposit_id"] != first["deposit_id"]
    assert body["read_back_matches"] is True and "It replaces an earlier demo deposit." in body["message"]
    bank = services.actions.banks["dry_run"]
    [left] = bank.tagged_deposits(body["account"]["id"], "[tend:payout")
    assert (left["id"], left["amount_cents"]) == (body["deposit_id"], 120000)
    undone = client.delete(URL).json()
    assert undone["deleted"] == [body["deposit_id"]] and undone["message"] == "Removed the demo deposit."
    assert client.post(URL, json={"st": "MI", "amount_cents": 120000}).status_code == 200
    assert client.delete(URL).json()["deleted"] and client.delete(URL).json() == {
        "deleted": [],
        "dry_run": True,
        "message": "There was no demo deposit to remove.",
    }


def test_live_it_is_a_nessie_deposit_in_whole_dollars(settings, clock):
    nessie = FakeDepositClient()
    client = live(settings, clock, nessie)
    body = client.post(URL, json={"st": "mi", "amount_cents": 400850}).json()
    assert body["dry_run"] is False and body["amount_cents"] == 400800 and body["requested_cents"] == 400850
    assert body["read_back_matches"] is True and body["date"] == "2026-10-03"
    stored = nessie.deposits[body["deposit_id"]]
    assert stored["amount"] == 4008 and stored["account"] == CHECKING
    assert stored["description"] == f"{PROGRAM} demo payment (fictional) [tend:payout-MI]"
    assert "Nessie recorded a deposit of $4,008.00" in body["message"]
    assert "Nessie keeps whole dollars, so it is $4,008.00; the claim is $4,008.50." in body["message"]
    assert client.post(URL, json={"st": "MI", "amount_cents": 400850}).json()["replayed"] is True
    assert nessie.posts == 1
    assert client.delete(URL).json()["deleted"] == [body["deposit_id"]] and nessie.deposits == {}


class LostAnswerBank(DryRunBank):
    def deposit(self, account_id, amount_cents, description, on_date):
        super().deposit(account_id, amount_cents, description, on_date)
        raise BankError("read timed out", maybe_applied=True)


def test_a_deposit_that_landed_without_an_answer_is_found_by_its_tag(settings, clock):
    bank = LostAnswerBank()
    client = client_for(make_services(settings, clock, banks={"dry_run": bank}))
    body = client.post(URL, json={"st": "MI", "amount_cents": 400800})
    assert body.status_code == 200 and body.json()["read_back_matches"] is True
    assert len(bank.tagged_deposits(CHECKING, "[tend:payout")) == 1


def test_it_refuses_what_is_not_a_claimable_amount_or_a_demo_persona(client, settings, clock, tmp_path):
    assert client.post(URL, json={"st": "MI", "amount_cents": 4_500_001}).status_code == 422  # over Michigan's cap
    assert client.post(URL, json={"st": "ZZ", "amount_cents": 1000}).status_code == 404
    assert client.post(URL, json={"st": "MI", "amount_cents": 0}).status_code == 422
    assert client.post(URL, json={"st": "MI", "amount_cents": 10.5}).status_code == 422
    assert client.post("/api/bank/nobody/payout", json={"st": "MI", "amount_cents": 1000}).status_code == 404
    seed = tmp_path / "seed"
    shutil.copytree(settings.seed_dir, seed)
    path = seed / "snapshots" / "rowan-mi.json"
    snap = json.loads(path.read_text())
    snap["meta"]["fictional"] = False
    path.write_text(json.dumps(snap))
    real = client_for(make_services(dataclasses.replace(settings, seed_dir=seed), clock))
    assert real.post(URL, json={"st": "MI", "amount_cents": 1000}).status_code == 403
    assert real.get("/api/bank/rowan-mi/activity").status_code == 403
