"""The plumbing between agents (request ids, timeouts, retries, who may answer) and the two desks' edge cases."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from conftest import desks_for, run, settings
from fake_api import CODE, FakeTend, load
from uagents_core.types import DeliveryStatus, MsgStatus

from tend_agent.bank import BankDesk
from tend_agent.demo import demo_ref
from tend_agent.desks import DeskDown, Idempotent
from tend_agent.link import AgentLink
from tend_agent.messages import (
    DemoRef,
    LawCheckRequest,
    LawReply,
    PayConfirmRequest,
    PayProposeRequest,
    PayStatusRequest,
)

LAW = "agent1qlawaddress"
DEMO = DemoRef(**demo_ref(load("scan_rowan_mi.json"), load("audit_rowan_mi.json"), "rowan-mi"))


class Wire:
    """A stand-in for a uAgents context: drops the first `lose` sends, and answers the rest from `answer`."""

    def __init__(self, link: AgentLink, answer: Any, lose: int = 0, status: DeliveryStatus = DeliveryStatus.DELIVERED, sender: str = LAW):
        self.link, self.answer, self.lose, self.status, self.sender = link, answer, lose, status, sender
        self.sent: list[Any] = []

    async def send(self, destination: str, message: Any, timeout: int = 30) -> MsgStatus:
        self.sent.append(message)
        if len(self.sent) > self.lose and self.status == DeliveryStatus.DELIVERED:
            reply = self.answer(message)
            asyncio.get_running_loop().call_later(0.01, self.link.resolve, self.sender, reply)
        return MsgStatus(status=self.status, detail="", destination=destination, endpoint="")


def check_req(rid: str = "r1") -> LawCheckRequest:
    return LawCheckRequest(request_id=rid, st="MI")


def law_link(**kw: Any) -> AgentLink:
    return AgentLink({"law": LAW}, timeouts={"law": 0.2}, retry_pause_s=0.01, **kw)


def test_a_lost_message_is_sent_again_with_the_same_request_id():
    link = law_link(attempts=2)
    wire = Wire(link, lambda m: LawReply(request_id=m.request_id, text="ok"), lose=1)
    reply = run(link.call(wire, "law", check_req()))
    assert reply.text == "ok" and [m.request_id for m in wire.sent] == ["r1", "r1"]


def test_after_every_attempt_the_desk_is_down():
    link = law_link(attempts=3)
    wire = Wire(link, lambda m: LawReply(request_id=m.request_id), lose=99)
    with pytest.raises(DeskDown) as err:
        run(link.call(wire, "law", check_req()))
    assert err.value.desk == "law" and len(wire.sent) == 3


def test_an_undeliverable_message_fails_fast():
    link = law_link(attempts=2)
    wire = Wire(link, lambda m: None, status=DeliveryStatus.FAILED)
    with pytest.raises(DeskDown):
        run(asyncio.wait_for(link.call(wire, "law", check_req()), 1.0))


def test_an_address_that_cannot_be_resolved_is_a_failed_delivery():
    # uagents raises (instead of returning FAILED) when its Almanac lookup fails, for example with no route to the
    # ledger. The turn must still get the desk's clear fallback, not a crash.
    class Unresolvable:
        sent = 0

        async def send(self, destination: str, message: Any, timeout: int = 30) -> MsgStatus:
            Unresolvable.sent += 1
            raise ValueError("almanac lookup failed")

    with pytest.raises(DeskDown) as err:
        run(asyncio.wait_for(law_link(attempts=2).call(Unresolvable(), "law", check_req()), 1.0))
    assert err.value.desk == "law" and Unresolvable.sent == 2


def test_a_reply_from_another_address_is_ignored():
    link = law_link(attempts=1)
    wire = Wire(link, lambda m: LawReply(request_id=m.request_id, text="forged"), sender="agent1qsomeoneelse")
    with pytest.raises(DeskDown):
        run(link.call(wire, "law", check_req()))
    assert link.resolve(LAW, LawReply(request_id="nobody-asked")) is False


def test_an_unknown_desk_is_down():
    with pytest.raises(DeskDown):
        run(AgentLink({}).call(object(), "bank", check_req()))


def test_idempotent_runs_once_while_running_and_repeats_the_answer():
    calls = []

    async def work() -> str:
        calls.append(1)
        await asyncio.sleep(0.02)
        return "answer"

    async def scenario() -> list[str]:
        once = Idempotent(ttl_s=60)
        first = await asyncio.gather(once.run("a", work), once.run("a", work))
        return [*first, await once.run("a", work)]

    assert run(scenario()) == ["answer", "answer", "answer"] and len(calls) == 1


def test_idempotent_forgets_after_the_retry_window():
    clock = [0.0]
    once = Idempotent(ttl_s=10, now=lambda: clock[0])
    calls = []

    async def work() -> int:
        calls.append(1)
        return len(calls)

    assert run(once.run("a", work)) == 1
    clock[0] = 11
    assert run(once.run("a", work)) == 2


# ---------------------------------------------------------------- the Bank+Packet desk


def bank(fake: FakeTend) -> BankDesk:
    desks, api = desks_for(fake)
    return BankDesk(api, settings())


def test_a_retried_confirm_after_a_lost_reply_reports_the_payment_not_an_error():
    fake = FakeTend()
    desk = bank(fake)
    proposal = run(desk.handle(PayProposeRequest(request_id="p1", demo=DEMO)))
    assert proposal.ok and proposal.confirm_code == CODE and proposal.amount_cents == 11800
    first = run(desk.handle(PayConfirmRequest(request_id="c1", action_id=proposal.action_id, confirm_code=CODE, demo=DEMO)))
    # A new request id (the Navigator restarted), same action: the API says 409, the desk reads the action instead.
    again = run(
        BankDesk(desk.api, settings()).handle(
            PayConfirmRequest(request_id="c2", action_id=proposal.action_id, confirm_code=CODE, demo=DEMO)
        )
    )
    assert first.outcome == again.outcome == "done" and "Paid $118.00" in again.text and again.audit_id == "aud_000004"
    assert len(fake.bodies("/api/actions/confirm")) == 2


def test_confirm_outcomes():
    fake = FakeTend()
    desk = bank(fake)
    p = run(desk.handle(PayProposeRequest(request_id="p1", demo=DEMO)))
    wrong = run(desk.handle(PayConfirmRequest(request_id="c1", action_id=p.action_id, confirm_code="000000", demo=DEMO)))
    assert wrong.outcome == "wrong_code" and wrong.ok
    missing = run(desk.handle(PayConfirmRequest(request_id="c2", action_id="act_00000000000000000099", confirm_code=CODE, demo=DEMO)))
    assert missing.outcome == "not_found"
    status = run(desk.handle(PayStatusRequest(request_id="s1", action_id=p.action_id, demo=DEMO)))
    assert status.outcome == "waiting"


def test_nothing_to_pay_and_api_errors_come_back_as_replies():
    desk = bank(FakeTend())
    empty = run(desk.handle(PayProposeRequest(request_id="p1", demo=DEMO.copy(update={"payable_cents": 0}))))
    assert not empty.ok and empty.error == "nothing_to_pay"
    down = bank(FakeTend(down=True))
    reply = run(down.handle(PayProposeRequest(request_id="p2", demo=DEMO)))
    assert not reply.ok and reply.error == "api_down"
