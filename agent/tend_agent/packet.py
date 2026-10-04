"""What the packet says beyond the numbers: the documents still needed and where to file, from verified rules only.

A port of the Tend app's own lists (web/lib/packet/checklist.ts and filing.ts), with the same keyword tables, so the
advocate's link and this chat name the same documents. Each item keeps its rule id and verbatim quote.
"""

from __future__ import annotations

import re
from typing import Any

from .knowledge import RuleBook

CARE = ["medical", "forensic_exam", "dental", "prescription", "counseling"]
DEATH = "for a claim after a death"
_I = re.I | re.A  # ASCII word boundaries, like the JavaScript original

SPECIAL: list[tuple[re.Pattern[str], dict[str, Any]]] = [
    (
        re.compile(r"\b(death|deceased|died|loss of support|survivor'?s benefits?|dependents?|child support|marriage certificate)\b", _I),
        {"kind": "skip", "why": DEATH},
    ),
    (
        re.compile(
            r"\b(guardianship|child victim|for a minor|applies for a minor|power of attorney|incapacitated|under (age )?1[89]|"
            r"parent or (legal )?guardian)\b",
            _I,
        ),
        {"kind": "skip", "why": "for someone filing on another person's behalf"},
    ),
    (re.compile(r"\b(letter of appearance|attorney represents|attorney must file)\b", _I), {"kind": "skip", "why": "only with a lawyer"}),
    (re.compile(r"\bemergency award\b", _I), {"kind": "skip", "why": "only when asking for an emergency award"}),
    (
        re.compile(
            r"\b(SANE|exam bill|forensic exam\w*|sexual assault (medical |forensic )*(exam|examination)|sexual assault billing form)\b", _I
        ),
        {"kind": "exam"},
    ),
]
LATE = re.compile(
    r"\b(fil(e|ed|ing)|appl(y|ying|ication))\b[^.;]*\b(late|delay(ed)?|more than)\b|"
    r"\b(late|delay(ed)?)\b[^.;]*\b(fil(e|ed|ing)|appl(y|ying|ication))\b",
    _I,
)
HINTS: list[tuple[re.Pattern[str], list[str]]] = [
    (re.compile(r"\b(funeral|burial|cemetery)\b", _I), ["funeral"]),
    (re.compile(r"\b(relocat\w*|moving|movers?|lease|lodging|utilit(y|ies))\b", _I), ["relocation", "temporary_housing"]),
    (re.compile(r"\b(security|locks?|alarms?|landlord'?s?)\b", _I), ["security"]),
    (re.compile(r"\b(clean-?up|crime scene)\b", _I), ["crime_scene_cleanup"]),
    (
        re.compile(r"\b(held as evidence|evidence receipt|clothing|bedding|replacement costs?)\b", _I),
        ["clothing_bedding", "property_replacement"],
    ),
    (re.compile(r"\b(mileage|travel|transportation)\b", _I), ["transportation"]),
    (
        re.compile(
            r"\b(wages?|earnings?|pay ?stubs?|employer|employment|work|disability|W-2|schedule c|income tax|sick|vacation|unemployment)\b",
            _I,
        ),
        ["lost_wages"],
    ),
    (re.compile(r"\b(prescriptions?|medications?|pharmacy|glasses|medical equipment)\b", _I), ["prescription", "medical"]),
    (re.compile(r"\b(dental|dentist|dentures?)\b", _I), ["dental"]),
    (re.compile(r"\b(counsel\w*|mental health|therap\w*|psycholog\w*)\b", _I), ["counseling"]),
    (re.compile(r"\b(child ?care|day ?care)\b", _I), ["childcare"]),
    (re.compile(r"\b(medical|hospital|HIPAA|health care|physician|doctor|treatment|clinic)\b", _I), CARE),
]
BY_TYPE: dict[str, dict[str, Any]] = {
    "photo_id": {"kind": "always"},
    "proof_of_residency": {"kind": "always"},
    "police_report": {"kind": "report"},
    "exam_record": {"kind": "exam"},
    "itemized_bill": {"kind": "always"},
    "receipts": {"kind": "always"},
    "wage_verification": {"kind": "expenses", "expenses": ["lost_wages"]},
    "medical_records": {"kind": "expenses", "expenses": CARE},
    "counseling_statement": {"kind": "expenses", "expenses": ["counseling"]},
    "insurance_statement": {"kind": "expenses", "expenses": CARE},
    "other": {"kind": "always"},
}
LABEL = {
    "photo_id": "A copy of your photo ID",
    "proof_of_residency": "Proof of where you live",
    "police_report": "The police report, or its number",
    "exam_record": "A record of your forensic exam",
    "itemized_bill": "Itemized bills",
    "receipts": "Receipts for costs you paid",
    "wage_verification": "Proof of the pay you missed",
    "medical_records": "Medical records",
    "counseling_statement": "A statement from your counselor",
    "insurance_statement": "Insurance statements (explanation of benefits)",
    "other": "A document the program asks for",
}
METHODS = ["online", "email", "mail", "fax", "in_person"]
METHOD_LABEL = {"online": "Online", "email": "Email", "mail": "Mail", "fax": "Fax", "in_person": "In person"}
LEAD = re.compile(r"^([^:]{2,60}):")
CLAUSE = re.compile(r"\b(?:only\s+)?(?:if|when|for)\s+([^.;:()]+)", _I)


