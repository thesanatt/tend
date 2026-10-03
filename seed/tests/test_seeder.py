import json

import httpx
import pytest

from history import ACCOUNTS, MERCHANTS, build_history
from personas import PERSONAS
from seeder import Seeder, labels_for, take_snapshot, verify_against_plan
from tend_api.nessie import NessieClient, NessieListCorrupt, read_persona

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
    client.create_bill(cushion, payee="Stray", nickname="demo", amount_cents=5_00, payment_date="2026-10-20",
                       recurring_date=20)
    reset = Seeder(client, persona, **QUIET)
    reset.run()
    assert (reset.stats.created, reset.stats.updated, reset.stats.deleted) == (0, 1, 3)
    assert client.list_bills(cushion) == []
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


def test_read_persona_prefers_live_and_says_so(client, fake, seeded, tmp_path):
    persona, manifest, _ = seeded
    take_snapshot(client, persona, root=tmp_path)
    saved_dir = tmp_path / "snapshots"
    live = read_persona(persona.id, client, saved_dir)
    assert (live.source, live.error) == ("live", None)
    assert live.snapshot.meta["persona_id"] == persona.id
    client.create_withdrawal(manifest["accounts"]["checking"], amount_cents=118_00, date="2026-10-03",
                             description="Riverbend [tend:demo]")
    assert len(read_persona(persona.id, client, saved_dir).snapshot.txns) == len(live.snapshot.txns) + 1


def test_read_persona_falls_back_to_the_snapshot(tmp_path):
    assert read_persona("rowan-mi").source == "snapshot"

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("venue wifi", request=request)

    with NessieClient("k", "https://nessie.test", transport=httpx.MockTransport(down)) as offline_client:
        result = read_persona("rowan-mi", offline_client)
    assert result.source == "snapshot" and "ConnectError" in result.error
    assert len(result.snapshot.txns) == len(build_history())


def test_read_persona_falls_back_on_a_payload_it_cannot_read(seeded, client, tmp_path):
    persona, _, _ = seeded
    take_snapshot(client, persona, root=tmp_path)
    transport = httpx.MockTransport(lambda request: httpx.Response(200, text="<html>portal</html>"))
    with NessieClient("k", "https://nessie.test", transport=transport) as odd:
        got = read_persona(persona.id, odd, tmp_path / "snapshots")
    assert got.source == "snapshot" and "expected an object" in got.error


def test_load_env_lets_the_file_win_and_reads_export_lines(tmp_path, monkeypatch):
    from seeder import load_env

    env = tmp_path / ".env"
    env.write_text("# keys\nexport NESSIE_API_KEY='from-file'\nGEMINI_API_KEY=\"g\"\n")
    monkeypatch.setenv("TEND_ENV_FILE", str(env))
    monkeypatch.setenv("NESSIE_API_KEY", "from-shell")
    assert load_env() == env
    import os
    assert (os.environ["NESSIE_API_KEY"], os.environ["GEMINI_API_KEY"]) == ("from-file", "g")
