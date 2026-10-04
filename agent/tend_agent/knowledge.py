"""Cited answers built only from a state's verified rules (GET /api/jurisdictions/{st}).

Used when the API's /api/agent/answer is missing or fails. Every sentence points at a rule with a verbatim quote,
and when no rule covers the question the answer says it is not in the rules instead of guessing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .fmt import UNIT_WORDS, cite_block, cite_link, clean, expense_label, money_short, plural, program_line
from .parse import find_expense, find_topics

CLAIM_PERS = {"claim", "residence", "crime_scene", None, ""}
TOPIC_CATEGORIES = {
    "deadline": ("filing_deadline",),
    "reporting": ("reporting_requirement",),
    "exam": ("exam_no_bill", "exam_payment"),
    "time": ("processing_time",),
    "privacy": ("address_confidentiality", "record_confidentiality"),
    "emergency": ("emergency_award",),
    "minimum": ("minimum_loss",),
    "insurance": ("collateral_source",),
    "residency": ("residency",),
    "documents": ("required_document",),
    "apply": ("submission",),
    "max": ("total_cap", "expense_cap"),
    "covered": ("covered_expense",),
    "excluded": ("excluded_expense",),
    "eligibility": ("eligible_crime", "residency"),
}
TOPIC_INTROS = {
    "deadline": "Here is the deadline to apply in {name}.",
    "reporting": "Here is what {name} says about a police report.",
    "exam": "Here is what {name} says about forensic exam bills.",
    "time": "Here is how long {name} says a decision takes.",
    "privacy": "{name} has these privacy protections.",
    "emergency": "Here is what {name} says about an emergency award.",
    "minimum": "Here is what {name} says about a minimum loss.",
    "insurance": "The {name} program pays after insurance and other sources.",
    "residency": "Here is who can apply in {name}.",
    "documents": "The {name} program asks for these documents.",
    "apply": "Here is how to apply in {name}.",
    "max": "Here are the limits in {name}.",
    "covered": "The {name} program lists these costs as covered.",
    "excluded": "The {name} program lists these as not covered.",
    "eligibility": "Here is what {name} says about who can apply.",
}
TOPIC_ABOUT = {
    "deadline": "the deadline to apply",
    "reporting": "police reports",
    "exam": "forensic exam bills",
    "time": "how long a decision takes",
    "privacy": "privacy protections",
    "emergency": "emergency awards",
    "minimum": "a minimum loss",
    "insurance": "insurance",
    "residency": "who can apply",
    "documents": "the documents to send",
    "apply": "how to apply",
    "max": "limits",
    "covered": "covered costs",
    "excluded": "costs that are not covered",
    "eligibility": "who can apply",
    "contact": "how to contact the program",
}
MAX_QUOTED = 3


@dataclass
class Answer:
    st: str
    known: bool
    text: str
    citations: list[dict[str, Any]] = field(default_factory=list)


def rule_expense(rule: dict[str, Any]) -> str | None:
    return rule.get("expense") or (rule.get("params") or {}).get("expense")


def cite(rule: dict[str, Any], sources: dict[str, dict[str, Any]]) -> dict[str, Any]:
    source = sources.get(rule.get("source_id", ""), {})
    return {
        "rule_id": rule.get("id"),
        "category": rule.get("category"),
        "pinpoint": rule.get("pinpoint"),
        "summary": rule.get("summary"),
        "quote": rule.get("quote"),
        "fragment_url": rule.get("fragment_url"),
        "source_url": source.get("url"),
        "source_title": source.get("title"),
    }


def applies_to(rule: dict[str, Any]) -> str:
    """Who or what a rule is limited to, as written (for example, family members, or crimes after a date)."""
    who = (rule.get("params") or {}).get("applies_to")
    if not who:
        return ""
    return clean(", ".join(map(str, who)) if isinstance(who, list) else str(who)).replace("_", " ")


def cap_phrase(rule: dict[str, Any]) -> str | None:
    params = rule.get("params") or {}
    amount = params.get("amount_cents")
    if not isinstance(amount, int):
        return None
    per = params.get("per")
    if per in CLAIM_PERS:
        text = f"up to {money_short(amount)}"
    else:
        unit = UNIT_WORDS.get(per)
        text = f"up to {money_short(amount)} {unit}" if unit else f"up to {money_short(amount)} per {per}"
    if isinstance(params.get("count_limit"), int):
        text += f", for up to {plural(params['count_limit'], str(per))}"
    who = applies_to(rule)
    if who:
        text += f" (for {who})"
    return text


def best_cap(rules: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The most generous cap that applies to the survivor, to show in a short list. Rules limited to someone
    else (family members, a date range) count only when nothing else exists."""
    caps = [r for r in rules if isinstance((r.get("params") or {}).get("amount_cents"), int)]
    plain = [r for r in caps if not applies_to(r)] or caps
    return max(plain, key=lambda r: r["params"]["amount_cents"]) if plain else None