def _param(rule: dict[str, Any], name: str) -> Any:
    return (rule.get("params") or {}).get(name)


def hinted(text: str) -> list[str]:
    t = re.sub(r"social security", "", text, flags=_I)  # a Social Security number is not home security
    out: list[str] = []
    for pattern, expenses in HINTS:
        if pattern.search(t):
            out += [e for e in expenses if e not in out]
    return out


def note_scope(note: str) -> list[str]:
    lead = LEAD.match(note)
    clauses = [lead.group(1) if lead else ""] + [m.group(1) for m in CLAUSE.finditer(note)]
    scoped: list[str] = []
    for c in clauses:
        scoped += [e for e in hinted(c) if e not in scoped]
    return scoped or hinted(note)


def doc_scope(rule: dict[str, Any]) -> dict[str, Any]:
    kind = str(_param(rule, "document") or "other")
    if kind in ("police_report", "exam_record", "photo_id", "proof_of_residency"):
        return BY_TYPE[kind]
    note = str(_param(rule, "note") or "").strip()
    about = note or str(rule.get("quote") or "")
    first = re.split(r"[;(]", about)[0]
    lead = LEAD.match(about)
    subject = lead.group(1) if lead else first
    for pattern, scope in SPECIAL:
        if not pattern.search(subject if scope["kind"] == "skip" else first):
            continue
        if scope["kind"] == "skip" and scope["why"] == DEATH and any(e != "funeral" for e in hinted(subject)):
            continue  # "for lost wages or loss of support" still serves lost wages
        return scope
    if LATE.search(about):
        return {"kind": "late"}
    if kind in ("wage_verification", "counseling_statement"):
        return BY_TYPE[kind]
    from_note = note_scope(note)
    from_pinpoint = hinted(str(rule.get("pinpoint") or ""))
    expenses = from_note or from_pinpoint
    if from_note and from_pinpoint:
        both = [e for e in from_note if e in from_pinpoint]
        if both:
            expenses = both
    if expenses:
        return {"kind": "expenses", "expenses": expenses}
    return BY_TYPE.get(kind, BY_TYPE["other"])


def claimed_expenses(output: dict[str, Any]) -> set[str]:
    return {ln.get("expense") for ln in output.get("lines") or [] if ln.get("status") in ("eligible", "needs_confirmation")}


def scope_applies(scope: dict[str, Any], engine_input: dict[str, Any], output: dict[str, Any]) -> bool:
    kind = scope["kind"]
    if kind == "always":
        return True
    if kind == "expenses":
        return bool(claimed_expenses(output) & set(scope["expenses"]))
    checks = output.get("checks") or {}
    ctx = engine_input.get("context") or {}
    if kind == "report":
        return ctx.get("police_report") == "yes" or (checks.get("reporting") or {}).get("status") in ("required", "unknown")
    if kind == "exam":
        return bool(ctx.get("forensic_exam")) or any(ln.get("status") == "held" for ln in output.get("lines") or [])
    if kind == "late":
        return (checks.get("deadline") or {}).get("status") == "late"
    return False


def _itemized_on_hand(scope: dict[str, Any], engine_input: dict[str, Any], output: dict[str, Any]) -> bool:
    """Itemized bills are in hand when every cost the document covers came from a bill read line by line."""
    items = {i["item_id"]: i for i in engine_input.get("items") or []}
    covered = [
        ln
        for ln in output.get("lines") or []
        if ln.get("status") in ("eligible", "needs_confirmation")
        and (scope["kind"] != "expenses" or ln.get("expense") in scope["expenses"])
    ]
    return bool(covered) and all(
        bool(items.get(ln["item_id"], {}).get("is_bill")) and not str(ln["item_id"]).startswith("nessie:") for ln in covered
    )


def _sentence(text: str) -> str:
    t = re.sub(r"\s+", " ", text.strip())
    return t[:1].upper() + t[1:]


def still_needed(book: RuleBook, engine_input: dict[str, Any], output: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for rule in book.of("required_document"):
        scope = doc_scope(rule)
        if not scope_applies(scope, engine_input, output):
            continue
        kind = str(_param(rule, "document") or "other")
        note = _param(rule, "note")
        out.append(
            {
                "document": _sentence(note if isinstance(note, str) and note.strip() else LABEL.get(kind, LABEL["other"])),
                "rule_id": rule.get("id"),
                "pinpoint": rule.get("pinpoint"),
                "quote": rule.get("quote"),
                "fragment_url": rule.get("fragment_url"),
                "have_it": kind == "itemized_bill" and _itemized_on_hand(scope, engine_input, output),
            }
        )
    return out


def filing_routes(book: RuleBook) -> list[dict[str, Any]]:
    seen: set[str] = set()
    routes = []
    for order, rule in enumerate(book.of("submission")):
        method, target = _param(rule, "method"), _param(rule, "target")
        if method not in METHODS or not isinstance(target, str) or not target.strip():
            continue
        key = f"{method}|{target.strip().lower()}"
        if key in seen:
            continue
        seen.add(key)
        routes.append({"method": method, "target": target.strip(), "rule": rule, "order": order})
    routes.sort(key=lambda r: (METHODS.index(r["method"]), r["order"]))
    return routes
