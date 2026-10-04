"""The demo's Nessie traffic, replayed from answers recorded on live Nessie (seed/cassettes). No network.

seed/record_cassettes.py drove this same API against Capital One's Nessie with a fixed clock and action id and
kept every exchange. Here the API runs again on the real corpus, the real seed, and the Python reference engine,
and each request must be one Nessie answered: the exact path and body. A request with no recording fails the
test, so these also show that a confirm sent again, or a second proposal, sends nothing.
"""

from __future__ import annotations

import datetime as dt
import secrets
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tend_api.app import create_app
from tend_api.bank import DryRunBank, NessieBank
from tend_api.config import API_DIR, Settings
from tend_api.nessie import NessieClient
from tend_api.nessie_cassette import Cassette
from tend_api.services import build_services

REPO = API_DIR.parent
CASSETTES = REPO / "seed" / "cassettes"
HOLD_NICKNAME = "Riverbend General statement: $325.00 held under MCL 18.355a(2) (MI-EXAM-1). Do not pay."

pytestmark = pytest.mark.skipif(not (REPO / "refengine").is_dir(), reason="needs the Python reference engine in refengine/")


def settings_for(tmp: Path) -> Settings:
    # The same settings seed/record_cassettes.py records with.
    return Settings(
        rules_dir=REPO / "rules" / "verified",
        seed_dir=REPO / "seed",
        engine_lib=tmp / "no-native-engine",
        law_dirs=(tmp / "no-laws",),
        tendc=tmp / "no-tendc",
        refengine_dir=REPO / "refengine",
        forms_dir=API_DIR / "forms",
        cache_dir=tmp / "cache",
        database_url=str(tmp / "tend.sqlite3"),
        bank_mode="nessie",
        relay_live=True,
        secret_hex="ab" * 32,
        ir_dir=REPO / "rules" / "ir",
        autoload_corpus=False,
    )


@pytest.fixture
def replay(tmp_path, monkeypatch):
    def make(name: str) -> tuple[Cassette, TestClient, dict]:
        cassette = Cassette.load(CASSETTES / f"{name}.json")
        ctx = cassette.context
        monkeypatch.setattr(secrets, "token_hex", lambda nbytes=None: ctx["action_hex"])
        now = dt.datetime.fromisoformat(ctx["now"])

        def client() -> NessieClient:
            return NessieClient("test-key", "https://api.nessieisreal.com", transport=cassette.transport())

        services = build_services(
            settings_for(tmp_path),
            clock=lambda: now,
            banks={"dry_run": DryRunBank(), "nessie": NessieBank(client())},
            relay_client_factory=client,
        )
        return cassette, TestClient(create_app(services=services)), ctx

    return make


def all_used(cassette: Cassette) -> None:
    assert cassette.unmatched == [], cassette.unmatched
    assert cassette.unused() == [], cassette.unused()


def test_the_bill_payment_sends_exactly_what_nessie_answered(replay):
    cassette, api, ctx = replay("pay-bill")
    pay = {"from": ctx["checking"], "payee": "Riverbend General Hospital", "amount_cents": 11800}
    proposal = api.post("/api/actions/propose", json=pay).json()
    assert proposal["kind"] == "pay_bill" and proposal["bill_id"] == ctx["bill_id"] and proposal["bill"]["lines"] == [1, 3]
    done = api.post("/api/actions/confirm", json={"action_id": proposal["action_id"], "confirm_code": proposal["confirm_code"]}).json()
    assert done["status"] == "done" and done["read_back_matches"] is True
    assert done["message"] == ctx["message"]
    assert (done["bill"]["amount_cents"], done["bill"]["status"], done["bill"]["ok"]) == (32500, "pending", True)
    again = api.post("/api/actions/confirm", json={"action_id": proposal["action_id"], "confirm_code": proposal["confirm_code"]}).json()
    assert again["replayed"] is True and again["withdrawal_id"] == done["withdrawal_id"]
    assert api.post("/api/actions/propose", json=pay).status_code == 409
    all_used(cassette)
    assert cassette.count("POST") == 1 and cassette.count("PUT") == 1  # one withdrawal, one bill update


def test_nessie_took_the_withdrawal_tied_to_the_bill_and_the_held_note(replay):
    cassette, _, ctx = replay("pay-bill")
    [post] = [ex for ex in cassette.exchanges if ex["method"] == "POST"]
    assert post["body"]["amount"] == 118 and post["status"] == 201
    assert post["body"]["description"].endswith(f"[tend:act_{ctx['action_hex']}] [bill:{ctx['bill_id']}#1,3]")
    [put] = [ex for ex in cassette.exchanges if ex["method"] == "PUT"]
    assert put["body"] == {"status": "pending", "payment_amount": 325, "nickname": HOLD_NICKNAME}
    assert put["status"] == 202 and put["response"]["objectUpdated"]["payment_amount"] == 325
    after = [ex for ex in cassette.exchanges if ex["method"] == "GET" and ex["path"] == f"/bills/{ctx['bill_id']}"][-1]
    assert (after["response"]["payment_amount"], after["response"]["nickname"]) == (325, HOLD_NICKNAME)


def test_the_demo_payout_replays(replay):
    cassette, api, ctx = replay("payout")
    url = "/api/bank/rowan-mi/payout"
    first = api.post(url, json={"st": "MI", "amount_cents": 400800}).json()
    assert first["read_back_matches"] is True and first["amount_cents"] == 400800 and not first["dry_run"]
    assert api.post(url, json={"st": "MI", "amount_cents": 400800}).json()["deposit_id"] == first["deposit_id"]
    assert api.delete(url).json()["deleted"] == [first["deposit_id"]]
    second = api.post(url, json={"st": "MI", "amount_cents": 400800}).json()
    assert second["message"] == ctx["message"]
    all_used(cassette)
    deposit = next(ex for ex in cassette.exchanges if ex["method"] == "POST")
    assert deposit["body"]["amount"] == 4008
    assert deposit["body"]["description"] == "Michigan Crime Victim Compensation demo payment (fictional) [tend:payout-MI]"


def test_the_activity_view_reconciles_nessies_records(replay):
    cassette, api, ctx = replay("activity")
    body = api.get("/api/bank/rowan-mi/activity").json()
    all_used(cassette)
    assert body["source"] == "live" and len(body["calls"]) == 13 and body["hidden_count"] == 0
    assert sum(len(v) for v in body["records"].values()) == 192  # the 190 seeded records and Tend's two writes
    checking = next(a for a in body["accounts"] if a["id"] == ctx["checking"])
    assert checking["nessie_balance_cents"] == 285000
    assert checking["ledger"]["reconciled"] is True
    assert checking["ledger"]["computed_cents"] == 80300 - 11800 + 400800  # the demo start, the payment, the deposit
    [bill] = body["bills"]
    assert (bill["paid_cents"], bill["expected_cents"], bill["amount_cents"], bill["reconciled"]) == (11800, 32500, 32500, True)
    assert bill["nickname"] == HOLD_NICKNAME and bill["held"]["rule_ids"][0] == "MI-EXAM-1"
    assert sorted(r["tend"]["what"] for r in body["tend_writes"]) == ["demo_payout", "payment"]
