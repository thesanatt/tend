"""The bank activity panel's data: Nessie's records for a demo persona, reconciled, and only fictional ones shown."""

from __future__ import annotations

import dataclasses
import json

from helpers import BILL_ID, CHECKING, client_for, make_services

from tend_api.nessie import BankSnapshot, NessieCall, Txn, load_persona_snapshot

URL = "/api/bank/rowan-mi/activity"
ACTION = "act_" + "a" * 20
HOLD = "$325.00 held under MCL 18.355a(2) (MI-EXAM-1)"


class FakeLive:
    """What NessieClient.snapshot returns for the persona, with the calls it made."""

    def __init__(self, snapshot: BankSnapshot, fail: bool = False):
        self.snap = snapshot
        self.fail = fail
        self.calls = [NessieCall("GET", "/customers/cust-rowan-0001/accounts", 200, 81, 2)]
        self.closed = False

    def snapshot(self, customer_id, meta=None):
        if self.fail:
            raise ConnectionError("venue wifi")
        return self.snap

    def close(self):
        self.closed = True


def saved(settings) -> BankSnapshot:
    return load_persona_snapshot("rowan-mi", settings.seed_dir / "snapshots")


def after_the_demo(settings) -> BankSnapshot:
    """The persona's bank after a demo run, plus a record someone else's key wrote to the account."""
    snap = saved(settings)
    w = Txn(
        "w-tend",
        "withdrawal",
        CHECKING,
        "2026-10-03",
        11800,
        "completed",
        f"Payment to Riverbend General Hospital (fictional) [tend:{ACTION}] [bill:{BILL_ID}#1,2]",
        "balance",
    )
    d = Txn(
        "d-payout",
        "deposit",
        CHECKING,
        "2026-10-03",
        400800,
        "completed",
        "Michigan Crime Victim Compensation demo payment (fictional) [tend:payout-MI]",
        "balance",
    )
    foreign = Txn("x-1", "purchase", CHECKING, "2026-10-02", 2500, "completed", "Jordan Smith real purchase", "balance", "m-x")
    elsewhere = Txn(
        "w-2", "withdrawal", CHECKING, "2026-10-03", 500, "completed", f"Payment to Jordan Smith [tend:{'act_' + 'b' * 20}]", "balance"
    )
    bill = dataclasses.replace(snap.bills[0], amount_cents=32500, nickname=f"Riverbend General statement: {HOLD}. Do not pay.")
    return dataclasses.replace(snap, txns=[*snap.txns, w, d, foreign, elsewhere], bills=[bill])


def live_client(settings, clock, fake):
    live = dataclasses.replace(settings, relay_live=True)
    return client_for(make_services(live, clock, relay_client_factory=lambda: fake))


def test_from_the_snapshot_every_record_is_shown_and_the_ledger_adds_up(client, settings):
    body = client.get(URL).json()
    assert body["source"] == "snapshot" and body["calls"] == [] and body["fictional"] is True
    assert body["hidden_count"] == 0 and body["tend_writes"] == []
    assert sum(len(v) for v in body["records"].values()) == 8
    checking = next(a for a in body["accounts"] if a["id"] == CHECKING)
    assert checking["nessie_balance_cents"] == 285000 and checking["mask"] == "0011"
    ledger = checking["ledger"]
    # $2,850.00 opening + $412.00 payroll - $878.60 of purchases. (The fixture file's own "balances" figure is stale.)
    assert ledger["reconciled"] is True and ledger["computed_cents"] == saved(settings).balance_cents(CHECKING) == 238340
    terms = {t["key"]: (t["count"], t["cents"]) for t in ledger["terms"]}
    assert terms["deposits"] == (1, 41200) and terms["purchases"] == (7, 87860)
    [bill] = body["bills"]
    assert (bill["amount_cents"], bill["status"], bill["paid_cents"], bill["expected_cents"]) == (44300, "pending", 0, 44300)
    assert bill["reconciled"] is True and bill["held"]["note"] == HOLD
    assert bill["held"]["rule_ids"][0] == "MI-EXAM-1"


