"""The fictional demo claim, in words: what the scan found, what the law counts, the held exam line, the payment.

The Bank+Packet agent builds these from the API's answers. Only ids, amounts, and expense types travel back to the
Navigator between messages; merchant names and bill text stay with the API.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from .fmt import cite_block, cite_link, expense_label, long_date, money, plural
from .knowledge import RuleBook, cap_phrase, cite, deadline_notes

DEMO_PERSONAS = {"MI": "rowan-mi", "NY": "rowan-ny", "CA": "rowan-ca", "TX": "rowan-tx"}
FICTIONAL = "Fictional person and data on Capital One's Nessie mock bank. No real person, account, or hospital."
FICTIONAL_SHORT = "(Fictional demo data on a mock bank.)"
ENGINE_FIELDS = ("item_id", "date", "amount_cents", "expense", "confirmed", "insurance_paid_cents", "is_bill", "units", "unit", "tags")


def persona_for(st: str | None, default: str) -> tuple[str, str]:
    """(persona_id, state). Rowan exists in MI, NY, CA, and TX; any other state reuses the Michigan history
    under that state's law."""
    if st in DEMO_PERSONAS:
        return DEMO_PERSONAS[st], st
    if st:
        return default, st
    return default, default.rsplit("-", 1)[-1].upper()


def groups(scan: dict[str, Any]) -> list[dict[str, Any]]:
    by: dict[str, dict[str, Any]] = defaultdict(lambda: {"count": 0, "cents": 0})
    for item in scan.get("items") or []:
        if item.get("is_bill"):
            continue
        g = by[item.get("expense") or "unknown"]
        g["count"] += 1
        g["cents"] += int(item.get("amount_cents") or 0)
    return sorted(({"expense": e, **g} for e, g in by.items()), key=lambda g: -g["cents"])


def bill_summary(audit: dict[str, Any] | None) -> dict[str, Any] | None:
    if not audit:
        return None
    return {"lines": len(audit.get("lines") or []), "total_cents": int(audit.get("total_cents") or 0)}


def demo_ref(scan: dict[str, Any], audit: dict[str, Any] | None, persona_id: str) -> dict[str, Any]:
    """What the Navigator keeps between messages: ids and amounts only (messages.DemoRef)."""
    holds = {h["item_id"] for h in (audit or {}).get("holds") or []}
    pay_lines = [ln for ln in (audit or {}).get("lines") or [] if ln.get("item_id") not in holds]
    account = scan.get("account") or {}
    return {
        "persona_id": persona_id,
        "st": scan.get("st"),
        "scan_id": scan.get("scan_id"),
        "who": scan.get("display_name") or "the demo person",
        "account_id": account.get("id") or "",
        "account_label": f"{account.get('nickname') or 'Checking'} ending {account.get('mask') or '----'}",
        "incident_date": scan.get("incident_date"),
        "bill_id": (audit or {}).get("bill_id"),
        "provider": (audit or {}).get("provider"),
        "pay_item_ids": [ln["item_id"] for ln in pay_lines],
        "bill_lines": len((audit or {}).get("lines") or []),
        "bill_total_cents": int((audit or {}).get("total_cents") or 0),
        "payable_cents": int((audit or {}).get("payable_cents") or 0),
        "held_cents": int((audit or {}).get("held_cents") or 0),
        "police_report": ((scan.get("engine_input") or {}).get("context") or {}).get("police_report"),
    }


def confirmed_input(scan: dict[str, Any], audit: dict[str, Any] | None, *, keep_text: bool = False) -> dict[str, Any]:
    """The engine input after the person said yes to every cost. Bill lines come from the audited bill.

    Without keep_text, items carry only what the engine reads (no merchant or bill text), which is what goes to
    /api/claim. With keep_text, the descriptions stay, for the packet that is sealed before it leaves."""
    base = scan["engine_input"]
    items = [dict(i, confirmed=True) for i in base["items"] if not i.get("is_bill")]
    if audit and audit.get("engine_items"):
        items += [dict(i, confirmed=True) for i in audit["engine_items"]]
    else:
        items += [dict(i, confirmed=True) for i in base["items"] if i.get("is_bill")]
    keep = (*ENGINE_FIELDS, "description") if keep_text else ENGINE_FIELDS
    cleaned = []
    for i in items:
        item = {k: i[k] for k in keep if k in i}
        if keep_text and not isinstance(item.get("description"), str):
            item.pop("description", None)
        cleaned.append(item)
    return {**base, "items": cleaned}