def short_cap(caps: list[dict[str, Any]]) -> str:
    """For a one-line list: the most generous limit, and a note when the law sets more than one."""
    best = best_cap(caps)
    if best is None:
        return ""
    phrase = cap_phrase(best) or ""
    amounts = {(r.get("params") or {}).get("amount_cents") for r in caps if not applies_to(r)}
    return f"{phrase}, limits vary" if len(amounts) > 1 else phrase


def total_caps(rules: list[dict[str, Any]]) -> list[tuple[dict[str, Any], str]]:
    """(rule, "who it is for") for the total cap to show. Like the engine, the smallest cap that applies to
    everyone wins (a larger one is usually an exception, like catastrophic injury). When every cap is limited
    to some case (a crime date, a kind of injury), each one is listed with its case."""
    caps = [r for r in rules if isinstance((r.get("params") or {}).get("amount_cents"), int)]
    plain = [r for r in caps if not applies_to(r)]
    if plain:
        return [(min(plain, key=lambda r: r["params"]["amount_cents"]), "")]
    return [(r, applies_to(r)) for r in caps]


class RuleBook:
    def __init__(self, doc: dict[str, Any]):
        self.doc = doc
        self.st = str(doc.get("jurisdiction", ""))
        self.name = str(doc.get("name") or self.st)
        self.rules: list[dict[str, Any]] = list(doc.get("rules") or [])
        self.sources = {s.get("id"): s for s in doc.get("sources") or []}
        self.by_id = {r.get("id"): r for r in self.rules}

    def of(self, *categories: str, expense: str | None = None) -> list[dict[str, Any]]:
        out = [r for r in self.rules if r.get("category") in categories]
        if expense is not None:
            out = [r for r in out if rule_expense(r) == expense]
        return out

    def cites(self, rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [cite(r, self.sources) for r in rules]

    def summary(self, rule_id: str) -> str:
        return clean((self.by_id.get(rule_id) or {}).get("summary"))

    def covered_list(self) -> list[tuple[str, str, dict[str, Any], str]]:
        """(expense, label, first covering rule, short limit text) for each covered expense, in rule order.
        Rules limited to someone other than the survivor are left out of this short list."""
        out = []
        for expense in dict.fromkeys(rule_expense(r) for r in self.of("covered_expense") if not applies_to(r)):
            if not expense:
                continue
            first = next(r for r in self.of("covered_expense", expense=expense) if not applies_to(r))
            label = expense_label(expense)
            item = clean((first.get("params") or {}).get("item"))
            if expense == "other" and item:
                label = item[0].upper() + item[1:]
            out.append((expense, label, first, short_cap(self.of("expense_cap", expense=expense))))
        return out


def _blocks(cites: list[dict[str, Any]]) -> str:
    quoted = [cite_block(c) for c in cites[:MAX_QUOTED]]
    more = [cite_link(c) for c in cites[MAX_QUOTED:]]
    text = "\n\n".join(quoted)
    if more:
        text += "\n\nMore: " + ", ".join(more)
    return text


NOT_IN_RULES = "That's not in the rules I have."


def _dated(rule: dict[str, Any]) -> bool:
    params = rule.get("params") or {}
    return any(isinstance(params.get(k), int) for k in ("years", "months", "days"))


def report_note(book: RuleBook | None) -> str:
    """The sentence after a deadline the engine flags as counting from the police report. In some states that is the
    main rule (Washington, North Dakota). In others it is one narrow case, usually a survivor who was a child, while
    the main deadline counts from the crime (Michigan, Kansas, Minnesota, Mississippi). Then the note names that case
    and cites it, instead of telling an adult they may have longer."""
    lead = "This is measured from the date it happened."
    rules = book.of("filing_deadline") if book is not None else []
    from_report = [r for r in rules if (r.get("params") or {}).get("from") == "report"]
    main_from_crime = any((r.get("params") or {}).get("from") == "crime" and _dated(r) for r in rules)
    if book is None or not from_report:
        return f"{lead} In some cases the law counts from the police report instead, so ask the program."
    if not main_from_crime:
        return f"{lead} The law counts from the police report, so you may have longer."
    rule = from_report[0]
    return f"{lead} In one case {book.name}'s law counts from the police report instead ({cite_link(cite(rule, book.sources))}): {clean(rule.get('summary'))}"


def _unknown(book: RuleBook, about: str) -> Answer:
    contact = program_line(book.doc.get("program"), book.name)
    text = f"{NOT_IN_RULES} I found no verified {book.name} rule about {about}, so I won't guess."
    if contact:
        text += f" The program can answer it: {contact}."
    return Answer(book.st, False, text)


def expense_answer(book: RuleBook, expense: str) -> Answer:
    label = expense_label(expense).lower()
    covered = book.of("covered_expense", expense=expense)
    caps = book.of("expense_cap", expense=expense)
    excluded = book.of("excluded_expense", expense=expense)
    if covered or caps:
        parts = [f"The {book.name} program lists **{label}** as a covered cost."]
        phrases = [p for p in (cap_phrase(r) for r in caps) if p]
        if phrases:
            parts.append("Limits in the law: " + "; ".join(dict.fromkeys(phrases)) + ".")
        rules = covered + caps
        text = " ".join(parts) + "\n\n" + _blocks(book.cites(rules))
        if excluded:
            text += "\n\nSome of these costs are not covered:\n\n" + _blocks(book.cites(excluded))
        return Answer(book.st, True, text, book.cites(rules + excluded))
    if excluded:
        text = f"The {book.name} program lists this as **not covered**.\n\n" + _blocks(book.cites(excluded))
        return Answer(book.st, True, text, book.cites(excluded))
    return _unknown(book, f"whether {label} is covered")


def topic_answer(book: RuleBook, topic: str) -> Answer | None:
    if topic == "contact":
        contact = program_line(book.doc.get("program"), book.name)
        return Answer(book.st, True, f"Contact: {contact}.") if contact else None
    rules = book.of(*TOPIC_CATEGORIES.get(topic, ()))
    if not rules:
        return None
    intro = TOPIC_INTROS[topic].format(name=book.name)
    if topic == "covered":
        lines = []
        for _expense, label, first, limit in book.covered_list():
            lines.append(f"- {label}{', ' + limit if limit else ''} ({cite_link(cite(first, book.sources))})")
        return Answer(book.st, True, intro + "\n\n" + "\n".join(lines), book.cites(rules))
    if topic == "max":
        totals = book.of("total_cap")
        text = intro
        if totals:
            shown = total_caps(totals)
            if len(shown) == 1 and not shown[0][1]:
                text += f" The most the program pays in total is **{money_short(shown[0][0]['params']['amount_cents'])}**."
            elif shown:
                text += (
                    " The most the program pays in total depends on the case: "
                    + "; ".join(f"**{money_short(r['params']['amount_cents'])}** for {who}" for r, who in shown)
                    + "."
                )
            text += "\n\n" + _blocks(book.cites([r for r, _ in shown] + [r for r in totals if r not in [x for x, _ in shown]]))
        caps = [r for r in book.of("expense_cap") if cap_phrase(r)]
        if caps:
            text += "\n\nSome costs have their own limits:\n" + "\n".join(
                f"- {expense_label(rule_expense(r))}: {cap_phrase(r)} ({cite_link(cite(r, book.sources))})" for r in caps
            )
        return Answer(book.st, True, text, book.cites(totals + caps))
    if topic == "documents":
        general = [r for r in rules if not rule_expense(r)] or rules
        lines = [f"- {clean(r.get('summary'))} ({cite_link(cite(r, book.sources))})" for r in general[:8]]
        extra = len(rules) - len(lines)
        tail = f"\n\nThere are {plural(extra, 'more item')} for specific costs." if extra > 0 else ""
        return Answer(book.st, True, intro + "\n\n" + "\n".join(lines) + tail, book.cites(general[:8]))
    if topic == "apply":
        lines = []
        for r in rules:
            params = r.get("params") or {}
            how = str(params.get("method") or "").replace("_", " ")
            target = clean(params.get("target"))
            lines.append(f"- {how.capitalize()}: {target} ({cite_link(cite(r, book.sources))})" if how else f"- {clean(r.get('summary'))}")
        contact = program_line(book.doc.get("program"), book.name)
        tail = f"\n\nQuestions: {contact}." if contact else ""
        return Answer(book.st, True, intro + "\n\n" + "\n".join(lines) + tail, book.cites(rules))
    return Answer(book.st, True, intro + "\n\n" + _blocks(book.cites(rules)), book.cites(rules))


def answer_from_rules(doc: dict[str, Any], question: str = "", *, topics: list[str] | None = None, expense: str | None = None) -> Answer:
    book = RuleBook(doc)
    topics = topics if topics is not None else find_topics(question)
    expense = expense if expense is not None else find_expense(question)
    if "exam" in topics or expense == "forensic_exam":
        found = topic_answer(book, "exam")
        return found or _unknown(book, "forensic exam bills")
    if expense and (not topics or topics[0] in ("covered", "max", "excluded", "eligibility")):
        return expense_answer(book, expense)
    if topics:
        # Answer the main question or say "I don't know". Never swap in an answer to a different question.
        return topic_answer(book, topics[0]) or _unknown(book, TOPIC_ABOUT.get(topics[0], topics[0].replace("_", " ")))
    return Answer(
        book.st,
        False,
        f"{NOT_IN_RULES} I won't guess about {book.name}. I can answer questions about the deadline, police reports, "
        "forensic exam bills, what costs are covered, limits, documents, how to apply, and privacy.",
    )
