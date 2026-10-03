import json

import pytest

from history import ACCOUNTS, MERCHANTS, build_history
from personas import PERSONAS
from seeder import Seeder, labels_for, take_snapshot, verify_against_plan
from tend_api.nessie import NessieListCorrupt

QUIET = {"log": lambda message: None}


@pytest.fixture
def seeded(client):
    persona = PERSONAS["rowan-mi"]
    seeder = Seeder(client, persona, **QUIET)
    return persona, seeder.run(), seeder.stats


def test_fresh_seed_builds_the_planned_world(client, seeded, tmp_path):
    persona, manifest, stats = seeded
    history = build_history()
    assert stats.created == 1 + len(ACCOUNTS) + len(MERCHANTS) + len(history) + 1
    assert stats.deleted == 0
    assert set(manifest["records"]) == {p.key for p in history}
    snapshot = take_snapshot(client, persona, root=tmp_path)
    assert verify_against_plan(snapshot) == []
    assert len(labels_for(snapshot)) == len(history)


def test_reseeding_is_a_no_op(client, fake, seeded):
    persona, manifest, _ = seeded
    posts = fake.count("POST")
    again = Seeder(client, persona, **QUIET)
    assert again.run()["records"] == manifest["records"]
    assert (again.stats.created, again.stats.updated, again.stats.deleted) == (0, 0, 0)
    assert fake.count("POST") == posts


def test_reset_undoes_demo_writes(client, seeded):
    persona, manifest, _ = seeded
    checking, cushion = manifest["accounts"]["checking"], manifest["accounts"]["cushion"]
    bill_id = manifest["bill"]["riverbend"]
    client.create_withdrawal(checking, amount_cents=118_00, date="2026-10-03", description="Riverbend [tend:demo]")
    client.update_bill(bill_id, status="completed", amount_cents=325_00)
    client.create_deposit(cushion, amount_cents=1_000_00, date="2026-10-03", description="demo state payment")
    reset = Seeder(client, persona, **QUIET)
    reset.run()
    assert (reset.stats.created, reset.stats.updated, reset.stats.deleted) == (0, 1, 2)
    bill = client.get_bill(bill_id)
    assert (bill.status, bill.amount_cents) == ("pending", 443_00)
    assert client.find_txns(checking, "withdrawal", "[tend:demo]") == []
    assert client.list_txns(cushion, "deposit") == []


def test_deleted_records_come_back(client, seeded):
    persona, manifest, _ = seeded
    client.delete_txn("purchase", manifest["records"]["purchase-001"])
    client.delete_bill(manifest["bill"]["riverbend"])
    again = Seeder(client, persona, **QUIET)
    again.run()
    assert (again.stats.created, again.stats.deleted) == (2, 0)


def test_unusable_bill_is_replaced(client, fake, seeded):
    persona, manifest, _ = seeded
    bill_id = manifest["bill"]["riverbend"]
    del fake.records["bill"][bill_id][1]["recurring_date"]
    del fake.records["bill"][bill_id][1]["upcoming_payment_date"]
    fake.records["bill"][bill_id][1]["payment_date"] = "2026-10-20"
    with pytest.raises(NessieListCorrupt):
        client.list_bills(manifest["accounts"]["checking"])  # the broken bill poisons the list
    # The seeder can only repair what it can list, so it needs the bad record gone first.
    client.delete_bill(bill_id)
    again = Seeder(client, persona, **QUIET)
    assert again.run()["bill"]["riverbend"] != bill_id


def test_wrong_opening_balance_rebuilds_the_account(client, fake, seeded, tmp_path):
    persona, manifest, _ = seeded
    old = manifest["accounts"]["cushion"]
    fake.accounts[old]["balance"] = 5
    rebuilt = Seeder(client, persona, **QUIET).run()
    assert rebuilt["accounts"]["cushion"] != old
    assert old not in fake.accounts
    # Its records went with it, and transfers that named it as payee were rewritten.
    assert all(account != old for kind in fake.records.values() for account, _ in kind.values())
    assert verify_against_plan(take_snapshot(client, persona, root=tmp_path)) == []


def test_each_persona_gets_its_own_merchants(client, fake):
    for pid in ("rowan-mi", "rowan-tx"):
        Seeder(client, PERSONAS[pid], **QUIET).run()
    names = [m["name"] for m in fake.merchants.values()]
    assert len(names) == 2 * len(MERCHANTS)
    assert len(set(names)) == len(MERCHANTS)
    assert {m["address"]["state"] for m in fake.merchants.values()} == {"MI", "TX"}


def test_snapshot_files_are_labeled_and_complete(client, seeded, tmp_path):
    persona, _, _ = seeded
    take_snapshot(client, persona, root=tmp_path)
    data = json.loads((tmp_path / "snapshots" / "rowan-mi.json").read_text())
    assert data["meta"]["fictional"] is True and "Fictional" in data["meta"]["notice"]
    assert data["meta"]["demo_inputs"] == {"incident_date": "2026-06-14", "as_of_date": "2026-10-03"}
    doc = data["meta"]["documents"][0]
    assert doc["path"] == "seed/bills/rowan-mi-riverbend.pdf" and doc["total_cents"] == 443_00
    assert (tmp_path / "bills" / "rowan-mi-riverbend.pdf").exists()