def held_lines(audit: dict[str, Any] | None) -> list[dict[str, Any]]:
    """The bill lines the law engine held, with what the billing letter quotes: description, date, amount, rules."""
    if not audit:
        return []
    dates = {ln.get("item_id"): ln.get("date") for ln in audit.get("lines") or []}
    return [
        {
            "item_id": h.get("item_id"),
            "description": h.get("description") or "",
            "date": dates.get(h.get("item_id")),
            "amount_cents": int(h.get("amount_cents") or 0),
            "rule_ids": list(h.get("rule_ids") or []),
        }
        for h in audit.get("holds") or []
    ]


def render_scan(scan: dict[str, Any], audit: dict[str, Any] | None, name: str) -> str:
    who = scan.get("display_name") or "the demo person"
    head = (
        f"**Demo: {who}, {name}.** {FICTIONAL}\n"
        f"Tend read {plural(int(scan.get('read_count') or 0), 'bank record')} and found these possible costs since "
        f"{long_date(scan.get('incident_date'))}:"
    )
    rows = [f"- {expense_label(g['expense'])}: {plural(g['count'], 'charge')}, {money(g['cents'])}" for g in groups(scan)]
    bill = bill_summary(audit)
    if bill:
        rows.append(
            f"- Hospital bill (itemized): {plural(bill['lines'], 'line')}, {money(bill['total_cents'])}. The lines add up to the total."
        )
    return head + "\n\n" + "\n".join(rows)


def _cap_note(line: dict[str, Any], book: RuleBook) -> str:
    rule = book.by_id.get(line.get("cap_rule_id"))
    if not rule:
        return ""
    phrase = cap_phrase(rule)
    return f"limit {phrase.removeprefix('up to ')}" if phrase else "limited by law"


def render_claim(claim: dict[str, Any], book: RuleBook, demo: dict[str, Any], who: str) -> str:
    totals = claim.get("totals") or {}
    lines_by_expense: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for ln in claim.get("lines") or []:
        lines_by_expense[ln.get("expense") or "unknown"].append(ln)

    out = [f"**Amount {who} can ask for: {money(int(totals.get('allowed_cents') or 0))}. The program decides.**", f"_{FICTIONAL}_"]

    counted = []
    for expense, lines in sorted(lines_by_expense.items(), key=lambda kv: -sum(int(x.get("allowed_cents") or 0) for x in kv[1])):
        eligible = [x for x in lines if x.get("status") == "eligible"]
        if not eligible:
            continue
        allowed = sum(int(x.get("allowed_cents") or 0) for x in eligible)
        asked = sum(int(x.get("requested_cents") or 0) for x in eligible)
        notes = sorted({n for n in (_cap_note(x, book) for x in eligible) if n})
        rule_ids = [r for r in eligible[0].get("rule_ids") or [] if r in book.by_id]
        main = next((r for r in rule_ids if book.by_id[r].get("category") in ("covered_expense", "expense_cap")), None)
        link = f" ({cite_link(cite(book.by_id[main], book.sources))})" if main else ""
        amount = money(allowed) if allowed == asked else f"{money(allowed)} of {money(asked)}"
        extra = f"; {', '.join(notes)}" if notes else ""
        counted.append(f"- {expense_label(expense)}: {amount} ({plural(len(eligible), 'charge')}{extra}){link}")
    if counted:
        out.append("What counts:\n" + "\n".join(counted))

    left_out = []
    for expense, lines in lines_by_expense.items():
        for status in ("excluded", "unknown_rule", "out_of_window", "needs_confirmation"):
            these = [x for x in lines if x.get("status") == status]
            if not these:
                continue
            cents = sum(int(x.get("requested_cents") or 0) for x in these)
            label = f"{expense_label(expense)}, {money(cents)}"
            if status == "excluded":
                rid = next((r for r in these[0].get("rule_ids") or [] if r in book.by_id), None)
                why = f"not covered ({cite_link(cite(book.by_id[rid], book.sources))})" if rid else "not covered"
            elif status == "unknown_rule":
                why = "no verified rule covers this yet, so ask the program"
            elif status == "out_of_window":
                why = "outside the dates that count"
            else:
                why = "waiting for a yes"
            left_out.append(f"- {label}: {why}")
    if left_out:
        out.append("Not included:\n" + "\n".join(left_out))

    held = [x for x in claim.get("lines") or [] if x.get("status") == "held"]
    if held:
        cents = sum(int(x.get("requested_cents") or 0) for x in held)
        rid = next((r for r in held[0].get("rule_ids") or [] if (book.by_id.get(r) or {}).get("category") == "exam_no_bill"), None)
        block = cite_block(cite(book.by_id[rid], book.sources)) if rid else ""
        bill = f" of the {money(demo['bill_total_cents'])} hospital bill" if demo.get("bill_total_cents") else " on the hospital bill"
        out.append(
            f"**Don't pay this line:** the forensic exam, {money(cents)}{bill}. The law says the survivor should not be billed for it.\n{block}".strip()
        )

    checks = claim.get("checks") or {}
    facts = []
    deadline = checks.get("deadline") or {}
    rid = next((r for r in deadline.get("rule_ids") or [] if r in book.by_id), None)
    link = f" ({cite_link(cite(book.by_id[rid], book.sources))})" if rid else ""
    facts.append(deadline_sentence(deadline.get("status"), deadline.get("deadline_date"), link, deadline.get("flags"), book))
    reporting = (checks.get("reporting") or {}).get("status")
    if reporting == "satisfied":
        reported = demo.get("police_report") == "yes"
        facts.append("The police report meets that rule." if reported else "The forensic exam counts in place of a police report.")
    elif reporting == "required":
        facts.append("This state asks for a police report.")
    facts = [f for f in facts if f]
    if facts:
        out.append(" ".join(facts))
    return "\n\n".join(out)


