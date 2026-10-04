"""The Law agent's work: cited answers and Checks from the verified corpus, through the Tend API.

Every sentence it sends back points at a rule with a verbatim quote and a link. When no verified rule supports an
answer, it says the answer is not in the rules it has, and gives the program's contact instead of guessing.
"""

from __future__ import annotations

from typing import Any

from .api import ApiError, TendApi
from .check import render_check
from .desks import Idempotent, failure
from .fmt import cite_block, cite_link, clean, expense_label, program_line
from .knowledge import MAX_QUOTED, NOT_IN_RULES, RuleBook, answer_from_rules, cite
from .messages import LawAnswerRequest, LawCheckRequest, LawCoverageRequest, LawReply
from .settings import Settings
from .states import state_name

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
CITATION_KEYS = ("citations", "rules", "sources", "cites", "evidence", "rule_ids")
REFUSED = {"unknown", "no_rule", "not_found", "dont_know", "unsupported", "none", "refused"}


def canonical_question(topics: list[str], expense: str | None, name: str) -> str:
    """A question rebuilt from the topic alone, for when the person's own words must not leave the Navigator."""
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
    for key in ("answered", "known", "found", "supported"):
        if isinstance(data.get(key), bool):
            return data[key]
    if str(data.get("status") or data.get("reason") or "").lower() in REFUSED:
        return False
    return bool(cites)


def answered(data: dict[str, Any]) -> bool:
    data = _unwrap(data)
    return _known(data, _citations(data, None)) or bool(data.get("sentences"))


def render_api_answer(data: dict[str, Any], name: str, book: RuleBook | None = None) -> tuple[str, bool]:
    """(text, known) for a reply from /api/agent/answer. Rule ids given as strings become quotes and links. A refusal
    names the program from the state's verified rules (book) when it has them."""
    data = _unwrap(data)
    cites = _citations(data, book)
    sentences = [s for s in data.get("sentences") or [] if isinstance(s, dict)]
    if not _known(data, cites) and not sentences:
        text = f"{NOT_IN_RULES} I found no verified {name} rule that answers it, so I won't guess."
        program = program_line((book.doc.get("program") if book else None) or data.get("program") or data.get("contact"), name)
        return text + (f"\n\nThe program can answer it: {program}." if program else ""), False
    parts = [_first_str(data, "answer", "text", "summary")]
    for s in sentences:
        links = ", ".join(cite_link(c) for c in s.get("citations") or [] if isinstance(c, dict))
        parts.append(f"- {clean(s.get('text'))}" + (f" ({links})" if links else ""))
    if cites:
        quoted = [cite_block(c) for c in cites[:MAX_QUOTED]]
        more = [cite_link(c) for c in cites[MAX_QUOTED:]]
        parts.append("\n\n".join(quoted) + ("\n\nMore: " + ", ".join(more) if more else ""))
    return "\n\n".join(p for p in parts if p), True


def looks_like_check(data: Any) -> bool:
    return isinstance(data, dict) and any(k in data for k in ("deadline", "reporting", "sentences"))


class LawDesk:
    """What the Law agent does with each request. Stateless apart from the API client's 10-minute rule cache."""

    name = "law"

    def __init__(self, api: TendApi, settings: Settings):
        self.api = api
        self.settings = settings
        self._once = Idempotent()

    async def handle(self, req: Any) -> LawReply:
        return await self._once.run(req.request_id, lambda: self._handle(req))

    async def _handle(self, req: Any) -> LawReply:
        try:
            if isinstance(req, LawAnswerRequest):
                return await self._answer(req)
            if isinstance(req, LawCheckRequest):
                return await self._check(req)
            if isinstance(req, LawCoverageRequest):
                return await self._coverage(req)
            return LawReply(request_id=req.request_id, ok=False, error="bad_request", text="Unknown request.")
        except ApiError as exc:
            return LawReply(request_id=req.request_id, ok=False, **failure(exc))

    async def _book(self, st: str) -> RuleBook | None:
        try:
            return RuleBook(await self.api.jurisdiction(st))
        except ApiError:
            return None

    async def _answer(self, req: LawAnswerRequest) -> LawReply:
        name = state_name(req.st)
        text, known = "", True
        try:
            data = await self.api.answer(req.question or canonical_question(req.topics, req.expense, name), req.st)
            if isinstance(data, dict):
                # The rules are needed to quote rule ids given as plain strings, and to name the program in a refusal.
                book = await self._book(req.st) if citation_ids(data) or not answered(data) else None
                text, known = render_api_answer(data, name, book)
        except ApiError as exc:
            if exc.status == 0 and not exc.route_missing:
                raise
        if not text:  # the answer route is missing or failed: answer from the verified rules themselves
            found = answer_from_rules(await self.api.jurisdiction(req.st), req.question or "", topics=req.topics, expense=req.expense)
            text, known = found.text, found.known
        return LawReply(request_id=req.request_id, text=text, known=known, st=req.st)

    async def _check(self, req: LawCheckRequest) -> LawReply:
        data = await self.api.check(req.st, req.incident_date, req.forensic_exam, req.police_report)
        if not looks_like_check(data):
            raise ApiError(502, "Tend's server sent a Check I could not read.")
        book = await self._book(req.st)
        origin = self.settings.app_origin
        app = f"{origin}/{req.st.lower()}" if origin else ""
        text = render_check(
            data,
            book,
            st=req.st,
            name=state_name(req.st),
            incident_date=req.incident_date,
            exam=req.forensic_exam,
            report=req.police_report,
            app_url=app,
        )
        return LawReply(request_id=req.request_id, text=text, st=req.st)

    async def _coverage(self, req: LawCoverageRequest) -> LawReply:
        count = len(await self.api.jurisdictions())
        text = (
            f"I have verified rules for {count} jurisdictions: all 50 states and DC. Every rule is a verbatim quote "
            "from an official source, saved with its link. Ask about any of them."
        )
        return LawReply(request_id=req.request_id, text=text, count=count)


__all__ = ["LawDesk", "canonical_question", "render_api_answer"]
