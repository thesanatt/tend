"""The live demo's bank goes back to its start on its own (tend_api.demo_reset).

The bank is seed/tests/fake_nessie.py, the offline Nessie built from seed/NESSIE_NOTES.md, seeded with rowan-mi by the
real seeder. The API runs on the real corpus and the Python reference engine, as in test_nessie_recorded.py. The clock is
fake, and no request leaves the process.
"""

from __future__ import annotations

import copy
import dataclasses
import datetime as dt
import importlib.util
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from helpers import BILL_ID, CHECKING, FakeClock, client_for, make_services

from tend_api.actions import CODE_TTL
from tend_api.app import create_app
from tend_api.bank import DryRunBank, NessieBank
from tend_api.config import API_DIR, Settings
from tend_api.demo_reset import QUIET, Deadline, OnlyUndo, ResetRefused, end_of_day, plan, seed_module
from tend_api.models import ProposeRequest
from tend_api.nessie import Address, BankSnapshot, NessieClient, Txn, load_persona_snapshot
from tend_api.payments import withdrawal_description
from tend_api.services import build_services

REPO = API_DIR.parent
BASE = "https://nessie.test"
PAYEE = "Riverbend General Hospital"
# The refusal web/components/flow/bills/PaySheet.tsx shows as "already paid".
ALREADY_PAID = "Tend already paid these lines of this bill"
PAYOUT = "Michigan Crime Victim Compensation demo payment (fictional) [tend:payout-MI]"
NOW = dt.datetime(2026, 10, 19, 15, 0, tzinfo=dt.UTC)


