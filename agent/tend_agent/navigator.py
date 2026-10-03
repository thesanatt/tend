"""The conversation: one message in, replies out. No uAgents here, so every path is testable with a mocked API.

Session state holds ids, amounts, and short-lived choices. Never the text of a message, and never a confirm code:
the code is shown once on the review card and only the person can type it back.
"""

from __future__ import annotations

import datetime as dt
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel

from . import cards
from .api import ApiError, TendApi
from .check import render_check
from .config import Settings
from .demo import (
    FICTIONAL_SHORT,
    bill_summary,
    demo_state,
    groups,
    payment_body,
    payment_view,
    persona_for,
    render_claim,
    render_linked,
    render_paid,
    render_scan,
)
from .fmt import cite_block, cite_link, clean, expense_label, long_date, money, program_line
from .knowledge import MAX_QUOTED, RuleBook, answer_from_rules, cite
from .parse import (
    Incoming,
    asks_eligibility,
    exam_value,
    find_confirm_code,
    find_date,
    find_exam,
    find_expense,
    find_link_code,
    find_report,
    find_topics,
    is_greeting,
    looks_like_story,
    parse_iso_date,
    report_value,
    says_no,
    says_yes,
    selection_from_text,
    wants_cancel,
    wants_check,
    wants_demo,
    wants_pay,
)
from .states import STATES, find_state, state_name

WELCOME = (
    "Hi. I'm Tend Navigator. I help sexual assault survivors, and the advocates who support them, get the crime "
    "victim compensation their state already promises.\n\n"
    "- **Ask** about any state's program. I quote the law and link it, or I say I don't know.\n"
    "- **Check**: the state, the date it happened (only the date), and whether there was a forensic exam or a "
    "police report. I'll show the deadline, the police report rules, and what is covered.\n"
    "- **Demo**: walk through a fictional claim, including a mock bill payment that happens only after you type a code.\n\n"
    "You never need to tell me what happened, where, or who. I don't keep messages."
)
STORY_NOTE = (
    "You don't need to tell me what happened, where, or who, and I didn't pass that message on. "
    "I only need the state, and for a Check, the date."
)
TROUBLE = (
    "I can't reach Tend's server right now, so I can't look up the law. Nothing was saved and no money moved. Please try again in a minute."
)
COVERAGE_Q = re.compile(r"\b(?:which|what) (?:states|jurisdictions)\b|\ball (?:the )?states\b|\b50 states\b", re.I)
THANKS = re.compile(r"^\s*(?:thanks|thank you|thx|ty)\b", re.I)
CANONICAL = {
    "deadline": "What is the deadline to apply for crime victim compensation in {name}?",
    "reporting": "Does {name} require a police report for crime victim compensation?",
    "exam": "Can a sexual assault survivor in {name} be billed for a forensic exam, and who pays for it?",
    "time": "How long does {name}'s program take to decide a claim?",
    "privacy": "What privacy protections does {name} offer crime victim compensation applicants?",
    "emergency": "Does {name} offer an emergency award?",
    "minimum": "Is there a minimum loss to apply in {name}?",
    "insurance": "How does insurance affect a crime victim compensation claim in {name}?",
    "residency": "Who can apply for crime victim compensation in {name}?",
    "documents": "What documents does {name}'s program ask for?",
    "apply": "How do I apply for crime victim compensation in {name}?",
    "max": "What is the most {name}'s crime victim compensation program pays?",
    "covered": "What costs does {name}'s crime victim compensation program cover?",
    "excluded": "What does {name}'s crime victim compensation program not cover?",
    "eligibility": "Can a sexual assault survivor apply for crime victim compensation in {name}?",
    "contact": "How do I contact {name}'s crime victim compensation program?",
}


@dataclass
class Reply:
    text: str
    card: BaseModel | None = None
    card_id: str | None = None
    end_session: bool = False


@dataclass
class Turn:
    replies: list[Reply]
    state: dict[str, Any]
    intent: str = "other"


