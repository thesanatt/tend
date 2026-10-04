"""reset_demo.py puts a persona's bank back at the demo start after a demo run, keeping every id."""
import pytest

import reset_demo
from personas import PERSONAS
from seeder import Seeder, take_snapshot
from tend_api.nessie import NessieClient
from tend_api.payments import BillFacts, BillLine, bill_target, withdrawal_description

QUIET = {"log": lambda message: None}
ACTION = "act_0123456789abcdef0123"


@pytest.fixture
def world(client, tmp_path):
    """rowan-mi seeded into the fake Nessie, with its snapshot committed to tmp_path."""
    persona = PERSONAS["rowan-mi"]
    manifest = Seeder(client, persona, **QUIET).run()
    take_snapshot(client, persona, root=tmp_path)
    return manifest, tmp_path / "snapshots"


def demo_run(client, manifest) -> dict:
    """What a demo writes to Nessie, in Tend's own formats: the $118 bill payment, the bill left at the held
    $325 with the rule in its nickname, and the program's demo deposit."""
    checking = manifest["accounts"]["checking"]
    bill_id = manifest["bill"]["riverbend"]
    payment = client.create_withdrawal(
        checking, amount_cents=118_00, date="2026-10-04",
        description=withdrawal_description("Riverbend General Hospital", ACTION, bill_id, (1, 3)),
    )
    facts = BillFacts(
        bill_id=bill_id, account_id=checking, payee="Riverbend General Hospital", nickname="Riverbend General statement",
        total_cents=443_00, payable_cents=118_00,
        lines=(BillLine("l1", 1, 75_00, "eligible"), BillLine("l2", 2, 325_00, "held", ("MI-EXAM-1",)),
               BillLine("l3", 3, 43_00, "eligible")),
        pinpoints={"MI-EXAM-1": "MCL 18.355a(2)"},
    )
    client.update_bill(bill_id, **bill_target(facts, 118_00))
    deposit = client.create_deposit(
        checking, amount_cents=4_008_00, date="2026-10-04",
        description="Michigan Crime Victim Compensation demo payment (fictional) [tend:payout-MI]",
    )
    return {"payment": payment.id, "deposit": deposit.id, "bill": bill_id}


def test_a_demo_run_is_undone_and_every_id_is_kept(client, world):
    manifest, snapshots = world
    wrote = demo_run(client, manifest)
    report = reset_demo.reset(client, "rowan-mi", snapshot_dir=snapshots)
    assert report.ok and not report.ids_changed
    assert len(report.before) == 3  # the payment, the deposit, and the bill
    assert any(wrote["payment"] in c for c in report.changes)
    assert any(wrote["deposit"] in c for c in report.changes)
    assert any(c.startswith(f"restored bill {wrote['bill']}") for c in report.changes)
    bill = client.get_bill(wrote["bill"])
    assert (bill.status, bill.amount_cents, bill.nickname) == ("pending", 443_00, "Riverbend General statement")
    assert report.bill == "pending $443.00" and report.records == 190
    assert report.balances == {"Checking": 803_00, "Cushion": 590_00}


def test_check_lists_what_a_reset_would_undo_and_writes_nothing(client, fake, world):
    manifest, snapshots = world
    demo_run(client, manifest)
    writes = sum(fake.count(m) for m in ("POST", "PUT", "DELETE"))
    report = reset_demo.reset(client, "rowan-mi", check_only=True, snapshot_dir=snapshots)
    assert not report.ok
    assert [line.split(" ")[0] for line in report.before] == ["extra", "extra", "bill"]
    assert "$325.00" in report.before[2] and "MI-EXAM-1" in report.before[2]
    assert sum(fake.count(m) for m in ("POST", "PUT", "DELETE")) == writes


def test_a_bank_at_the_demo_start_is_left_alone(client, fake, world):
    _, snapshots = world
    writes = sum(fake.count(m) for m in ("POST", "PUT", "DELETE"))
    report = reset_demo.reset(client, "rowan-mi", snapshot_dir=snapshots)
    assert report.ok and report.changes == [] and report.before == []
    assert sum(fake.count(m) for m in ("POST", "PUT", "DELETE")) == writes


def test_a_recreated_record_is_reported_with_how_to_fix_it(client, world, capsys):
    manifest, snapshots = world
    client.delete_txn("purchase", manifest["records"]["purchase-001"])
    report = reset_demo.reset(client, "rowan-mi", snapshot_dir=snapshots)
    assert not report.ok and report.ids_changed
    assert any(line.startswith("missing purchase") for line in report.after)
    reset_demo.print_report(report, check_only=False)
    out = capsys.readouterr().out
    assert "NOT at the demo start" in out and "seeder.py snapshot rowan-mi" in out


def test_the_command_says_ready_and_exits_zero(client, world, monkeypatch, capsys):
    manifest, snapshots = world
    demo_run(client, manifest)
    monkeypatch.setattr(reset_demo, "load_env", lambda: None)
    monkeypatch.setattr(reset_demo.NessieClient, "from_env", classmethod(lambda cls: _borrowed(client)))
    real = reset_demo.reset
    monkeypatch.setattr(reset_demo, "reset", lambda c, pid, **kw: real(c, pid, snapshot_dir=snapshots, **kw))
    assert reset_demo.main(["--check"]) == 1
    assert "a reset would undo 3 thing(s)" in capsys.readouterr().out
    assert reset_demo.main([]) == 0
    out = capsys.readouterr().out
    assert "rowan-mi: at the demo start" in out and "bill pending $443.00" in out and "Checking $803.00" in out
    assert reset_demo.main(["--check"]) == 0


class _borrowed:
    """A context manager over a client the test owns, so main() does not close it."""

    def __init__(self, client: NessieClient):
        self.client = client

    def __enter__(self) -> NessieClient:
        return self.client

    def __exit__(self, *exc) -> None:
        return None
