"""The letter to the billing office for a held exam line: the same letter the Tend app writes (web/lib/packet/
letters.ts, billingHold), quoting the state's own words. Names, dates, and account numbers stay as [placeholders];
Tend never knows them and never fills them in.
"""

from __future__ import annotations

from typing import Any

from .fmt import long_date, money
from .knowledge import RuleBook

SIGN_OFF = "Thank you,\n[Your name]\n[A safe way to reach you]"


def _quote(rule: dict[str, Any]) -> str:
    return f'"{str(rule.get("quote") or "").strip()}" ({rule.get("pinpoint") or rule.get("id")})'


def _charge(line: dict[str, Any]) -> str:
    what = str(line.get("description") or "").strip() or "Charge"
    when = f", {long_date(line['date'])}" if line.get("date") else ""
    return f"    {what}{when}: {money(int(line.get('amount_cents') or 0))}"


def billing_letter(book: RuleBook, held: list[dict[str, Any]]) -> str:
    """held: the bill lines the law engine held, each with description, date, amount_cents, and rule_ids."""
    cited = {r for line in held for r in line.get("rule_ids") or []}

    def pick(rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
        mine = [r for r in rules if r.get("id") in cited]
        return (mine or rules)[:1]

    why = pick(book.of("exam_no_bill"))
    payers = pick(book.of("exam_payment"))
    if not why and not (held and payers):
        return ""
    charges = "\n".join(_charge(line) for line in held) if held else "    [Exam charge, date of service]: [amount]"
    these = "these charges" if len(held) > 1 else "this charge"
    paragraphs = [
        "[Date]",
        "To: Billing office, [hospital or clinic name]\nAbout: Account [account number]",
        f"I am writing about {these} on my account for a sexual assault forensic exam:\n\n{charges}",
        f"{book.name} law says I should not be billed for this exam:\n\n" + "\n\n".join(_quote(r) for r in why)
        if why
        else f"{book.name} law says this about paying for the exam:\n\n" + "\n\n".join(_quote(r) for r in payers),
        "Please remove the exam charge from my account, stop any collection on it, and send me an updated statement."
        if why
        else "Please put this charge on hold while the exam is paid for the way the law describes, and send me an updated statement.",
        "The law names who pays for the exam instead:\n\n" + "\n\n".join(_quote(r) for r in payers) if why and payers else "",
        "If you have questions, please contact me in writing.",
        SIGN_OFF,
    ]
    return "\n\n".join(p for p in paragraphs if p) + "\n"