def deadline_sentence(status: Any, date: Any, link: str = "", flags: Any = None, book: RuleBook | None = None) -> str:
    """The filing deadline in one sentence. A late date is never shown as "apply by"."""
    if not date or status not in ("ok", "late"):
        return ""
    if status == "late":
        text = f"The usual deadline was {long_date(date)}{link}. Some programs allow more time for a good reason, so it is worth calling."
    else:
        text = f"Apply by {long_date(date)}{link}."
    return text + deadline_notes(flags, book)


def payment_body(demo: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "pay_bill",
        "bill_id": demo["bill_id"],
        "item_ids": demo["pay_item_ids"],
        "amount_cents": demo["payable_cents"],
        "from_account_id": demo["account_id"],
        "payee": demo["provider"],
    }


def payment_view(proposal: dict[str, Any], demo: dict[str, Any]) -> dict[str, Any]:
    dry = bool(proposal.get("dry_run"))
    return {
        "action_id": proposal["action_id"],
        "amount_cents": int(proposal["amount_cents"]),
        "code": str(proposal.get("confirm_code") or ""),
        "payee_label": f"{proposal.get('payee') or demo.get('provider')} (fictional)",
        "from_label": f"{demo['account_label']} (Nessie mock bank)",
        "lines_label": f"{plural(len(proposal.get('item_ids') or demo['pay_item_ids']), 'line')} of the itemized bill",
        "held_cents": demo.get("held_cents") or 0,
        "bank_label": "Dry run: recorded and read back, not sent" if dry else "Nessie mock bank (a real API write)",
    }


def render_paid(result: dict[str, Any], demo: dict[str, Any], book: RuleBook | None) -> str:
    out = [f"**Done.** {result.get('message') or 'The payment went through.'}"]
    facts = []
    if result.get("nessie_id"):
        check = "matches what you approved" if result.get("read_back_matches") else "does NOT match what you approved, so check the account"
        facts.append(f"- Bank record: {result['nessie_id']}. Tend read it back and it {check}.")
    if result.get("audit_id"):
        facts.append(f"- Audit log: {result['audit_id']}, in a hash chain with no names in it.")
    if facts:
        out.append("\n".join(facts))
    if demo.get("held_cents"):
        rule = next(iter(book.of("exam_no_bill")), None) if book else None
        link = f" ({cite_link(cite(rule, book.sources))})" if rule and book else ""
        out.append(
            f"The forensic exam line, {money(demo['held_cents'])}, stays unpaid. The law says the hospital should not bill it{link}."
        )
    return "\n\n".join(out)
