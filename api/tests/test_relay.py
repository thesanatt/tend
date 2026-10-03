"""The bank relay: StatementTxn rows for a demo persona, from Nessie or the snapshot, kept nowhere."""

from __future__ import annotations

import dataclasses
import hashlib
import shutil

from helpers import CHECKING, FIXTURES, client_for, make_services

from tend_api.nessie import load_persona_snapshot


def test_statement_rows_follow_the_contract(client):
    data = client.get("/api/bank/rowan-mi/transactions").json()
    assert data["persona_id"] == "rowan-mi" and data["fictional"] is True and "mock bank" in data["notice"]
    assert data["source"] == "snapshot" and data["account"]["id"] == CHECKING and data["account"]["mask"] == "0011"
    assert data["count"] == len(data["txns"]) == 8
    for row in data["txns"]:
        assert {"id", "date", "amount_cents", "description", "origin"} <= set(row)
        assert row["id"].startswith("nessie:") and row["origin"] == "nessie" and isinstance(row["amount_cents"], int)
    payroll = next(r for r in data["txns"] if r["kind"] == "deposit")
    assert payroll["amount_cents"] < 0  # money in is negative; money out is positive
    groceries = next(r for r in data["txns"] if r["id"] == "nessie:p-0001")
    assert groceries["amount_cents"] == 5410 and groceries["merchant"]
    assert [r["date"] for r in data["txns"]] == sorted(r["date"] for r in data["txns"])


def test_dates_filter_inclusively(client):
    rows = client.get("/api/bank/rowan-mi/transactions", params={"from": "2026-06-14", "to": "2026-06-20"}).json()["txns"]
    assert rows and all("2026-06-14" <= r["date"] <= "2026-06-20" for r in rows)
    assert client.get("/api/bank/rowan-mi/transactions", params={"from": "2026-07-01", "to": "2026-06-01"}).status_code == 422
    assert client.get("/api/bank/rowan-mi/transactions", params={"from": "June 1"}).status_code == 422


def test_bills_point_to_their_itemized_document(client):
    [bill] = client.get("/api/bank/rowan-mi/transactions").json()["bills"]
    assert bill["bill_id"] == "b-riverbend-0001" and bill["amount_cents"] == 44300 and bill["itemized"] is True
    doc = client.get(bill["document_path"])
    assert doc.status_code == 200 and b"Riverbend" in doc.content
    assert client.get("/api/bank/rowan-mi/bills/b-unknown/document").status_code == 404


def test_itemized_bills_carry_their_service_date(client):
    # web/lib/local reads documents[].service_date (by bill_id) and counts a ride that day as travel to care,
    # the same anchor /scan takes from the snapshot. Without it the device and the scan disagree on rides.
    data = client.get("/api/bank/rowan-mi/transactions").json()
    [bill] = data["bills"]
    assert bill["service_date"] == "2026-06-14"
    assert data["documents"] == [
        {
            "kind": "itemized_bill",
            "bill_id": "b-riverbend-0001",
            "statement_date": "2026-07-02",
            "service_date": "2026-06-14",
            "due_date": "2026-08-01",
            "total_cents": 44300,
        }
    ]
    assert client.get("/api/bank/rowan-mi/transactions", params={"account": "cushion"}).json()["documents"] == []


def test_a_tampered_bill_document_is_not_served(settings, clock, tmp_path):
    seed = tmp_path / "seed"
    shutil.copytree(FIXTURES / "seed", seed)
    bill = seed / "bills" / "riverbend-2026-06.txt"
    bill.write_text(bill.read_text().replace("Laboratory panel", "Laboratory panel, rush"))
    client = client_for(make_services(dataclasses.replace(settings, seed_dir=seed), clock))
    assert client.get("/api/bank/rowan-mi/bills/b-riverbend-0001/document").status_code == 409


def test_the_savings_account_has_its_own_statement(client):
    data = client.get("/api/bank/rowan-mi/transactions", params={"account": "cushion"}).json()
    assert data["account"]["id"] == "acct-cushion-0001"
    assert data["bills"] == []


def test_unknown_or_malformed_personas(client):
    assert client.get("/api/bank/nobody/transactions").status_code == 404
    assert client.get("/api/bank/..%2Fetc/transactions").status_code in (404, 422)
    assert client.get("/api/bank/Rowan_MI/transactions").status_code == 422


class FakeNessie:
    def __init__(self, fail: bool = False):
        self.fail = fail
        self.closed = False

    def snapshot(self, customer_id, meta=None):
        if self.fail:
            raise TimeoutError("Nessie timed out")
        snap = load_persona_snapshot("rowan-mi", FIXTURES / "seed" / "snapshots")
        payment = dataclasses.replace(
            snap.txns[0],
            id="w-live",
            kind="withdrawal",
            date="2026-10-03",
            amount_cents=11800,
            description="Payment to Riverbend [tend:act_x]",
            merchant_id=None,
        )
        return dataclasses.replace(snap, txns=[*snap.txns, payment], meta=dict(meta or {}))

    def close(self):
        self.closed = True


def test_live_reads_come_from_nessie_and_say_so(settings, clock):
    fake = FakeNessie()
    client = client_for(make_services(dataclasses.replace(settings, relay_live=True), clock, relay_client_factory=lambda: fake))
    data = client.get("/api/bank/rowan-mi/transactions").json()
    assert data["source"] == "live" and data["count"] == 9 and fake.closed
    live = next(r for r in data["txns"] if r["id"] == "nessie:w-live")
    assert live["description"] == "Payment to Riverbend"  # the action tag is not shown...
    assert live["tend_action"] == "act_x"  # ...but the row still says Tend made it
    # so a payment Tend made is never offered back as a cost, here or on the device.
    labels = client.post("/api/ai/classify", json={"consent": True, "txns": data["txns"]}).json()["labels"]
    paid = next(row for row in labels if row["id"] == "nessie:w-live")
    assert paid["candidate"] is False and "Payment made through Tend" in paid["reason"]


def test_live_failure_falls_back_to_the_snapshot(settings, clock):
    client = client_for(
        make_services(dataclasses.replace(settings, relay_live=True), clock, relay_client_factory=lambda: FakeNessie(fail=True))
    )
    data = client.get("/api/bank/rowan-mi/transactions").json()
    assert data["source"] == "snapshot" and data["count"] == 8
    assert "timed out" not in str(data)  # the error text is not relayed

    def no_key():
        raise ValueError("NESSIE_API_KEY is empty")

    client = client_for(make_services(dataclasses.replace(settings, relay_live=True), clock, relay_client_factory=no_key))
    assert client.get("/api/bank/rowan-mi/transactions").json()["source"] == "snapshot"


def database_bytes(path: str) -> str:
    """The database file and its write-ahead log together: a write to either changes this."""
    digest = hashlib.sha256()
    for suffix in ("", "-wal"):
        try:
            with open(path + suffix, "rb") as f:
                digest.update(f.read())
        except FileNotFoundError:
            pass
    return digest.hexdigest()


def test_the_relay_stores_nothing(client, services):
    before = database_bytes(services.settings.database_url)
    for _ in range(3):
        client.get("/api/bank/rowan-mi/transactions")
        client.get("/api/bank/rowan-mi/bills/b-riverbend-0001/document")
    assert database_bytes(services.settings.database_url) == before
