"""The conversation: one message in, replies out. The Navigator talks with the person and orchestrates; the Law
agent and the Bank+Packet agent do the work (desks.py). No uAgents here, so every path is testable.

Session state holds ids, amounts, and short-lived choices. Never the text of a message, and never a confirm code:
the code is shown once on the review card and only the person can type it back.
"""

from __future__ import annotations

import datetime as dt
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .cards import Card, check_form, code_form, count_costs_card, next_steps_card, payment_card, share_card, welcome_card
from .demo import FICTIONAL_SHORT
from .desks import DESK_NAMES, DeskDown
from .fmt import long_date, money
from .messages import (
    DemoCountRequest,
    DemoRef,
    DemoStartRequest,
    LawAnswerRequest,
    LawCheckRequest,
    LawCoverageRequest,
    PacketShareRequest,
    PayConfirmRequest,
    PayProposeRequest,
    PayStatusRequest,
)
from .parse import (
    Incoming,
    asks_eligibility,
    exam_value,
    find_confirm_code,
    find_date,
    find_exam,
    find_expense,
    find_report,
    find_topics,
    is_greeting,
    parse_iso_date,
    report_value,
    says_no,
    says_yes,
    selection_from_text,
    story_kind,
    wants_cancel,
    wants_check,
    wants_demo,
    wants_pay,
    wants_payment_status,
    wants_share,
)
from .settings import Settings
from .states import STATES, find_state, state_name

WELCOME = (
    "Hi. I'm Tend Navigator. I help sexual assault survivors, and the advocates who support them, get the crime "
    "victim compensation their state already promises.\n\n"
    "I never ask for your name, what happened, or anything that identifies you. You don't need an account, and I "
    "don't keep messages.\n\n"
    "- **Ask** about any state's program. I quote the law and link it, or I tell you it's not in the rules I have.\n"
    "- **Check**: the state, the date it happened (only the date), and whether there was a forensic exam or a police "
    "report. You get the deadline, the police report rules, and what is covered.\n"
    "- **Demo**: a fictional claim from start to finish. Costs from a mock bank, a hospital bill line the law says "
    "should never have been billed, a payment you approve with a code, and a locked link for an advocate."
)
TEAM = (
    "Three agents work on this: I talk with you, the Law agent reads the verified rules, and the Bank and Packet agent "
    "runs the fictional claim."
)
FIRST_NOTE = "_I never ask for your name, what happened, or anything that identifies you._"
STORY_NOTE = (
    "You don't need to tell me what happened, where, or who, and I didn't pass that message on. "
    "I only need the state, and for a Check, the date."
)
HOTLINE = "If you want to talk with someone now, the National Sexual Assault Hotline is free and open all day and night: 800-656-4673."
TROUBLE = (
    "I can't reach Tend's server right now, so I can't look that up. Nothing was saved and no money moved. Please try again in a minute."
)
CONFIRM_UNSURE = (
    "I sent your code, but the Bank and Packet agent didn't answer in time, so I can't tell yet whether the payment went "
    "through. The code works once, so nothing can be paid twice. Say **check the payment** in a minute."
)
QUESTION_START = re.compile(r"^\s*(?:can|could|does|do|is|are|will|would|what|how|who|which|when|where|if)\b", re.I)
COVERAGE_Q = re.compile(r"\b(?:which|what) (?:states|jurisdictions)\b|\ball (?:the )?states\b|\b50 states\b", re.I)
_BILL_ONLY = re.compile(r"\b(?:bill|balance|rest|it|now|payment)\b", re.I)
THANKS = re.compile(r"^\s*(?:thanks|thank you|thx|ty)\b", re.I)


@dataclass
class Reply:
    text: str
    card: Card | None = None
    card_id: str | None = None
    end_session: bool = False


@dataclass
class Turn:
    replies: list[Reply]
    state: dict[str, Any]
    intent: str = "other"


class Failure(Exception):
    """A sub-agent answered, but the work failed (the API was down or refused)."""

    def __init__(self, reply: Any):
        super().__init__(reply.error or "failed")
        self.reply = reply


def _new_id() -> str:
    return uuid.uuid4().hex


