"""The fictional demo claim: what the scan found, what the law counts, the held exam line, and the bill payment.

Only ids, amounts, and expense types are kept between messages. Merchant names and bill text stay on the API.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from .fmt import cite_block, cite_link, deadline_notes, expense_label, long_date, money, plural
from .knowledge import RuleBook, cap_phrase, cite

DEMO_PERSONAS = {"MI": "rowan-mi", "NY": "rowan-ny", "CA": "rowan-ca", "TX": "rowan-tx"}
FICTIONAL = "Fictional person and data on Capital One's Nessie mock bank. No real person, account, or hospital."
FICTIONAL_SHORT = "(Fictional demo data on a mock bank.)"


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


def demo_state(scan: dict[str, Any], audit: dict[str, Any] | None, persona_id: str) -> dict[str, Any]:
    """What the agent remembers between messages: ids and amounts only."""
    holds = {h["item_id"] for h in (audit or {}).get("holds") or []}
    pay_lines = [ln for ln in (audit or {}).get("lines") or [] if ln.get("item_id") not in holds]
    account = scan.get("account") or {}
    return {
        "persona_id": persona_id,
        "st": scan.get("st"),
        "scan_id": scan.get("scan_id"),
        "account_id": account.get("id"),
        "account_label": f"{account.get('nickname') or 'Checking'} ending {account.get('mask') or '----'}",
        "bill_id": (audit or {}).get("bill_id"),
        "provider": (audit or {}).get("provider"),
        "pay_item_ids": [ln["item_id"] for ln in pay_lines],
        "payable_cents": int((audit or {}).get("payable_cents") or 0),
        "held_cents": int((audit or {}).get("held_cents") or 0),
        "police_report": ((scan.get("engine_input") or {}).get("context") or {}).get("police_report"),
        "claim_id": None,
        "paid": False,
    }


def confirmed_input(scan: dict[str, Any], audit: dict[str, Any] | None) -> dict[str, Any]:
    """The engine input after the person said yes to every cost. Bill lines come from the audited bill."""
    base = scan["engine_input"]
    items = [dict(i, confirmed=True) for i in base["items"] if not i.get("is_bill")]
    if audit and audit.get("engine_items"):
        items += [dict(i, confirmed=True) for i in audit["engine_items"]]
    else:
        items += [dict(i, confirmed=True) for i in base["items"] if i.get("is_bill")]
    return {**base, "items": items}


def render_scan(scan: dict[str, Any], audit: dict[str, Any] | None, name: str) -> str:
    who = scan.get("display_name") or "the demo person"
    lines = [
        f"**Demo: {who}, {name}.** {FICTIONAL}",
        f"Tend read {plural(int(scan.get('read_count') or 0), 'bank record')} and found these possible costs since "
        f"{long_date(scan.get('incident_date'))}:",
    ]
    for g in groups(scan):
        lines.append(f"- {expense_label(g['expense'])}: {plural(g['count'], 'charge')}, {money(g['cents'])}")
    bill = bill_summary(audit)
    if bill:
        lines.append(
            f"- Hospital bill (itemized): {plural(bill['lines'], 'line')}, {money(bill['total_cents'])}. The lines add up to the total."
        )
    lines.append("Nothing counts until the survivor says yes. Count these for the demo claim? Say **yes** or **not now**.")
    return "\n".join(lines[:2]) + "\n\n" + "\n".join(lines[2:-1]) + "\n\n" + lines[-1]


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
                why = "no verified rule covers this yet, so ask a Navigator"
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
        out.append(
            f"**Don't pay this line:** forensic exam, {money(cents)} on the hospital bill. The law says the survivor should not be billed.\n{block}".strip()
        )

    checks = claim.get("checks") or {}
    facts = []
    deadline = checks.get("deadline") or {}
    rid = next((r for r in deadline.get("rule_ids") or [] if r in book.by_id), None)
    link = f" ({cite_link(cite(book.by_id[rid], book.sources))})" if rid else ""
    facts.append(deadline_sentence(deadline.get("status"), deadline.get("deadline_date"), link, deadline.get("flags")))
    reporting = (checks.get("reporting") or {}).get("status")
    if reporting == "satisfied":
        reported = demo.get("police_report") == "yes"
        facts.append("The police report meets that rule." if reported else "The forensic exam counts in place of a police report.")
    elif reporting == "required":
        facts.append("This state asks for a police report.")
    facts = [f for f in facts if f]
    if facts:
        out.append(" ".join(facts))

    if demo.get("payable_cents") and not demo.get("paid"):
        out.append(
            f"The rest of the hospital bill is **{money(demo['payable_cents'])}**. Want to pay it from "
            f"{demo['account_label']} (mock bank)? Say **pay the bill**. Nothing moves until you type a code."
        )
    return "\n\n".join(out)


def deadline_sentence(status: Any, date: Any, link: str = "", flags: Any = None) -> str:
    """The filing deadline in one sentence. A late date is never shown as "apply by"."""
    if not date or status not in ("ok", "late"):
        return ""
    if status == "late":
        text = f"The usual deadline was {long_date(date)}{link}. Some programs allow more time for a good reason, so it is worth calling."
    else:
        text = f"Apply by {long_date(date)}{link}."
    return text + deadline_notes(flags)


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
        rule = next((r for r in book.of("exam_no_bill")), None) if book else None
        link = f" ({cite_link(cite(rule, book.sources))})" if rule and book else ""
        out.append(
            f"The forensic exam line, {money(demo['held_cents'])}, stays unpaid. The law says the hospital should not bill it{link}."
        )
    return "\n\n".join(out)


def render_linked(summary: dict[str, Any], app_url: str = "", packet_url: str = "") -> str:
    """A claim someone linked from the Tend app: totals and rules only, no bill text or descriptions."""
    out = [f"**Amount you can ask for: {money(int(summary.get('amount_you_can_ask_for_cents') or 0))}. The program decides.**"]
    if summary.get("fictional"):
        out.append(f"_{FICTIONAL}_")
    rows = []
    by_amount = sorted(summary.get("by_expense") or [], key=lambda e: -int(e.get("allowed_cents") or 0))
    for e in by_amount:
        rule = (e.get("rules") or [None])[0]
        link = f" ({cite_link(rule)})" if rule else ""
        rows.append(
            f"- {expense_label(e.get('expense'))}: {money(int(e.get('allowed_cents') or 0))} ({plural(int(e.get('lines') or 0), 'line')}){link}"
        )
    if rows:
        out.append("What counts:\n" + "\n".join(rows))
    for h in summary.get("held") or []:
        rule = (h.get("rules") or [None])[0]
        block = cite_block(rule) if rule else ""
        out.append(f"**Don't pay this line:** {money(int(h.get('amount_cents') or 0))}. {h.get('message') or ''}\n{block}".strip())
    waiting = int(summary.get("waiting_for_confirmation") or 0)
    if waiting:
        out.append(f"{plural(waiting, 'line')} still wait for a yes in the app.")
    deadline = (summary.get("checks") or {}).get("deadline") or {}
    rule = (deadline.get("rules") or [None])[0]
    link = f" ({cite_link(rule)})" if rule else ""
    sentence = deadline_sentence(deadline.get("status"), deadline.get("deadline_date"), link, deadline.get("flags"))
    if sentence:
        out.append(sentence)
    if packet_url:
        out.append(f"Packet (PDF, link expires): {packet_url}")
    program = summary.get("program") or {}
    if program.get("phone"):
        out.append(f"Program phone: {program['phone']}.")
    return "\n\n".join(out)