@dataclass
class Sessions:
    """In-memory sessions, never written to disk. Each one ends after two quiet hours."""

    ttl_s: float = 7200.0
    now: Any = time.monotonic
    _data: dict[str, tuple[float, dict[str, Any]]] = field(default_factory=dict)
    _locks: dict[str, Any] = field(default_factory=dict)

    def lock(self, key: str) -> Any:
        import asyncio

        if key not in self._locks:
            self._locks[key] = asyncio.Lock()
        return self._locks[key]

    def get(self, key: str) -> dict[str, Any]:
        hit = self._data.get(key)
        if hit is None or self.now() - hit[0] > self.ttl_s:
            self._data.pop(key, None)
            return {}
        return dict(hit[1])

    def put(self, key: str, state: dict[str, Any]) -> None:
        if state:
            self._data[key] = (self.now(), state)
        else:
            self._data.pop(key, None)
        for k in [k for k, (at, _) in self._data.items() if self.now() - at > self.ttl_s]:
            self._data.pop(k, None)
            self._locks.pop(k, None)

    def drop(self, key: str) -> None:
        self._data.pop(key, None)


def canonical_question(topics: list[str], expense: str | None, name: str) -> str:
    if expense and expense != "forensic_exam" and (not topics or topics[0] in ("covered", "max", "excluded", "eligibility")):
        return f"Does {name}'s crime victim compensation program cover {expense_label(expense).lower()}, and is there a limit?"
    if expense == "forensic_exam":
        return CANONICAL["exam"].format(name=name)
    topic = topics[0] if topics else "covered"
    return CANONICAL.get(topic, CANONICAL["covered"]).format(name=name)


def _first_str(data: dict[str, Any], *keys: str) -> str:
    for k in keys:
        v = data.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _first_list(data: dict[str, Any], *keys: str) -> list[dict[str, Any]]:
    for k in keys:
        v = data.get(k)
        if isinstance(v, list):
            return [c for c in v if isinstance(c, dict)]
    return []


CITATION_KEYS = ("citations", "rules", "sources", "cites", "evidence", "rule_ids")


def _unwrap(data: dict[str, Any]) -> dict[str, Any]:
    """Accept {"answer": {...}} or {"result": {...}} as well as a flat reply."""
    for key in ("answer", "result", "data"):
        inner = data.get(key)
        if isinstance(inner, dict):
            return {**data, **inner, key: inner.get("text") or inner.get("answer") or ""}
    return data


def citation_ids(data: dict[str, Any]) -> list[str]:
    """Rule ids given as plain strings, which need the state's rules to become quotes and links."""
    data = _unwrap(data)
    for k in CITATION_KEYS:
        v = data.get(k)
        if isinstance(v, list) and v:
            return [c for c in v if isinstance(c, str)]
    return []


def _citations(data: dict[str, Any], book: RuleBook | None) -> list[dict[str, Any]]:
    for k in CITATION_KEYS:
        v = data.get(k)
        if isinstance(v, list) and v:
            out = []
            for c in v:
                if isinstance(c, dict):
                    out.append(c)
                elif isinstance(c, str) and book is not None and c in book.by_id:
                    out.append(cite(book.by_id[c], book.sources))
            return out
    return []


def _known(data: dict[str, Any], cites: list[dict[str, Any]]) -> bool:
    for key in ("known", "answered", "found", "supported"):
        if isinstance(data.get(key), bool):
            return data[key]
    status = str(data.get("status") or "").lower()
    if status in {"unknown", "no_rule", "not_found", "dont_know", "unsupported", "none", "refused"}:
        return False
    return bool(cites)


def render_api_answer(data: dict[str, Any], name: str, book: RuleBook | None = None) -> str:
    """An answer from /api/agent/answer, whatever its exact field names. Rule ids given as strings are turned
    into quotes and links with the state's verified rules (book)."""
    data = _unwrap(data)
    text = _first_str(data, "answer", "text", "summary", "message")
    cites = _citations(data, book)
    sentences = _first_list(data, "sentences")
    if not _known(data, cites) and not sentences:
        head = text if text and "know" in text.lower() else f"I don't know. No verified rule in {name} answers that."
        if text and head is not text:
            head += f"\n\n{text}"
        program = program_line(data.get("program"), name)
        return head + (f"\n\nThe program can help: {program}." if program else "")
    parts = [text] if text else []
    for s in sentences:
        links = ", ".join(cite_link(c) for c in s.get("citations") or [] if isinstance(c, dict))
        parts.append(f"- {clean(s.get('text'))}" + (f" ({links})" if links else ""))
    if cites:
        quoted = [cite_block(c) for c in cites[:MAX_QUOTED]]
        more = [cite_link(c) for c in cites[MAX_QUOTED:]]
        parts.append("\n\n".join(quoted) + ("\n\nMore: " + ", ".join(more) if more else ""))
    return "\n\n".join(p for p in parts if p)