class Navigator:
    def __init__(
        self,
        desks: Any,
        settings: Settings,
        today: Callable[[], dt.date] = dt.date.today,
        new_id: Callable[[], str] = _new_id,
        team: bool = False,
    ):
        self.desks = desks
        self.settings = settings
        self.today = today
        self.new_id = new_id
        self.team = team

    async def handle(self, state: dict[str, Any] | None, msg: Incoming, desks: Any = None) -> Turn:
        s = dict(state or {})
        first = not s.get("seen")
        s["seen"] = True
        talk = _Talk(self, s, desks or self.desks)
        try:
            replies, intent = await talk.route(msg)
        except DeskDown as exc:
            replies, intent = [Reply(down_text(exc.desk))], f"{exc.desk}_down"
        except Failure as exc:
            replies, intent = [Reply(trouble_text(exc.reply))], "api_error"
        if first and replies and intent != "welcome" and not replies[0].text.startswith(STORY_NOTE):
            replies[0].text = f"{FIRST_NOTE}\n\n{replies[0].text}"
        return Turn(replies, s, intent)

    def welcome(self) -> Reply:
        return Reply(WELCOME + (f"\n\n{TEAM}" if self.team else ""), card=welcome_card(), card_id=str(uuid.uuid4()))


def down_text(desk: str) -> str:
    who = DESK_NAMES.get(desk, "a helper agent")
    if desk == "law":
        return f"{who[0].upper()}{who[1:]} isn't answering right now, so I can't look up the rules. Nothing was saved and no money moved. Please try again in a minute."
    return f"{who[0].upper()}{who[1:]} isn't answering right now, so I can't run that step of the demo. No money moved. Please try again in a minute."


def trouble_text(reply: Any) -> str:
    if reply.error == "api_down":
        return TROUBLE
    if reply.error == "nothing_to_pay":
        return reply.text
    detail = f" ({reply.status})" if reply.status else ""
    return f"Something went wrong on Tend's server{detail}: {reply.text} Nothing was saved and no money moved."