def test_live_it_shows_tends_writes_reconciles_the_bill_and_lists_the_calls(settings, clock):
    fake = FakeLive(after_the_demo(settings))
    body = live_client(settings, clock, fake).get(URL).json()
    assert body["source"] == "live" and fake.closed
    assert body["calls"] == [{"method": "GET", "path": "/customers/cust-rowan-0001/accounts", "status": 200, "ms": 81, "count": 2}]
    writes = {r["id"]: r for r in body["tend_writes"]}
    assert writes["w-tend"]["tend"] == {
        "what": "payment",
        "payee": "Riverbend General Hospital (fictional)",
        "action_id": ACTION,
        "bill_id": BILL_ID,
        "bill_lines": [1, 2],
    }
    assert writes["d-payout"]["tend"] == {"what": "demo_payout", "program": "Michigan Crime Victim Compensation", "st": "MI"}
    [bill] = body["bills"]
    assert bill["payments"] == [
        {"withdrawal_id": "w-tend", "date": "2026-10-03", "amount_cents": 11800, "action_id": ACTION, "lines": [1, 2]}
    ]
    assert (bill["paid_cents"], bill["expected_cents"], bill["amount_cents"]) == (11800, 32500, 32500)
    assert bill["reconciled"] is True and bill["nickname"] == f"Riverbend General statement: {HOLD}. Do not pay."
    checking = next(a for a in body["accounts"] if a["id"] == CHECKING)
    assert checking["ledger"]["reconciled"] is True
    assert checking["ledger"]["computed_cents"] == 238340 - 11800 + 400800 - 2500 - 500


def test_records_that_are_not_demo_data_are_counted_and_never_shown(settings, clock):
    body = live_client(settings, clock, FakeLive(after_the_demo(settings))).get(URL).json()
    assert body["hidden_count"] == 1  # the foreign purchase
    text = json.dumps(body)
    assert "Jordan" not in text and "Smith" not in text and "x-1" not in text
    other = next(r for r in body["tend_writes"] if r["id"] == "w-2")
    assert other["tend"]["payee"] is None and other["description"] is None
    checking = next(a for a in body["accounts"] if a["id"] == CHECKING)
    assert checking["not_shown"] == 1


def test_a_changed_bill_nickname_is_flagged_not_shown(settings, clock):
    snap = after_the_demo(settings)
    snap = dataclasses.replace(snap, bills=[dataclasses.replace(snap.bills[0], nickname="Call Jordan at home")])
    body = live_client(settings, clock, FakeLive(snap)).get(URL).json()
    [bill] = body["bills"]
    assert bill["nickname"] is None and bill["nickname_changed"] is True and "Jordan" not in json.dumps(body)


def test_when_nessie_does_not_answer_it_says_so_and_shows_the_snapshot(settings, clock):
    body = live_client(settings, clock, FakeLive(after_the_demo(settings), fail=True)).get(URL).json()
    assert body["source"] == "snapshot" and body["source_error"] == "ConnectionError"
    assert body["tend_writes"] == [] and body["bills"][0]["amount_cents"] == 44300


def test_a_dry_run_payment_is_listed_without_its_words(client):
    p = client.post(
        "/api/actions/propose", json={"from": CHECKING, "payee": "Riverbend General Hospital (fictional)", "amount_cents": 11800}
    ).json()
    client.post("/api/actions/confirm", json={"action_id": p["action_id"], "confirm_code": p["confirm_code"]})
    body = client.get(URL).json()
    kinds = sorted(r["kind"] for r in body["dry_run_writes"])
    assert kinds == ["bill", "withdrawal"]
    assert "Riverbend" not in json.dumps(body["dry_run_writes"])


def test_unknown_persona_is_404(client):
    assert client.get("/api/bank/nobody/activity").status_code == 404