def _looks_like_check(data: Any) -> bool:
    return isinstance(data, dict) and any(k in data for k in ("deadline", "reporting", "sentences"))


class Navigator:
    def __init__(self, api: TendApi, settings: Settings, today: Any = dt.date.today):
        self.api = api
        self.settings = settings
        self.today = today

    async def handle(self, state: dict[str, Any] | None, msg: Incoming) -> Turn:
        s = dict(state or {})
        try:
            replies, intent = await self._route(s, msg)
        except ApiError as exc:
            replies, intent = [Reply(self._trouble(exc))], "api_error"
        return Turn(replies, s, intent)

    # ------------------------------------------------------------ routing

    async def _route(self, s: dict[str, Any], msg: Incoming) -> tuple[list[Reply], str]:
        text = msg.text.strip()
        sel = msg.selection
        if sel is None:
            sel = selection_from_text(text)
            if sel is not None:
                text = ""
        if msg.cancelled:
            return self._cancel_all(s), "cancel"
        if sel:
            return await self._on_selection(s, sel, text)
        if not text:
            return [Reply(WELCOME, card=cards.welcome_card())], "welcome"
        story = looks_like_story(text)
        replies, intent = await self._route_text(s, text, story)
        if story and replies and not replies[0].text.startswith(STORY_NOTE):
            replies[0].text = f"{STORY_NOTE}\n\n{replies[0].text}"
        return replies, intent

    async def _route_text(self, s: dict[str, Any], text: str, story: bool) -> tuple[list[Reply], str]:
        """Typed text (or planner prose). When it tells a story, only fields and topics are used, never the text."""
        pending = self._live_pending(s)
        if pending:
            code = find_confirm_code(text)
            if code:
                return await self._confirm(s, code), "pay_confirm"
            if wants_cancel(text) or says_no(text):
                return self._cancel_payment(s), "pay_cancel"
            if says_yes(text) or wants_pay(text):
                return [Reply(self._type_code_hint(pending))], "pay_remind"

        elif find_confirm_code(text):
            if s.pop("pending_expired", False):
                return [Reply("That code has expired, so nothing moved. Say **pay the bill** for a new code.")], "pay_stale"
            return [Reply("There is no payment waiting, so nothing moved. In the demo, say **pay the bill** for a new code.")], "pay_stale"

        link = find_link_code(text)
        if link:
            return await self._linked(s, link), "link"
        if wants_demo(text):
            return await self._start_demo(s, find_state(text)), "demo"

        demo = s.get("demo")
        if demo and demo.get("stage") == "scanned":
            if says_yes(text) and not wants_pay(text):
                return await self._count(s), "count"
            if says_no(text) or wants_cancel(text):
                demo["stage"] = "skipped"
                return [Reply("OK. Nothing was counted. Say **demo** any time to start over.", end_session=True)], "skip"
        if demo and wants_pay(text):
            return await self._propose(s), "pay_propose"
        if THANKS.search(text) and len(text) < 40:
            return [Reply("You're welcome. I'm here if you have another question.", end_session=True)], "thanks"
        if COVERAGE_Q.search(text):
            return await self._coverage(), "coverage"

        st = find_state(text)
        today = self.today()
        found = find_date(text, today)
        exam, report = find_exam(text), find_report(text)
        awaiting = s.pop("awaiting", None) or {}

        if awaiting.get("kind") == "check" and (st or awaiting.get("st")):
            fields = {
                "date": found.date.isoformat() if found and not found.future else awaiting.get("date"),
                "exam": exam or awaiting.get("exam"),
                "report": report or awaiting.get("report"),
            }
            return await self._check(s, st or awaiting["st"], fields, future=bool(found and found.future)), "check"

        topics, expense = find_topics(text), find_expense(text)
        if wants_check(text) or (asks_eligibility(text) and (found or exam or report)):
            fields = {"date": found.date.isoformat() if found and not found.future else None, "exam": exam, "report": report}
            if st:
                return await self._check(s, st, fields, future=bool(found and found.future)), "check"
            s["awaiting"] = {"kind": "check", **fields}
            return [Reply("Which state? Pick it on the card, or type the name.", card=cards.check_form())], "check_form"

        if awaiting.get("kind") == "question" and st and not topics and not expense:
            topics, expense = awaiting.get("topics") or [], awaiting.get("expense")
            return await self._answer(s, st, None, topics, expense), "answer"

        if is_greeting(text) and not st and not topics and not expense:
            return [Reply(WELCOME, card=cards.welcome_card())], "welcome"

        st = st or s.get("st")
        if not st:
            if topics or expense or "?" in text or story:
                s["awaiting"] = {"kind": "question", "topics": topics, "expense": expense}
                return [Reply("Which state is this about? You can type a name like Ohio, or DC.")], "ask_state"
            return [Reply(WELCOME, card=cards.welcome_card())], "welcome"
        if story and not topics and not expense:
            return [Reply(f"What would you like to know about the {state_name(st)} program?")], "story"
        return await self._answer(s, st, None if story else text, topics, expense), "answer"

    async def _on_selection(self, s: dict[str, Any], sel: dict[str, Any], text: str) -> tuple[list[Reply], str]:
        action = str(sel.get("action") or "")
        pending = self._live_pending(s)
        if action == "check_form":
            s["awaiting"] = {"kind": "check"}
            return [
                Reply('Fill in what you know. Every answer except the state can be "not sure".', card=cards.check_form(s.get("st")))
            ], "check_form"
        if action == "check":
            st = str(sel.get("st") or "").upper()
            if st not in STATES:
                s["awaiting"] = {"kind": "check"}
                return [Reply("Pick a state first.", card=cards.check_form())], "check_form"
            raw_date = str(sel.get("incident_date") or "").strip()
            date = parse_iso_date(raw_date)
            if raw_date and date is None:
                found = find_date(raw_date, self.today())
                date = found.date if found else None
            future = bool(date and date > self.today())
            fields = {
                "date": date.isoformat() if date and not future else None,
                "exam": sel.get("forensic_exam"),
                "report": sel.get("police_report"),
            }
            s.pop("awaiting", None)
            return await self._check(s, st, fields, future=future, unreadable_date=bool(raw_date and date is None)), "check"
        if action == "demo":
            return await self._start_demo(s, None), "demo"
        if action == "count_costs":
            demo = s.get("demo") or {}
            if demo.get("stage") == "scanned" and sel.get("scan_id") in (None, demo.get("scan_id")):
                return await self._count(s), "count"
            return [Reply("That demo has ended. Say **demo** to start a new one.")], "stale"
        if action == "skip_costs":
            if s.get("demo"):
                s["demo"]["stage"] = "skipped"
            return [Reply("OK. Nothing was counted. Say **demo** any time to start over.", end_session=True)], "skip"
        if action in ("pay_approve", "pay_confirm", "pay_cancel"):
            if not pending or sel.get("action_id") not in (None, pending["action_id"]):
                return [Reply("That payment is no longer waiting. Nothing moved. Say **pay the bill** for a new code.")], "stale"
            if action == "pay_cancel":
                return self._cancel_payment(s), "pay_cancel"
            code = find_confirm_code(str(sel.get("code") or "")) if sel.get("code") else None
            if action == "pay_confirm" and code:
                return await self._confirm(s, code), "pay_confirm"
            return [
                Reply(
                    "Type the 6-digit code from the review card, here or in this box. Only you can approve the payment.",
                    card=cards.code_form(pending["action_id"], pending["amount_cents"]),
                )
            ], "pay_code_form"
        if text:
            return await self._route(s, Incoming(text=text))
        return [Reply(WELCOME, card=cards.welcome_card())], "welcome"

    # ------------------------------------------------------------ law questions and Checks

    async def _book(self, st: str) -> RuleBook | None:
        try:
            return RuleBook(await self.api.jurisdiction(st))
        except ApiError:
            return None

    async def _answer(self, s: dict[str, Any], st: str, question: str | None, topics: list[str], expense: str | None) -> list[Reply]:
        """question is None when the person's words must not leave the agent; the API then gets a question
        rebuilt from the topic alone."""
        s["st"] = st
        name = state_name(st)
        try:
            data = await self.api.answer(question or canonical_question(topics, expense, name), st)
            book = await self._book(st) if isinstance(data, dict) and citation_ids(data) else None
            text = render_api_answer(data, name, book) if isinstance(data, dict) else ""
        except ApiError as exc:
            if exc.status == 0 and not exc.route_missing:
                raise
            text = ""
        if not text:
            doc = await self.api.jurisdiction(st)
            text = answer_from_rules(doc, question or "", topics=topics, expense=expense).text
        return [Reply(text, end_session=True)]

    async def _check(
        self, s: dict[str, Any], st: str, fields: dict[str, Any], *, future: bool = False, unreadable_date: bool = False
    ) -> list[Reply]:
        s["st"] = st
        name = state_name(st)
        exam = exam_value(fields.get("exam"))
        report = report_value(fields.get("report"))
        date = fields.get("date")
        try:
            data = await self.api.check(st, date, exam, report)
            if not _looks_like_check(data):
                raise ApiError(422, "unexpected shape")
        except ApiError as exc:
            if exc.status == 0 and not exc.route_missing:
                raise
            data = await self.api.checklist(st, date, exam, report)
        book = await self._book(st)
        text = render_check(data, book, st=st, name=name, incident_date=date, exam=exam, report=report, app_url=self.settings.app_url)
        if future:
            text = "That date is in the future, so I left it out.\n\n" + text
        elif unreadable_date:
            text = "I couldn't read that date, so I left it out. Use a form like 2026-06-14.\n\n" + text
        return [Reply(text, end_session=True)]

    async def _coverage(self) -> list[Reply]:
        found = await self.api.jurisdictions()
        count = len(found)
        return [
            Reply(
                f"I have verified rules for {count} jurisdictions: all 50 states and DC. Every rule is a verbatim quote "
                "from an official source, saved with its link. Ask about any of them.",
                end_session=True,
            )
        ]

    # ------------------------------------------------------------ the fictional demo claim

    async def _start_demo(self, s: dict[str, Any], st: str | None) -> list[Reply]:
        persona, st = persona_for(st, self.settings.demo_persona)
        scan = await self.api.scan(persona, st)
        bill_id = next((d.get("bill_id") for d in scan.get("documents") or [] if d.get("bill_id")), None)
        audit = None
        if bill_id:
            try:
                audit = await self.api.audit_bill(bill_id, persona, scan["scan_id"])
            except ApiError as exc:
                if exc.status == 0:
                    raise
        demo = demo_state(scan, audit, persona)
        demo["stage"] = "scanned"
        demo["who"] = scan.get("display_name") or "the demo person"
        demo["input"] = _strip_input(scan, audit)
        s["demo"] = demo
        s.pop("pending", None)
        text = render_scan(scan, audit, state_name(st))
        card = cards.count_costs_card(groups(scan), bill_summary(audit), scan_id=scan["scan_id"])
        return [Reply(text, card=card, card_id=str(uuid.uuid4()))]

    async def _count(self, s: dict[str, Any]) -> list[Reply]:
        demo = s["demo"]
        claim = await self.api.claim(demo.pop("input"), demo["scan_id"])
        demo["claim_id"] = claim.get("claim_id")
        demo["stage"] = "counted"
        book = await self._book(demo["st"]) or RuleBook({"jurisdiction": demo["st"], "name": state_name(demo["st"])})
        return [Reply(render_claim(claim, book, demo, demo.get("who") or "the demo person"))]

    async def _propose(self, s: dict[str, Any]) -> list[Reply]:
        demo = s["demo"]
        if demo.get("paid"):
            return [Reply("The demo bill is already paid. Say **demo** to start over.", end_session=True)]
        if not demo.get("payable_cents") or not demo.get("bill_id"):
            return [Reply("There is nothing left to pay on the demo bill.", end_session=True)]
        proposal = await self.api.propose(payment_body(demo))
        view = payment_view(proposal, demo)
        card_id = str(uuid.uuid4())
        s["pending"] = {
            "action_id": proposal["action_id"],
            "amount_cents": view["amount_cents"],
            "expires_at": proposal.get("expires_at"),
            "card_id": card_id,
        }
        narration = (
            f"Here is the payment to review. **Nothing moves until you type the code.** To pay {money(view['amount_cents'])}, "
            f"type **{view['code']}** here. To stop, say cancel. The code works once and ends in 10 minutes. {FICTIONAL_SHORT}"
        )
        return [Reply(narration, card=cards.payment_card(view), card_id=card_id)]

    async def _confirm(self, s: dict[str, Any], code: str) -> list[Reply]:
        pending = s["pending"]
        try:
            result = await self.api.confirm(pending["action_id"], code)
        except ApiError as exc:
            if exc.status == 403:
                return [Reply("That code does not match. Nothing moved. Check the code on the review card and type it again.")]
            if exc.status in (409, 410, 423, 502, 404):
                s.pop("pending", None)
                lead = {
                    410: "That code expired. Nothing moved. Say **pay the bill** for a new code.",
                    423: "Too many wrong codes, so this payment is locked. Nothing moved. Say **pay the bill** to start again.",
                }.get(exc.status, exc.message)
                return [Reply(lead, end_session=True)]
            raise
        s.pop("pending", None)
        demo = s.get("demo") or {}
        demo["paid"] = True
        demo["stage"] = "paid"
        book = await self._book(demo.get("st") or "") if demo.get("st") else None
        return [Reply(render_paid(result, demo, book), end_session=True)]

    def _cancel_payment(self, s: dict[str, Any]) -> list[Reply]:
        s.pop("pending", None)
        return [Reply("Cancelled. No money moved. The code will not work from this chat.", end_session=True)]

    def _cancel_all(self, s: dict[str, Any]) -> list[Reply]:
        had_payment = s.pop("pending", None) is not None
        s.pop("awaiting", None)
        return [Reply("Cancelled. No money moved." if had_payment else "OK. Nothing was changed.", end_session=True)]

    def _live_pending(self, s: dict[str, Any]) -> dict[str, Any] | None:
        pending = s.get("pending")
        if not pending:
            return None
        expires = pending.get("expires_at")
        if isinstance(expires, str):
            try:
                at = dt.datetime.fromisoformat(expires.replace("Z", "+00:00"))
                if at <= dt.datetime.now(dt.UTC):
                    s.pop("pending", None)
                    s["pending_expired"] = True
                    return None
            except ValueError:
                pass
        return pending

    def _type_code_hint(self, pending: dict[str, Any]) -> str:
        return (
            f"To pay {money(pending['amount_cents'])}, type the 6-digit code from the review card. "
            "That step makes sure a person approves every payment. Say cancel to stop."
        )

    # ------------------------------------------------------------ a claim linked from the Tend app

    async def _linked(self, s: dict[str, Any], code: str) -> list[Reply]:
        try:
            redeemed = await self.api.redeem(code)
        except ApiError as exc:
            if exc.status in (404, 422):
                return [Reply("That link code is not valid, was already used, or has expired. Ask Tend for a new one.")]
            raise
        summary = await self.api.linked_claim(redeemed["agent_token"])
        packet = redeemed.get("packet_path") or ""
        packet_url = f"{self.api.base_url}{packet}" if packet.startswith("/") else packet
        return [Reply(render_linked(summary, self.settings.app_url, packet_url), end_session=True)]

    def _trouble(self, exc: ApiError) -> str:
        if exc.status == 0:
            return TROUBLE
        return f"Something went wrong on Tend's server ({exc.status}): {exc.message} Nothing was saved and no money moved."


def _strip_input(scan: dict[str, Any], audit: dict[str, Any] | None) -> dict[str, Any]:
    """The engine input with every cost confirmed and the merchant text removed (the API checks ids, dates, and amounts)."""
    from .demo import confirmed_input

    body = confirmed_input(scan, audit)
    keep = ("item_id", "date", "amount_cents", "expense", "confirmed", "insurance_paid_cents", "is_bill", "units", "unit", "tags")
    return {**body, "items": [{k: i[k] for k in keep if k in i} for i in body["items"]]}


__all__ = ["Navigator", "Reply", "Sessions", "Turn", "canonical_question", "render_api_answer", "long_date"]
