"""Typed messages between the three Tend agents.

Navigator -> Law agent: cited answers, Checks, and what the corpus covers.
Navigator -> Bank+Packet agent: the fictional demo claim, the payment, and the advocate's share link.

Every request carries a request_id. A retry resends the same id, so a sub-agent answers it once and repeats that
answer, and nothing runs twice. No message ever carries what happened, a name, or a survivor's own data: the
demo is fictional and the law is public.
"""

from __future__ import annotations

from uagents import Model


class DemoRef(Model):
    """The fictional demo claim as the Navigator keeps it between messages: ids and amounts, no merchant text."""

    persona_id: str
    st: str
    scan_id: str
    who: str
    account_id: str
    account_label: str
    incident_date: str | None = None
    bill_id: str | None = None
    provider: str | None = None
    pay_item_ids: list[str] = []
    bill_lines: int = 0
    bill_total_cents: int = 0
    payable_cents: int = 0
    held_cents: int = 0
    police_report: str | None = None


# ---------------------------------------------------------------- Law agent


class LawAnswerRequest(Model):
    request_id: str
    st: str
    question: str | None = None  # None when the person's words must stay with the Navigator
    topics: list[str] = []
    expense: str | None = None


class LawCheckRequest(Model):
    request_id: str
    st: str
    incident_date: str | None = None
    forensic_exam: bool | None = None  # None: not sure
    police_report: str = "unknown"  # yes | no | unknown


class LawCoverageRequest(Model):
    request_id: str


class LawReply(Model):
    request_id: str
    ok: bool = True
    text: str = ""
    known: bool = True  # False: not in the rules the agent has
    st: str | None = None
    count: int | None = None
    error: str | None = None  # api_down | api_error | bad_request
    status: int | None = None


# ---------------------------------------------------------------- Bank+Packet agent


class CostGroup(Model):
    expense: str
    count: int
    cents: int


class DemoStartRequest(Model):
    request_id: str
    st: str | None = None


class DemoStartReply(Model):
    request_id: str
    ok: bool = True
    text: str = ""
    demo: DemoRef | None = None
    groups: list[CostGroup] = []
    error: str | None = None
    status: int | None = None


class DemoCountRequest(Model):
    request_id: str
    demo: DemoRef


class DemoCountReply(Model):
    request_id: str
    ok: bool = True
    text: str = ""
    letter: str = ""  # to the billing office, quoting the law that holds the exam line
    allowed_cents: int = 0
    held_cents: int = 0
    deadline_date: str | None = None
    error: str | None = None
    status: int | None = None


class PayProposeRequest(Model):
    request_id: str
    demo: DemoRef


class PayProposeReply(Model):
    request_id: str
    ok: bool = True
    action_id: str | None = None
    amount_cents: int = 0
    confirm_code: str | None = None  # shown once to the person, never stored by any agent
    expires_at: str | None = None
    payee_label: str = ""
    from_label: str = ""
    lines_label: str = ""
    held_cents: int = 0
    dry_run: bool = True
    text: str = ""
    error: str | None = None
    status: int | None = None


class PayConfirmRequest(Model):
    request_id: str
    action_id: str
    confirm_code: str  # exactly what the person typed
    demo: DemoRef


class PayStatusRequest(Model):
    request_id: str
    action_id: str
    demo: DemoRef


class PayResultReply(Model):
    request_id: str
    ok: bool = True
    # done | unverified | maybe | unknown | in_progress | wrong_code | expired | locked | waiting | not_found | bank_error
    outcome: str = ""
    text: str = ""
    amount_cents: int = 0
    audit_id: str | None = None
    bank_record: str | None = None
    error: str | None = None
    status: int | None = None


class PacketShareRequest(Model):
    request_id: str
    demo: DemoRef
    paid_cents: int = 0
    hours: int = 72


class PacketShareReply(Model):
    request_id: str
    ok: bool = True
    url: str | None = None
    expires_at: str | None = None
    text: str = ""
    still_needed: int = 0
    error: str | None = None
    status: int | None = None


LAW_REQUESTS = (LawAnswerRequest, LawCheckRequest, LawCoverageRequest)
BANK_REQUESTS = (DemoStartRequest, DemoCountRequest, PayProposeRequest, PayConfirmRequest, PayStatusRequest, PacketShareRequest)
REPLY_FOR: dict[type[Model], type[Model]] = {
    LawAnswerRequest: LawReply,
    LawCheckRequest: LawReply,
    LawCoverageRequest: LawReply,
    DemoStartRequest: DemoStartReply,
    DemoCountRequest: DemoCountReply,
    PayProposeRequest: PayProposeReply,
    PayConfirmRequest: PayResultReply,
    PayStatusRequest: PayResultReply,
    PacketShareRequest: PacketShareReply,
}
REPLIES = (LawReply, DemoStartReply, DemoCountReply, PayProposeReply, PayResultReply, PacketShareReply)