class _Talk:
    """One turn of one person's conversation: their session state and the desks for this turn."""

    def __init__(self, nav: Navigator, s: dict[str, Any], desks: Any):
        self.nav = nav
        self.s = s
        self.d = desks

    # ------------------------------------------------------------ calling the other agents

    async def law(self, req: Any) -> Any:
        reply = await self.d.law(req)
        if not reply.ok:
            raise Failure(reply)
        return reply

    async def bank(self, req: Any, *, allow: tuple[str, ...] = ()) -> Any:
        reply = await self.d.bank(req)
        if not reply.ok and reply.error not in allow:
            raise Failure(reply)
        return reply

    def demo_ref(self) -> DemoRef:
        return DemoRef(**self.s["demo"]["ref"])

    # ------------------------------------------------------------ routing

    async def route(self, msg: Incoming) -> tuple[list[Reply], str]:
        text = msg.text.strip()
        sel = msg.selection
        if sel is None:
            sel = selection_from_text(text)
            if sel is not None:
                text = ""
        if msg.cancelled:
            return self.cancel_all(), "cancel"
        if sel:
            return await self.on_selection(sel, text)
        if not text:
            return [self.nav.welcome()], "welcome"
        kind = story_kind(text)
        replies, intent = await self.route_text(text, kind is not None)
        # A plain question that names a partner ("Can my partner apply?") is guarded without a note.
        note = kind == "act" or (kind == "context" and not QUESTION_START.match(text))
        if note and replies and not replies[0].text.startswith(STORY_NOTE):
            lead = STORY_NOTE + (f" {HOTLINE}" if kind == "act" else "")
            replies[0].text = f"{lead}\n\n{replies[0].text}"
        return replies, intent

    async def route_text(self, text: str, story: bool) -> tuple[list[Reply], str]:
        """Typed text (or planner prose). When it tells a story, only fields and topics are used, never the text."""
        s = self.s
        pending = self.live_pending()
        if pending:
            code = find_confirm_code(text)
            if code:
                return await self.confirm(code), "pay_confirm"
            if wants_payment_status(text):
                return await self.payment_status(), "pay_status"
            if wants_cancel(text) or says_no(text):
                return self.cancel_payment(), "pay_cancel"
            if says_yes(text) or wants_pay(text):
                return [Reply(type_code_hint(pending))], "pay_remind"
        elif find_confirm_code(text):
            if s.pop("pending_expired", False):
                return [Reply("That code has expired, so nothing moved. Say **pay the bill** for a new code.")], "pay_stale"
            return [Reply("There is no payment waiting, so nothing moved. In the demo, say **pay the bill** for a new code.")], "pay_stale"

        demo = s.get("demo")
        stage = (demo or {}).get("stage")
        # Before the demo keyword, so "share the demo claim" or "pay the demo bill" does not start over.
        if demo and wants_share(text):
            return await self.share(), "share"
        if demo and wants_pay(text):
            return await self.propose(), "pay_propose"
        if wants_demo(text):
            return await self.start_demo(find_state(text)), "demo"
        if wants_payment_status(text):
            if demo and demo.get("paid_cents"):
                return [
                    Reply(f"The demo payment went through: {money(demo['paid_cents'])} to the hospital, from the mock bank.")
                ], "pay_status"
            return [Reply("There is no payment to check in this chat.")], "pay_none"
        if demo and stage == "scanned":
            if says_yes(text):
                return await self.count(), "count"
            if says_no(text) or wants_cancel(text):
                demo["stage"] = "skipped"
                return [Reply("OK. Nothing was counted. Say **demo** any time to start over.", end_session=True)], "skip"
        if not demo and wants_pay(text) and _BILL_ONLY.search(text):
            return [Reply("There is no bill to pay in this chat yet. Say **demo** to walk through the fictional claim first.")], "pay_none"
        if not demo and wants_share(text):
            return [
                Reply("There is no claim to share in this chat yet. Say **demo** to walk through the fictional claim first.")
            ], "share_none"
        if THANKS.search(text) and len(text) < 40:
            return [Reply("You're welcome. I'm here if you have another question.", end_session=True)], "thanks"
        if COVERAGE_Q.search(text):
            reply = await self.law(LawCoverageRequest(request_id=self.nav.new_id()))
            return [Reply(reply.text)], "coverage"

        st = find_state(text)
        today = self.nav.today()
        found = find_date(text, today)
        exam, report = find_exam(text), find_report(text)
        awaiting = s.pop("awaiting", None) or {}

        if awaiting.get("kind") == "check" and (st or awaiting.get("st")):
            fields = {
                "date": found.date.isoformat() if found and not found.future else awaiting.get("date"),
                "exam": exam or awaiting.get("exam"),
                "report": report or awaiting.get("report"),
            }
            return await self.check(st or awaiting["st"], fields, future=bool(found and found.future)), "check"

        topics, expense = find_topics(text), find_expense(text)
        if wants_check(text) or (asks_eligibility(text) and (found or exam or report)):
            fields = {"date": found.date.isoformat() if found and not found.future else None, "exam": exam, "report": report}
            if st:
                return await self.check(st, fields, future=bool(found and found.future)), "check"
            s["awaiting"] = {"kind": "check", **fields}
            return [
                Reply("Which state? Pick it on the card, or type the name.", card=check_form(), card_id=str(uuid.uuid4()))
            ], "check_form"

        if awaiting.get("kind") == "question" and st and not topics and not expense:
            topics, expense = awaiting.get("topics") or [], awaiting.get("expense")
            return await self.answer(st, None, topics, expense), "answer"

        if is_greeting(text) and not st and not topics and not expense:
            return [self.nav.welcome()], "welcome"

        st = st or s.get("st")
        if not st:
            if topics or expense or "?" in text or story:
                s["awaiting"] = {"kind": "question", "topics": topics, "expense": expense}
                return [Reply("Which state is this about? You can type a name like Ohio, or DC.")], "ask_state"
            return [self.nav.welcome()], "welcome"
        if story and not topics and not expense:
            return [Reply(f"What would you like to know about the {state_name(st)} program?")], "story"
        return await self.answer(st, None if story else text, topics, expense), "answer"

    async def on_selection(self, sel: dict[str, Any], text: str) -> tuple[list[Reply], str]:
        s = self.s
        action = str(sel.get("action") or "")
        pending = self.live_pending()
        if action == "check_form":
            s["awaiting"] = {"kind": "check"}
            card = check_form(s.get("st"))
            return [
                Reply('Fill in what you know. Every answer except the state can be "not sure".', card=card, card_id=str(uuid.uuid4()))
            ], "check_form"
        if action == "check":
            st = str(sel.get("st") or "").upper()
            if st not in STATES:
                s["awaiting"] = {"kind": "check"}
                return [Reply("Pick a state first.", card=check_form(), card_id=str(uuid.uuid4()))], "check_form"
            raw_date = str(sel.get("incident_date") or "").strip()
            date = parse_iso_date(raw_date)
            if raw_date and date is None:
                found = find_date(raw_date, self.nav.today())
                date = found.date if found else None
            future = bool(date and date > self.nav.today())
            fields = {
                "date": date.isoformat() if date and not future else None,
                "exam": sel.get("forensic_exam"),
                "report": sel.get("police_report"),
            }
            s.pop("awaiting", None)
            return await self.check(st, fields, future=future, unreadable_date=bool(raw_date and date is None)), "check"
        if action == "demo":
            return await self.start_demo(None), "demo"
        if action == "count_costs":
            demo = s.get("demo") or {}
            if demo.get("stage") == "scanned" and sel.get("scan_id") in (None, demo["ref"].get("scan_id")):
                return await self.count(), "count"
            return [Reply("That demo has ended. Say **demo** to start a new one.")], "stale"
        if action == "skip_costs":
            if s.get("demo"):
                s["demo"]["stage"] = "skipped"
            return [Reply("OK. Nothing was counted. Say **demo** any time to start over.", end_session=True)], "skip"
        if action == "pay":
            if s.get("demo"):
                return await self.propose(), "pay_propose"
            return [Reply("There is no bill to pay in this chat yet. Say **demo** to start.")], "pay_none"
        if action == "share":
            if s.get("demo"):
                return await self.share(), "share"
            return [Reply("There is no claim to share in this chat yet. Say **demo** to start.")], "share_none"
        if action in ("pay_approve", "pay_confirm", "pay_cancel"):
            if not pending or sel.get("action_id") not in (None, pending["action_id"]):
                return [Reply("That payment is no longer waiting. Nothing moved. Say **pay the bill** for a new code.")], "stale"
            if action == "pay_cancel":
                return self.cancel_payment(), "pay_cancel"
            code = find_confirm_code(str(sel.get("code") or "")) if sel.get("code") else None
            if action == "pay_confirm" and code:
                return await self.confirm(code), "pay_confirm"
            return [
                Reply(
                    "Type the 6-digit code from the review card, here or in this box. Only you can approve the payment.",
                    card=code_form(pending["action_id"], pending["amount_cents"]),
                    card_id=str(uuid.uuid4()),
                )
            ], "pay_code_form"
        if text:
            return await self.route(Incoming(text=text))
        return [self.nav.welcome()], "welcome"

    # ------------------------------------------------------------ the Law agent: cited answers and Checks

    async def answer(self, st: str, question: str | None, topics: list[str], expense: str | None) -> list[Reply]:
        """question is None when the person's words must not leave the Navigator: the Law agent then answers a
        question rebuilt from the topic alone."""
        self.s["st"] = st
        reply = await self.law(LawAnswerRequest(request_id=self.nav.new_id(), st=st, question=question, topics=topics, expense=expense))
        return [Reply(reply.text)]

    async def check(self, st: str, fields: dict[str, Any], *, future: bool = False, unreadable_date: bool = False) -> list[Reply]:
        self.s["st"] = st
        req = LawCheckRequest(
            request_id=self.nav.new_id(),
            st=st,
            incident_date=fields.get("date"),
            forensic_exam=exam_value(fields.get("exam")),
            police_report=report_value(fields.get("report")),
        )
        reply = await self.law(req)
        text = reply.text
        if future:
            text = "That date is in the future, so I left it out.\n\n" + text
        elif unreadable_date:
            text = "I couldn't read that date, so I left it out. Use a form like 2026-06-14.\n\n" + text
        if not self.s.get("demo"):
            text += "\n\nTo see how a claim comes together, say **show me the demo claim**. It uses a fictional person."
        return [Reply(text)]

    # ------------------------------------------------------------ the Bank and Packet agent: the fictional demo

    async def start_demo(self, st: str | None) -> list[Reply]:
        reply = await self.bank(DemoStartRequest(request_id=self.nav.new_id(), st=st))
        ref = reply.demo.model_dump()
        self.s["demo"] = {"ref": ref, "stage": "scanned"}
        self.s.pop("pending", None)
        bill = {"lines": ref["bill_lines"], "total_cents": ref["bill_total_cents"]} if ref.get("bill_lines") else None
        card = count_costs_card([g.model_dump() for g in reply.groups], bill, scan_id=ref["scan_id"])
        text = reply.text + "\n\nNothing counts until the survivor says yes. Count these for the demo claim? Say **yes** or **not now**."
        return [Reply(text, card=card, card_id=str(uuid.uuid4()))]

    async def count(self) -> list[Reply]:
        demo = self.s["demo"]
        reply = await self.bank(DemoCountRequest(request_id=self.nav.new_id(), demo=self.demo_ref()))
        demo["stage"] = "counted"
        ref = demo["ref"]
        replies = [Reply(reply.text)]
        nxt = self.next_step_text(ref, paid=False)
        if reply.letter:
            letter = (
                "**Letter to the billing office.** Copy it, fill in the [brackets], and send it. It asks billing to "
                f"remove the exam line and quotes the law:\n\n```\n{reply.letter.rstrip()}\n```"
            )
            replies.append(Reply(f"{letter}\n\n{nxt}", card=next_steps_card(ref["payable_cents"], paid=False), card_id=str(uuid.uuid4())))
        else:
            replies.append(Reply(nxt, card=next_steps_card(ref["payable_cents"], paid=False), card_id=str(uuid.uuid4())))
        return replies

    def next_step_text(self, ref: dict[str, Any], *, paid: bool) -> str:
        share = "say **share with an advocate** for a locked link to this claim."
        if ref.get("payable_cents") and not paid:
            return (
                f"The rest of the hospital bill is **{money(ref['payable_cents'])}**. Want to pay it from {ref['account_label']} "
                f"(mock bank)? Say **pay the bill**. Nothing moves until you type a code. Or {share}"
            )
        return f"Next, {share}"

    async def propose(self) -> list[Reply]:
        demo = self.s["demo"]
        if demo.get("stage") == "scanned":
            return [Reply("Count the costs first: say **yes** to count them for the demo claim.")]
        if demo.get("paid_cents"):
            return [Reply("The demo bill is already paid. Say **share with an advocate** for the locked link, or **demo** to start over.")]
        reply = await self.bank(PayProposeRequest(request_id=self.nav.new_id(), demo=self.demo_ref()), allow=("nothing_to_pay",))
        if not reply.ok:
            return [Reply(reply.text)]
        card_id = str(uuid.uuid4())
        self.s["pending"] = {
            "action_id": reply.action_id,
            "amount_cents": reply.amount_cents,
            "expires_at": reply.expires_at,
            "card_id": card_id,
        }
        view = {
            "action_id": reply.action_id,
            "amount_cents": reply.amount_cents,
            "code": reply.confirm_code or "",
            "payee_label": reply.payee_label,
            "from_label": reply.from_label,
            "lines_label": reply.lines_label,
            "held_cents": reply.held_cents,
            "bank_label": "Dry run: recorded and read back, not sent" if reply.dry_run else "Nessie mock bank (a real API write)",
        }
        narration = (
            f"Here is the payment to review. **Nothing moves until you type the code.** To pay {money(reply.amount_cents)}, "
            f"type **{reply.confirm_code}** here. To stop, say cancel. The code works once and ends in 10 minutes. {FICTIONAL_SHORT}"
        )
        return [Reply(narration, card=payment_card(view), card_id=card_id)]

    async def confirm(self, code: str) -> list[Reply]:
        pending = self.s["pending"]
        req = PayConfirmRequest(request_id=self.nav.new_id(), action_id=pending["action_id"], confirm_code=code, demo=self.demo_ref())
        try:
            reply = await self.bank(req)
        except DeskDown:
            pending["unsure"] = True  # the code may have gone through; only a status check can say
            return [Reply(CONFIRM_UNSURE)]
        return self.after_payment(reply)

    async def payment_status(self) -> list[Reply]:
        pending = self.live_pending()
        if not pending or not self.s.get("demo"):
            return [Reply("There is no payment to check in this chat.")]
        action_id = pending["action_id"]
        reply = await self.bank(PayStatusRequest(request_id=self.nav.new_id(), action_id=action_id, demo=self.demo_ref()))
        if reply.outcome == "waiting" and pending and not pending.get("unsure"):
            return [Reply(type_code_hint(pending))]
        if reply.outcome == "waiting":
            self.s.pop("pending", None)
            return [Reply("The bank has not recorded that payment, so nothing moved. Say **pay the bill** for a new code.")]
        return self.after_payment(reply)

    def after_payment(self, reply: Any) -> list[Reply]:
        demo = self.s.get("demo") or {}
        if reply.outcome in ("done", "unverified"):
            self.s.pop("pending", None)
            demo["paid_cents"] = reply.amount_cents
            demo["stage"] = "paid" if demo.get("stage") != "shared" else "shared"
            text = f"{reply.text}\n\n{self.next_step_text(demo.get('ref') or {}, paid=True)}"
            card = next_steps_card(0, paid=True)
            return [Reply(text, card=card, card_id=str(uuid.uuid4()))]
        if reply.outcome == "wrong_code":
            return [Reply("That code does not match. Nothing moved. Check the code on the review card and type it again.")]
        self.s.pop("pending", None)
        lead = {
            "expired": "That code expired. Nothing moved. Say **pay the bill** for a new code.",
            "locked": "Too many wrong codes, so this payment is locked. Nothing moved. Say **pay the bill** to start again.",
            "not_found": "That payment is no longer waiting. Nothing moved. Say **pay the bill** for a new code.",
        }.get(reply.outcome, reply.text or "The payment did not go through. Nothing moved.")
        return [Reply(lead)]

    async def share(self) -> list[Reply]:
        demo = self.s["demo"]
        if demo.get("stage") in ("scanned", "skipped"):
            return [Reply("Count the demo claim first, so the link has something to show. Say **yes** to count the costs.")]
        req = PacketShareRequest(
            request_id=self.nav.new_id(),
            demo=self.demo_ref(),
            paid_cents=int(demo.get("paid_cents") or 0),
            hours=self.nav.settings.share_hours,
        )
        reply = await self.bank(req)
        demo["stage"] = "shared"
        expires = long_date(reply.expires_at) if reply.expires_at else "when it expires"
        card = share_card(expires, reply.still_needed)
        return [Reply(reply.text, card=card, card_id=str(uuid.uuid4()), end_session=True)]

    # ------------------------------------------------------------ payments waiting for a code

    def cancel_payment(self) -> list[Reply]:
        self.s.pop("pending", None)
        return [Reply("Cancelled. No money moved. The code will not work from this chat.", end_session=True)]

    def cancel_all(self) -> list[Reply]:
        had_payment = self.s.pop("pending", None) is not None
        self.s.pop("awaiting", None)
        return [Reply("Cancelled. No money moved." if had_payment else "OK. Nothing was changed.", end_session=True)]

    def live_pending(self) -> dict[str, Any] | None:
        pending = self.s.get("pending")
        if not pending:
            return None
        expires = pending.get("expires_at")
        if isinstance(expires, str) and not pending.get("unsure"):
            try:
                at = dt.datetime.fromisoformat(expires.replace("Z", "+00:00"))
                if at <= dt.datetime.now(dt.UTC):
                    self.s.pop("pending", None)
                    self.s["pending_expired"] = True
                    return None
            except ValueError:
                pass
        return pending


def type_code_hint(pending: dict[str, Any]) -> str:
    return (
        f"To pay {money(pending['amount_cents'])}, type the 6-digit code from the review card. "
        "That step makes sure a person approves every payment. Say cancel to stop."
    )


__all__ = ["Navigator", "Reply", "Turn", "Failure", "WELCOME", "STORY_NOTE", "FIRST_NOTE"]
