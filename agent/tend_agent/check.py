"""Rendering a Check: deadline, police report, exam bills, covered costs, limits, and the program. Every line cited."""

from __future__ import annotations

from typing import Any

from .fmt import cite_block, cite_link, clean, expense_label, long_date, money_short, program_line
from .knowledge import RuleBook, cite, total_caps

ALTERNATIVES = {
    "forensic_exam": "a forensic exam",
    "protective_order": "a protective order",
    "advocate": "talking with an advocate",
    "medical_provider": "telling a medical provider",
    "other": "other options the program accepts",
}


def _first(cites: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    return cites[0] if cites else None


def _with_summary(c: dict[str, Any] | None, book: RuleBook | None) -> dict[str, Any] | None:
    if c is None:
        return None
    if book is not None and not c.get("summary") and c.get("rule_id"):
        c = {**c, "summary": book.summary(c["rule_id"])}
    return c


def _alternatives(book: RuleBook | None) -> list[str]:
    if book is None:
        return []
    found: list[str] = []
    for r in book.of("reporting_requirement"):
        for alt in (r.get("params") or {}).get("alternatives") or []:
            label = ALTERNATIVES.get(alt, str(alt).replace("_", " "))
            if label not in found:
                found.append(label)
    return found


def _rule_with_alt(cites: list[dict[str, Any]], book: RuleBook | None, alt: str) -> dict[str, Any] | None:
    if book is None:
        return _first(cites)
    for c in cites:
        rule = book.by_id.get(c.get("rule_id"))
        if rule and alt in ((rule.get("params") or {}).get("alternatives") or []):
            return c
    return _first(cites)


def _requiring_rule(cites: list[dict[str, Any]], book: RuleBook | None) -> dict[str, Any] | None:
    """The rule that asks for a report (required, with no alternatives), else the first one."""
    if book is not None:
        for c in cites:
            params = (book.by_id.get(c.get("rule_id")) or {}).get("params") or {}
            if params.get("required") and not params.get("alternatives"):
                return c
    return _first(cites)


def deadline_section(check: dict[str, Any], book: RuleBook | None, *, have_date: bool = False, name: str = "") -> str:
    cites = check.get("citations") or []
    status = check.get("status")
    date = check.get("deadline_date")
    main = _with_summary(_first(cites), book)
    where = f" for {name}" if name else ""
    if status == "ok" and date:
        head = f"**Deadline:** apply by **{long_date(date)}**."
    elif status == "late" and date:
        head = (
            f"**Deadline:** the usual deadline was **{long_date(date)}**. Some programs allow more time for a good "
            "reason, so it is still worth calling."
        )
    elif not cites:
        head = f"**Deadline:** I could not find a verified filing deadline{where}. Ask the program how long you have."
    elif have_date:
        # The date was given but the rules do not reduce to one day (for example, a deadline in months).
        head = "**Deadline:** I could not work out the exact day from the verified rules. Read the rule below, or ask the program."
    else:
        head = "**Deadline:** counted from the date it happened. Tell me the date (only the date) for the exact day."
    flags = check.get("flags") or []
    if any("deadline_from_report" in str(f) for f in flags):
        head += " This is measured from the date it happened. The law counts from your report, so you may have longer."
    return head + ("\n" + cite_block(main) if main else "")


def reporting_section(
    check: dict[str, Any], if_exam: dict[str, Any] | None, *, exam: bool | None, report: str, book: RuleBook | None, name: str
) -> str:
    cites = check.get("citations") or []
    status = check.get("status")
    alts = _alternatives(book)
    if status == "satisfied" and report == "yes":
        head, c = "**Police report:** you reported it, so this part is met.", _first(cites)
    elif status == "satisfied":
        head, c = "**Police report:** your forensic exam counts in place of a police report.", _rule_with_alt(cites, book, "forensic_exam")
    elif status == "not_required":
        head, c = "**Police report:** not required.", _first(cites)
    elif exam is None and if_exam and if_exam.get("status") == "satisfied":
        # Not sure about the exam: the API answered both ways, so say both.
        head = (
            "**Police report:** if you had a forensic exam, it counts in place of a police report. "
            f"If not, {name} usually asks for a report."
        )
        c = _rule_with_alt(cites or if_exam.get("citations") or [], book, "forensic_exam")
    elif status == "required":
        head = f"**Police report:** {name} asks for one."
        if alts:
            head += f" These can count instead: {', '.join(alts)}."
        c = _requiring_rule(cites, book)
    elif cites and alts:
        head = f"**Police report:** it may be needed. These can count instead: {', '.join(alts)}. Read the rule, or ask the program."
        c = _first(cites)
    elif cites:
        head, c = "**Police report:** the rules here have conditions. Read the rule, or ask the program.", _first(cites)
    else:
        return "**Police report:** I could not find a verified rule about this. Ask the program."
    c = _with_summary(c, book)
    return head + ("\n" + cite_block(c) if c else "")


def exam_section(exam_billing: dict[str, Any] | None, book: RuleBook | None) -> str:
    protection = (exam_billing or {}).get("protection") or []
    if not protection:
        return ""
    c = _with_summary(protection[0], book)
    return "**Exam bills:** you should not get a bill for a forensic exam.\n" + cite_block(c)


def covered_section(data: dict[str, Any], book: RuleBook | None) -> str:
    items: list[str] = []
    if book is not None:
        for _expense, label, _first, limit in book.covered_list():
            items.append(f"{label} ({limit})" if limit else label)
    else:
        items = [expense_label(c.get("expense")) for c in data.get("covered") or []]
    if not items:
        return ""
    return "**Covered costs:** " + ", ".join(items) + "."


def total_section(book: RuleBook | None) -> str:
    if book is None:
        return ""
    shown = total_caps(book.of("total_cap"))
    if not shown:
        return ""
    if len(shown) == 1 and not shown[0][1]:
        rule = shown[0][0]
        amount = money_short(rule["params"]["amount_cents"])
        return f"**Most you can ask for:** {amount} in total ({cite_link(cite(rule, book.sources))}). The program decides."
    cases = "; ".join(
        f"{money_short(r['params']['amount_cents'])} for {who} ({cite_link(cite(r, book.sources))})"
        if who
        else f"{money_short(r['params']['amount_cents'])} ({cite_link(cite(r, book.sources))})"
        for r, who in shown
    )
    return f"**Most you can ask for:** it depends on the case: {cases}. The program decides."


def sentences_section(data: dict[str, Any]) -> str:
    out = []
    for s in data.get("sentences") or []:
        if not isinstance(s, dict) or not s.get("text"):
            continue
        links = ", ".join(cite_link(c) for c in s.get("citations") or [] if isinstance(c, dict))
        out.append(f"- {clean(s['text'])}" + (f" ({links})" if links else ""))
    return "\n".join(out)


def render_check(
    data: dict[str, Any],
    book: RuleBook | None,
    *,
    st: str,
    name: str,
    incident_date: str | None,
    exam: bool | None,
    report: str,
    app_url: str = "",
) -> str:
    deadline = data.get("deadline") or {}
    late = deadline.get("status") == "late"
    opener = (
        f"**{name}: the usual deadline has passed, but ask the program about more time.**"
        if late
        else f"**You can likely apply in {name}.** The program decides."
    )
    told = []
    if incident_date:
        told.append(f"date {long_date(incident_date)}")
    told.append({True: "had an exam", False: "no exam"}.get(exam, "exam not sure"))
    told.append({"yes": "reported", "no": "not reported yet"}.get(report, "report not sure"))
    parts = [opener, f"_Based on: {name}, {', '.join(told)}. These answers are not saved._"]
    sentences = sentences_section(data)
    if sentences:
        parts.append(sentences)
    if deadline:
        parts.append(deadline_section(deadline, book, have_date=bool(incident_date), name=name))
    if data.get("reporting"):
        parts.append(reporting_section(data["reporting"], data.get("reporting_if_exam"), exam=exam, report=report, book=book, name=name))
    total = total_section(book)
    for section in (exam_section(data.get("exam_billing"), book), covered_section(data, book), total):
        if section:
            parts.append(section)
    program = program_line(data.get("program") or (book.doc.get("program") if book else None), name)
    if program:
        parts.append(f"**Program:** {program}.")
    # Every amount someone can ask for carries "The program decides." Said once, next to the amount when there is one.
    tail = "Rules can have exceptions." if total else "Rules can have exceptions. The program decides."
    if app_url:
        tail += f" To find costs the program can repay, open Tend on your own device: {app_url}"
    parts.append(tail)
    return "\n\n".join(p for p in parts if p)
