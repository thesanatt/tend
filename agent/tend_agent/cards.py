"""ASI:One Interactive Cards, built with the validated models in uagents_core (bad payloads fail here, in tests,
not silently in the chat)."""

from __future__ import annotations

from typing import Any

from uagents_core.contrib.protocols.chat.cards import (
    CtaAction,
    DetailCardPayload,
    DetailSummaryRow,
    FormCardPayload,
    FormField,
    FormFieldOption,
    ReviewCardPayload,
    ReviewSummaryRow,
)

from .fmt import expense_label, money, plural
from .states import STATES


def welcome_card() -> DetailCardPayload:
    return DetailCardPayload(
        title="Tend Navigator",
        summary_rows=[
            DetailSummaryRow(label="Ask", value="Questions about any state's program, answered with the law quoted"),
            DetailSummaryRow(label="Check", value="Deadline, police report rules, and what is covered (2 minutes)"),
            DetailSummaryRow(label="Demo", value="Walk through a fictional claim and a confirm-coded mock payment"),
            DetailSummaryRow(label="Privacy", value="No account, no name, no story. Never tell me what happened."),
        ],
        ctas=[
            CtaAction(label="Run a Check", primary=True, selection={"action": "check_form"}),
            CtaAction(label="See the demo claim", selection={"action": "demo"}),
        ],
    )


def check_form(st: str | None = None) -> FormCardPayload:
    states = sorted(STATES.items(), key=lambda kv: kv[1])
    if st in STATES:  # put the state they named first so it is one tap
        states.sort(key=lambda kv: kv[0] != st)
    return FormCardPayload(
        title="Check (about 2 minutes, nothing saved)",
        fields=[
            FormField(
                name="st",
                kind="select",
                label="State",
                required=True,
                options=[FormFieldOption(value=code, label=name) for code, name in states],
            ),
            FormField(
                name="incident_date", kind="text", label="Date it happened (only the date)", placeholder="YYYY-MM-DD, or leave blank"
            ),
            FormField(
                name="forensic_exam",
                kind="select",
                label="Had a forensic exam?",
                options=[
                    FormFieldOption(value="yes", label="Yes"),
                    FormFieldOption(value="no", label="No"),
                    FormFieldOption(value="not_sure", label="Not sure"),
                ],
            ),
            FormField(
                name="police_report",
                kind="select",
                label="Reported to police?",
                options=[
                    FormFieldOption(value="yes", label="Yes"),
                    FormFieldOption(value="no", label="No"),
                    FormFieldOption(value="not_yet", label="Not yet"),
                ],
            ),
        ],
        submit_cta=CtaAction(label="Run the Check", primary=True, selection={"action": "check"}),
    )


def count_costs_card(groups: list[dict[str, Any]], bill: dict[str, Any] | None, *, scan_id: str) -> ReviewCardPayload:
    rows = [
        ReviewSummaryRow(label=expense_label(g["expense"]), value=f"{plural(g['count'], 'charge')}, {money(g['cents'])}") for g in groups
    ]
    if bill:
        rows.append(
            ReviewSummaryRow(label="Hospital bill (itemized)", value=f"{plural(bill['lines'], 'line')}, {money(bill['total_cents'])}")
        )
    rows.append(ReviewSummaryRow(label="Data", value="Fictional person on Capital One's Nessie mock bank"))
    return ReviewCardPayload(
        title="Count these costs for the demo claim?",
        summary_rows=rows,
        approve_cta=CtaAction(label="Yes, count them", primary=True, selection={"action": "count_costs", "scan_id": scan_id}),
        reject_cta=CtaAction(label="Not now", selection={"action": "skip_costs", "scan_id": scan_id}),
    )


def payment_card(p: dict[str, Any]) -> ReviewCardPayload:
    rows = [
        ReviewSummaryRow(label="Pay to", value=p["payee_label"]),
        ReviewSummaryRow(label="Amount", value=money(p["amount_cents"])),
        ReviewSummaryRow(label="From", value=p["from_label"]),
        ReviewSummaryRow(label="Pays", value=p["lines_label"]),
    ]
    if p.get("held_cents"):
        rows.append(ReviewSummaryRow(label="Not paid", value=f"Forensic exam line, {money(p['held_cents'])} (held by law)"))
    rows += [
        ReviewSummaryRow(label="Confirm code", value=p["code"]),
        ReviewSummaryRow(label="Code ends", value="in 10 minutes, works once"),
        ReviewSummaryRow(label="Bank", value=p["bank_label"]),
    ]
    return ReviewCardPayload(
        title=f"Review: pay {money(p['amount_cents'])}",
        summary_rows=rows,
        approve_cta=CtaAction(label="Continue", primary=True, selection={"action": "pay_approve", "action_id": p["action_id"]}),
        reject_cta=CtaAction(label="Cancel", selection={"action": "pay_cancel", "action_id": p["action_id"]}),
    )


def code_form(action_id: str, amount_cents: int) -> FormCardPayload:
    """The person types the code themselves. The agent never fills it in."""
    return FormCardPayload(
        title=f"Type the code to pay {money(amount_cents)}",
        fields=[FormField(name="code", kind="text", label="6-digit code from the review card", required=True, placeholder="123456")],
        submit_cta=CtaAction(label=f"Pay {money(amount_cents)}", primary=True, selection={"action": "pay_confirm", "action_id": action_id}),
    )
