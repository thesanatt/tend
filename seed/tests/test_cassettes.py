"""The reset and the Nessie client, replayed from answers recorded on live Nessie (seed/cassettes). No network."""
from pathlib import Path

import pytest

import reset_demo
from tend_api.nessie import NessieClient, parse_bill, parse_txn
from tend_api.nessie_cassette import Cassette

CASSETTES = Path(__file__).resolve().parents[1] / "cassettes"


def replayed(name: str) -> tuple[Cassette, NessieClient]:
    cassette = Cassette.load(CASSETTES / f"{name}.json")
    return cassette, NessieClient("test-key", "https://api.nessieisreal.com", transport=cassette.transport())


def test_the_recorded_reset_undoes_the_demo_and_checks_the_snapshot():
    cassette, client = replayed("reset")
    with client:
        report = reset_demo.reset(client, "rowan-mi")
    assert cassette.unmatched == [] and cassette.unused() == []
    assert report.ok and not report.ids_changed
    assert report.changes == cassette.context["changes"]
    assert [c.split(" ")[0] for c in report.changes] == ["deleted", "deleted", "restored"]
    assert report.bill == "pending $443.00" and report.records == 190
    assert report.balances == {"Checking": 803_00, "Cushion": 590_00}
    # Exactly three writes undo a demo run: two deletes and the bill put back in place.
    assert (cassette.count("DELETE"), cassette.count("PUT"), cassette.count("POST")) == (2, 1, 0)


def test_the_client_reads_nessies_real_answers():
    cassette, _ = replayed("pay-bill")
    post = next(ex for ex in cassette.exchanges if ex["method"] == "POST")
    created = parse_txn("withdrawal", post["response"]["objectCreated"], cassette.context["checking"])
    assert created.amount_cents == 118_00 and created.bill_ref == (cassette.context["bill_id"], (1, 3))
    assert created.tend_action == f"act_{cassette.context['action_hex']}"
    assert created.display_description == "Payment to Riverbend General Hospital"
    put = next(ex for ex in cassette.exchanges if ex["method"] == "PUT")
    bill = parse_bill(put["response"]["objectUpdated"])
    assert (bill.status, bill.amount_cents, bill.upcoming_payment_date) == ("pending", 325_00, "2026-10-20")


@pytest.mark.parametrize("name", ["pay-bill", "payout", "activity", "reset"])
def test_cassettes_hold_only_fictional_data_and_no_key(name):
    cassette = Cassette.load(CASSETTES / f"{name}.json")
    text = (CASSETTES / f"{name}.json").read_text()
    assert "key=" not in text and "api_key" not in text.lower()
    assert cassette.context["persona"] == "rowan-mi"
    for ex in cassette.exchanges:
        if ex["path"] == "/customers":
            assert {(c["first_name"], c["last_name"]) for c in ex["response"]} <= {("Rowan", "Hale"), ("Spike", "Probe")}