def fake_nessie_class() -> type:
    """seed/tests/fake_nessie.py, loaded by its path, so seed/tests stays off the import path."""
    spec = importlib.util.spec_from_file_location("fake_nessie", REPO / "seed" / "tests" / "fake_nessie.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.FakeNessie


@pytest.fixture(scope="module")
def world(tmp_path_factory) -> tuple[Any, Path]:
    """rowan-mi in a fake Nessie, seeded by the real seeder, with the snapshot and itemized bill seeder.py writes."""
    if not (REPO / "refengine").is_dir():
        pytest.skip("needs the Python reference engine in refengine/")
    seeder, personas = seed_module("seeder"), seed_module("personas")
    fake = fake_nessie_class()()
    seed = tmp_path_factory.mktemp("demo") / "seed"
    with NessieClient("test-key", BASE, transport=fake.transport()) as c:
        seeder.Seeder(c, personas.PERSONAS["rowan-mi"], log=lambda _: None).run()
        seeder.take_snapshot(c, personas.PERSONAS["rowan-mi"], root=seed)
    return fake, seed


def settings_for(tmp: Path, seed: Path, bank_mode: str) -> Settings:
    return Settings(
        rules_dir=REPO / "rules" / "verified",
        seed_dir=seed,
        engine_lib=tmp / "no-native-engine",
        law_dirs=(tmp / "no-laws",),
        tendc=tmp / "no-tendc",
        refengine_dir=REPO / "refengine",
        forms_dir=API_DIR / "forms",
        cache_dir=tmp / "cache",
        database_url=str(tmp / "tend.sqlite3"),
        bank_mode=bank_mode,
        secret_hex="ab" * 32,
        ir_dir=REPO / "rules" / "ir",
        autoload_corpus=False,
    )


class Demo:
    """One test's own copy of the seeded bank, with the API on top of it."""

    def __init__(self, world: tuple[Any, Path], tmp: Path, *, bank_mode: str = "nessie", connect: Callable[[float], Any] | None = None):
        fake, seed = world
        self.fake = copy.deepcopy(fake)
        self.fake.requests.clear()
        self.before_delete: Callable[[], None] | None = None
        self._lock = threading.Lock()  # the fake is not thread-safe; Nessie is
        self.saved = load_persona_snapshot("rowan-mi", seed / "snapshots")
        self.checking = self.saved.meta["account_keys"]["checking"]
        self.bill_id = self.saved.bills[0].id
        self.clock = FakeClock(NOW)
        self.services = build_services(
            settings_for(tmp, seed, bank_mode),
            clock=self.clock,
            banks={"dry_run": DryRunBank(), "nessie": NessieBank(self.client())},
            demo_reset_connect=connect or (lambda until: self.client(Deadline(self.transport(), until))),
        )
        self.reset = self.services.actions.demo_reset
        self.api = TestClient(create_app(services=self.services))

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.method == "DELETE" and self.before_delete is not None:
            self.before_delete()
        with self._lock:
            return self.fake.handle(request)

    def transport(self) -> httpx.BaseTransport:
        return httpx.MockTransport(self.handle)

    def client(self, transport: httpx.BaseTransport | None = None) -> NessieClient:
        return NessieClient("test-key", BASE, transport=transport or self.transport())

    def propose(self, **over: Any) -> httpx.Response:
        return self.api.post("/api/actions/propose", json={"from": self.checking, "payee": PAYEE, "amount_cents": 11800, **over})

    def pay(self, **over: Any) -> dict[str, Any]:
        p = self.propose(**over)
        assert p.status_code == 200, p.text
        done = self.api.post("/api/actions/confirm", json={"action_id": p.json()["action_id"], "confirm_code": p.json()["confirm_code"]})
        assert done.status_code == 200 and done.json()["status"] == "done", done.text
        return done.json()

    def requests(self) -> list[tuple[str, str]]:
        return [(method, path) for method, path, _ in self.fake.requests]

    def writes(self) -> list[tuple[str, str]]:
        return [(method, path) for method, path in self.requests() if method != "GET"]

    def bill(self) -> tuple[str, int, str]:
        with self.client() as c:
            b = c.get_bill(self.bill_id)
        return b.status, b.amount_cents, b.nickname

    def withdrawals(self, account_id: str | None = None) -> list[str]:
        with self.client() as c:
            return [t.id for t in c.list_txns(account_id or self.checking, "withdrawal")]


@pytest.mark.parametrize("later", [QUIET, dt.timedelta(days=3)])
def test_a_finished_demo_payment_is_undone_before_the_next_proposal(world, tmp_path, later):
    demo = Demo(world, tmp_path)
    first = demo.pay()
    assert demo.bill()[:2] == ("pending", 32500)
    demo.clock.now += later
    demo.fake.requests.clear()
    r = demo.propose()
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "pay_bill" and r.json()["bill_id"] == demo.bill_id
    # Exactly the reset: the payment deleted and the bill back under its own id. Nothing created, nothing else deleted.
    assert demo.writes() == [("DELETE", f"/withdrawal/{first['withdrawal_id']}"), ("PUT", f"/bills/{demo.bill_id}")]
    assert demo.bill() == ("pending", 44300, "Riverbend General statement")
    # The audit log keeps its rows and gets none for the reset.
    audit = demo.api.get("/api/audit").json()
    assert audit["chain"]["ok"] is True and [row["event"] for row in audit["rows"]] == ["confirmed", "executed"]
    # And this visitor pays the $118.00, the same way the first one did.
    p = r.json()
    done = demo.api.post("/api/actions/confirm", json={"action_id": p["action_id"], "confirm_code": p["confirm_code"]}).json()
    assert done["status"] == "done" and done["bill"]["amount_cents"] == 32500


@pytest.mark.parametrize("later", [dt.timedelta(minutes=1), QUIET - dt.timedelta(seconds=1)])
def test_a_payment_inside_the_quiet_period_is_left_alone(world, tmp_path, later):
    demo = Demo(world, tmp_path)
    first = demo.pay()
    demo.clock.now += later
    demo.fake.requests.clear()
    r = demo.propose()
    assert r.status_code == 409 and r.json()["detail"].startswith(ALREADY_PAID)
    assert first["withdrawal_id"] in r.json()["detail"]
    # Nessie was not even asked: the one request was the proposal's own look for an earlier payment.
    assert demo.requests() == [("GET", f"/accounts/{demo.checking}/withdrawals")]


def test_a_newer_payment_anywhere_on_the_account_holds_the_reset(world, tmp_path):
    demo = Demo(world, tmp_path)
    first = demo.pay()
    demo.clock.advance(minutes=15)
    demo.pay(payee="Lakeshore Urgent Care (fictional)", amount_cents=5000)  # someone in the middle of the demo
    demo.clock.advance(minutes=6)  # the bill payment is 21 minutes old, the other one 6
    demo.fake.requests.clear()
    r = demo.propose()
    assert r.status_code == 409 and r.json()["detail"].startswith(ALREADY_PAID)
    assert demo.writes() == []
    assert first["withdrawal_id"] in demo.withdrawals() and demo.bill()[:2] == ("pending", 32500)


def test_a_demo_deposit_from_today_is_kept_and_an_older_one_undone(world, tmp_path):
    demo = Demo(world, tmp_path)
    with demo.client() as c:
        old = c.create_deposit(demo.checking, amount_cents=4008_00, date="2026-10-18", description=PAYOUT)
        today = c.create_deposit(demo.checking, amount_cents=4008_00, date="2026-10-19", description=PAYOUT)
    first = demo.pay()
    demo.clock.advance(minutes=21)
    demo.fake.requests.clear()
    assert demo.propose().status_code == 200
    # A deposit has only a date, so the one from today could still be on someone's screen.
    assert sorted(demo.writes()) == sorted(
        [("DELETE", f"/deposits/{old.id}"), ("DELETE", f"/withdrawal/{first['withdrawal_id']}"), ("PUT", f"/bills/{demo.bill_id}")]
    )
    with demo.client() as c:
        assert today.id in {t.id for t in c.list_txns(demo.checking, "deposit")}


def no_reset(until: float) -> Any:
    raise AssertionError("the demo reset must not run")


def test_a_dry_run_server_never_resets(settings, clock):
    # The fixture world, TEND_BANK=dry_run: payments are kept in memory, and Nessie is never asked for anything.
    services = make_services(settings, clock, demo_reset_connect=no_reset)
    assert services.actions.demo_reset.live is False
    client = client_for(services)
    body = {"from": CHECKING, "payee": "Riverbend General Hospital (fictional)", "amount_cents": 11800}
    p = client.post("/api/actions/propose", json=body).json()
    assert client.post("/api/actions/confirm", json={"action_id": p["action_id"], "confirm_code": p["confirm_code"]}).status_code == 200
    clock.advance(days=3)
    r = client.post("/api/actions/propose", json=body)
    assert r.status_code == 409 and r.json()["detail"].startswith(ALREADY_PAID)


def test_a_dry_run_on_a_live_server_never_resets(world, tmp_path):
    demo = Demo(world, tmp_path, connect=no_reset)
    demo.pay(dry_run=True)
    demo.clock.advance(days=3)
    r = demo.propose(dry_run=True)
    assert r.status_code == 409 and r.json()["detail"].startswith(ALREADY_PAID)
    assert demo.requests() == []


def refusing_deletes(demo: Demo) -> Callable[[float], Any]:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.method == "DELETE":
            return httpx.Response(500, json={"message": "Internal server error"})
        return demo.handle(request)

    return lambda until: demo.client(httpx.MockTransport(handle))


def no_key(until: float) -> Any:
    return NessieClient.from_env()  # the tests' environment has no NESSIE_API_KEY, like a deployment without one


@pytest.mark.parametrize("trouble", ["no key", "delete refused", "out of time"])
def test_a_reset_that_does_not_finish_falls_back_to_the_already_paid_answer(world, tmp_path, trouble):
    demo = Demo(world, tmp_path)
    if trouble == "no key":
        demo.reset.connect = no_key
    elif trouble == "delete refused":
        demo.reset.connect = refusing_deletes(demo)
    else:
        demo.reset.timeout_s = 0.0
    first = demo.pay()
    demo.clock.advance(minutes=21)
    demo.fake.requests.clear()
    r = demo.propose()
    assert r.status_code == 409 and r.json()["detail"].startswith(ALREADY_PAID)
    assert first["withdrawal_id"] in r.json()["detail"]
    assert demo.writes() == []
    assert first["withdrawal_id"] in demo.withdrawals() and demo.bill()[:2] == ("pending", 32500)
    assert demo.reset.run("rowan-mi").outcome == "failed"


def test_while_another_instance_holds_the_lock_the_proposal_answers_as_before(world, tmp_path):
    demo = Demo(world, tmp_path)
    demo.reset.timeout_s = 0.3
    demo.pay()
    demo.clock.advance(minutes=21)
    demo.fake.requests.clear()
    # Another instance of the function holds the persona's lock for longer than this attempt may wait.
    with demo.services.repo.exclusive("demo_reset:rowan-mi", 0) as held:
        assert held
        r = demo.propose()
    assert r.status_code == 409 and r.json()["detail"].startswith(ALREADY_PAID)
    assert demo.writes() == []


def test_two_proposals_at_once_reset_once(world, tmp_path):
    demo = Demo(world, tmp_path)
    first = demo.pay()
    demo.clock.advance(minutes=21)
    demo.fake.requests.clear()
    entered: list[str] = []
    both_in = threading.Event()
    attempts: list[str] = []
    run = demo.reset.run

    def counted(persona_id: str) -> Any:
        entered.append(persona_id)
        if len(entered) == 2:
            both_in.set()
        attempt = run(persona_id)
        attempts.append(attempt.outcome)
        return attempt

    # The first attempt deletes only once the second has started its own, so the two overlap.
    demo.before_delete = lambda: both_in.wait(10)

    demo.reset.run = counted
    request = ProposeRequest.model_validate({"from": demo.checking, "payee": PAYEE, "amount_cents": 11800})
    barrier = threading.Barrier(2)
    outcomes: list[str] = []

    def propose() -> None:
        barrier.wait()
        try:
            outcomes.append(demo.services.actions.propose(request)["kind"])
        except Exception as exc:  # noqa: BLE001
            outcomes.append(f"{type(exc).__name__}:{getattr(exc, 'status_code', '')}")

    threads = [threading.Thread(target=propose) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert outcomes == ["pay_bill", "pay_bill"]
    # One attempt undid the payment; the other waited for the lock, read the bank again, and found nothing to do.
    assert sorted(attempts) == ["clean", "reset"]
    assert demo.writes() == [("DELETE", f"/withdrawal/{first['withdrawal_id']}"), ("PUT", f"/bills/{demo.bill_id}")]


def test_accounts_outside_the_demo_personas_are_never_touched(world, tmp_path):
    demo = Demo(world, tmp_path)
    with demo.client() as c:
        stranger = c.create_customer("Spike", "Probe", Address("1", "Probe Way", "Ann Arbor", "MI", "48109"))
        account = c.create_account(stranger.id, "Checking", "Probe", 1000_00)
        # In Tend's own words, naming Rowan's bill, and long finished: still not Tend's to undo.
        theirs = c.create_withdrawal(
            account.id,
            amount_cents=118_00,
            date="2026-10-01",
            description=withdrawal_description(PAYEE, "act_" + "1" * 20, demo.bill_id, (1, 3)),
        )
    demo.fake.requests.clear()
    assert demo.propose(**{"from": account.id}).status_code == 403  # live payments come only from demo accounts
    assert demo.requests() == []
    demo.pay()
    demo.clock.advance(minutes=21)
    demo.fake.requests.clear()
    assert demo.propose().status_code == 200  # Rowan's account went back to its start
    assert demo.writes() and all(account.id not in path and theirs.id not in path for _, path in demo.writes())
    assert demo.withdrawals(account.id) == [theirs.id]


class Recorder:
    base_url = BASE

    def __init__(self) -> None:
        self.calls: list[str] = []

    def __getattr__(self, name: str) -> Any:
        return lambda *args, **kwargs: self.calls.append(name)


def test_the_resets_client_sends_only_the_planned_writes():
    inner = Recorder()
    guard = OnlyUndo(inner, undo={"w-old"}, bills={"b-1"})
    guard.list_txns("acct", "withdrawal")
    guard.delete_txn("withdrawal", "w-old")
    guard.update_bill("b-1", status="pending")
    refused = [
        lambda: guard.delete_txn("purchase", "p-seeded"),
        lambda: guard.update_bill("b-2", status="pending"),
        lambda: guard.create_withdrawal("acct", amount_cents=100, date="2026-10-19", description="x"),
        lambda: guard.create_bill("acct", payee="x", nickname="x", amount_cents=100, payment_date="2026-10-20", recurring_date=20),
        lambda: guard.update_merchant("m-1", category="x"),
        lambda: guard.delete_account("acct"),
        lambda: guard.delete_bill("b-1"),
    ]
    for write in refused:
        with pytest.raises(ResetRefused):
            write()
    assert inner.calls == ["list_txns", "delete_txn", "update_bill"] and guard.deleted == ["w-old"]
    assert guard.base_url == BASE


def fixture_bank(settings: Settings) -> BankSnapshot:
    return load_persona_snapshot("rowan-mi", settings.seed_dir / "snapshots")


def test_the_plan_sorts_the_bank_against_its_snapshot(settings):
    saved = fixture_bank(settings)
    pay = withdrawal_description("Riverbend General Hospital (fictional)", "act_" + "a" * 20, BILL_ID, (1, 2))
    payment = Txn("w-old", "withdrawal", CHECKING, "2026-10-18", 11800, "completed", pay, "balance")
    deposit = Txn("d-old", "deposit", CHECKING, "2026-10-18", 400800, "completed", PAYOUT, "balance")
    today = dataclasses.replace(deposit, id="d-new", date="2026-10-19")
    foreign = Txn("x-1", "purchase", CHECKING, "2026-10-01", 2500, "completed", "written with someone else's key", "balance", "m-x")
    bill = dataclasses.replace(saved.bills[0], amount_cents=32500)
    live = dataclasses.replace(saved, txns=[*saved.txns, payment, deposit, today, foreign], bills=[bill])
    p = plan(saved, live, lambda t: end_of_day(t.date), NOW)
    assert [t.id for t in p.undo] == ["w-old", "d-old"]
    assert [t.id for t in p.recent] == ["d-new"] and [t.id for t in p.others] == ["x-1"]
    assert p.bill_moved and p.problems == () and not p.in_use and p.needed
    # A payment from today is someone who may still be at it: nothing is undone.
    busy = dataclasses.replace(live, txns=[*live.txns, dataclasses.replace(payment, id="w-new", date="2026-10-19")])
    assert plan(saved, busy, lambda t: end_of_day(t.date), NOW).in_use
    assert not plan(saved, busy, lambda t: end_of_day(t.date), NOW).needed
    assert plan(saved, saved, lambda t: end_of_day(t.date), NOW) == type(p)()


def test_an_account_that_differs_in_other_ways_is_left_for_a_person(settings):
    saved = fixture_bank(settings)
    first = saved.txns[0]
    for live in (
        dataclasses.replace(saved, txns=saved.txns[1:]),
        dataclasses.replace(saved, txns=[dataclasses.replace(first, amount_cents=1), *saved.txns[1:]]),
        dataclasses.replace(saved, accounts=[*saved.accounts, dataclasses.replace(saved.accounts[0], id="acct-new")]),
        dataclasses.replace(saved, bills=[]),
    ):
        p = plan(saved, live, lambda t: end_of_day(t.date), NOW)
        assert p.problems and not p.needed


def test_the_quiet_period_outlasts_a_code_and_a_date_lasts_to_its_end_in_detroit():
    assert QUIET == dt.timedelta(minutes=20) and QUIET > CODE_TTL
    assert end_of_day("2026-10-19") == dt.datetime(2026, 10, 20, 4, 0, tzinfo=dt.UTC)  # daylight time
    assert end_of_day("2026-12-01") == dt.datetime(2026, 12, 2, 5, 0, tzinfo=dt.UTC)
    assert end_of_day("not-a-date") is None
