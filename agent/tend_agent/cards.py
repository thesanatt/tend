"""ASI:One Interactive Cards as plain payloads (card_protocol_version 1).

Built as dicts so the same code runs as an Agentverse-hosted agent, whatever uagents-core version is installed
there. tests/test_cards.py validates every payload against the schemas in uagents_core.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .fmt import expense_label, money, plural
from .states import STATES


@dataclass(frozen=True)
class Card:
    kind: str  # detail | form | review
    payload: dict[str, Any]

    @property
    def title(self) -> str:
        return str(self.payload.get("title") or "")


def _cta(label: str, selection: dict[str, Any], primary: bool = False) -> dict[str, Any]:
    return {"label": label, "selection": selection, "primary": primary}


def _rows(rows: list[tuple[str, str]]) -> list[dict[str, str]]:
    return [{"label": label, "value": value} for label, value in rows]


def welcome_card() -> Card:
    return Card(
        "detail",
        {
            "title": "Tend Navigator",
            "summary_rows": _rows(
                [
                    ("Ask", "Questions about any state's program, answered with the law quoted"),
                    ("Check", "Deadline, police report rules, and what is covered (2 minutes)"),
                    ("Demo", "A fictional claim: a held bill line, a mock payment you approve, and a locked link"),
                    ("Privacy", "No account, no name, no story. I never ask what happened."),
                ]
            ),
            "ctas": [_cta("Run a Check", {"action": "check_form"}, True), _cta("See the demo claim", {"action": "demo"})],
        },
    )


def check_form(st: str | None = None) -> Card:
    states = sorted(STATES.items(), key=lambda kv: kv[1])
    if st in STATES:  # the state they named goes first, so it is one tap
        states.sort(key=lambda kv: kv[0] != st)

    def options(*pairs: tuple[str, str]) -> list[dict[str, str]]:
        return [{"value": v, "label": label} for v, label in pairs]

    return Card(
        "form",
        {
            "title": "Check (about 2 minutes, nothing saved)",
            "fields": [
                {"name": "st", "kind": "select", "label": "State", "required": True, "options": options(*states)},
                {
                    "name": "incident_date",
                    "kind": "text",
                    "label": "Date it happened (only the date)",
                    "required": False,
                    "placeholder": "YYYY-MM-DD, or leave blank",
                },
                {
                    "name": "forensic_exam",
                    "kind": "select",
                    "label": "Had a forensic exam?",
                    "required": False,
                    "options": options(("yes", "Yes"), ("no", "No"), ("not_sure", "Not sure")),
                },
                {
                    "name": "police_report",
                    "kind": "select",
                    "label": "Reported to police?",
                    "required": False,
                    "options": options(("yes", "Yes"), ("no", "No"), ("not_yet", "Not yet")),
                },
            ],
            "submit_cta": _cta("Run the Check", {"action": "check"}, True),
        },
    )


def count_costs_card(groups: list[dict[str, Any]], bill: dict[str, Any] | None, *, scan_id: str) -> Card:
    rows = [(expense_label(g["expense"]), f"{plural(g['count'], 'charge')}, {money(g['cents'])}") for g in groups]
    if bill:
        rows.append(("Hospital bill (itemized)", f"{plural(bill['lines'], 'line')}, {money(bill['total_cents'])}"))
    rows.append(("Data", "Fictional person on Capital One's Nessie mock bank"))
    return Card(
        "review",
        {
            "title": "Count these costs for the demo claim?",
            "summary_rows": _rows(rows),
            "approve_cta": _cta("Yes, count them", {"action": "count_costs", "scan_id": scan_id}, True),
            "reject_cta": _cta("Not now", {"action": "skip_costs", "scan_id": scan_id}),
        },
    )


def next_steps_card(payable_cents: int, *, paid: bool) -> Card:
    ctas = []
    if payable_cents and not paid:
        ctas.append(_cta(f"Pay the {money(payable_cents)} left on the bill", {"action": "pay"}, True))
    ctas.append(_cta("Make a locked link for an advocate", {"action": "share"}, not ctas))
    rows = [("Held by law", "The forensic exam line stays unpaid"), ("Data", "Fictional, on a mock bank")]
    return Card("detail", {"title": "What next?", "summary_rows": _rows(rows), "ctas": ctas})


def payment_card(p: dict[str, Any]) -> Card:
    rows = [
        ("Pay to", p["payee_label"]),
        ("Amount", money(p["amount_cents"])),
        ("From", p["from_label"]),
        ("Pays", p["lines_label"]),
    ]
    if p.get("held_cents"):
        rows.append(("Not paid", f"Forensic exam line, {money(p['held_cents'])} (held by law)"))
    rows += [
        ("Confirm code", p["code"]),
        ("Code ends", "in 10 minutes, works once"),
        ("Bank", p["bank_label"]),
    ]
    return Card(
        "review",
        {
            "title": f"Review: pay {money(p['amount_cents'])}",
            "summary_rows": _rows(rows),
            "approve_cta": _cta("Continue", {"action": "pay_approve", "action_id": p["action_id"]}, True),
            "reject_cta": _cta("Cancel", {"action": "pay_cancel", "action_id": p["action_id"]}),
        },
    )


def code_form(action_id: str, amount_cents: int) -> Card:
    """The person types the code themselves. The agent never fills it in."""
    return Card(
        "form",
        {
            "title": f"Type the code to pay {money(amount_cents)}",
            "fields": [
                {"name": "code", "kind": "text", "label": "6-digit code from the review card", "required": True, "placeholder": "123456"}
            ],
            "submit_cta": _cta(f"Pay {money(amount_cents)}", {"action": "pay_confirm", "action_id": action_id}, True),
        },
    )


def share_card(expires: str, still_needed: int) -> Card:
    rows = [
        ("Opens", "In the advocate's browser, with the key in the link"),
        ("Tend's server", "Keeps a locked copy it cannot read"),
        ("Link stops working", expires),
        ("Still needed", plural(still_needed, "document")),
        ("Left blank", "Name, signature, Social Security number, and anything about what happened"),
    ]
    return Card(
        "detail",
        {"title": "Locked link for an advocate", "summary_rows": _rows(rows), "ctas": [_cta("Run a Check", {"action": "check_form"})]},
    )
