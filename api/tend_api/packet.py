from __future__ import annotations

import datetime as dt
import io
import unicodedata
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from .agent import DISCOVERY_NOTE
from .claims import consent_flag
from .clock import PROGRAM_TZ
from .forms import FORM_SPECS, application_values, fill_application
from .money import format_cents

INK = colors.HexColor("#1f2a24")
MUTED = colors.HexColor("#5b665f")
LINE = colors.HexColor("#c9cfc8")
CLAY = colors.HexColor("#9a4a2c")
GREEN = colors.HexColor("#2f6b4f")
PAPER = colors.HexColor("#f4f1ea")

STATUS_LABEL = {
    "eligible": "Counted",
    "needs_confirmation": "Waiting for your yes",
    "held": "Held",
    "excluded": "Not covered",
    "unknown_rule": "Ask a Navigator",
    "out_of_window": "Outside the dates",
}
CHECK_LABEL = {
    "deadline": {"ok": "On time", "late": "Past the filing deadline", "unknown": "Unknown"},
    "minimum_loss": {"met": "Met", "not_met": "Not met yet", "waived": "Waived", "may_be_waived": "Can be waived", "unknown": "Unknown"},
    "reporting": {"satisfied": "Satisfied", "required": "Police report needed", "not_required": "Not required", "unknown": "Unknown"},
}
# A late deadline counted from the report or from discovery may not be late (docs/SPEC.md v1.3): it
# says so with its notes, never "Past the filing deadline".
DEADLINE_NOTES = {
    "deadline_from_report": "Measured from the date it happened. The law counts from your report, so you may have longer.",
    "deadline_from_discovery": DISCOVERY_NOTE,
}
CHECK_TITLE = {"deadline": "Filing deadline", "minimum_loss": "Minimum loss", "reporting": "Police report"}
DOCS_BY_EXPENSE = {
    "medical": "Itemized bills from each medical provider, with dates of service",
    "prescription": "Pharmacy receipts",
    "dental": "Itemized dental bills",
    "counseling": "A statement from your counselor listing session dates and the rate charged",
    "lost_wages": "A statement from your employer showing the days you missed and your pay",
    "transportation": "Receipts for rides, or a mileage log with dates",
    "relocation": "Moving receipts and the new lease",
    "temporary_housing": "Receipts for temporary housing",
    "security": "Receipts for locks or other security work",
    "childcare": "Receipts from your childcare provider",
    "clothing_bedding": "Receipts for replacement clothing or bedding",
    "crime_scene_cleanup": "Receipts for cleanup services",
    "funeral": "Funeral and burial receipts",
    "other": "A receipt for each other expense",
}
INSURABLE = {"medical", "prescription", "dental", "counseling"}


TYPOGRAPHY = (
    ("\u2018", "'"),
    ("\u2019", "'"),
    ("\u201c", '"'),
    ("\u201d", '"'),
    ("\u2013", "-"),
    ("\u2014", "-"),
    ("\u00a0", " "),
)


def _text(value: Any) -> str:
    """Plain text the built-in PDF fonts can draw, escaped for reportlab markup."""
    s = unicodedata.normalize("NFKC", str(value if value is not None else ""))
    for bad, good in TYPOGRAPHY:
        s = s.replace(bad, good)
    s = s.encode("cp1252", errors="replace").decode("cp1252")
    return escape(s)


EXPENSE_LABELS = {"clothing_bedding": "Clothing and bedding"}


def expense_label(expense: str) -> str:
    return EXPENSE_LABELS.get(expense, expense.replace("_", " ").capitalize())


def still_needed(view: dict[str, Any], rules_doc: dict[str, Any]) -> list[dict[str, Any]]:
    """Documents the claim still needs, each tied to the line status, check, or rule that calls for it."""
    lines = view["lines"]
    needed: list[dict[str, Any]] = []
    counted = sorted({ln["expense"] for ln in lines if ln.get("status") in ("eligible", "needs_confirmation")})
    for expense in counted:
        if expense in DOCS_BY_EXPENSE:
            needed.append(
                {"document": DOCS_BY_EXPENSE[expense], "why": f"You are asking for {expense_label(expense).lower()} costs.", "rule_ids": []}
            )
    collateral = [r["id"] for r in rules_doc.get("rules", []) if r.get("category") == "collateral_source"]
    if collateral and INSURABLE & set(counted):
        needed.append(
            {
                "document": "Insurance statements (explanation of benefits) for those bills, or a note that you have no insurance",
                "why": "The program pays after insurance and other sources.",
                "rule_ids": collateral[:1],
            }
        )
    reporting = (view.get("checks") or {}).get("reporting", {})
    status = reporting.get("status")
    if status == "satisfied" and view.get("context", {}).get("police_report") != "yes":
        needed.append(
            {
                "document": "Proof that you had a forensic exam (the hospital can provide it)",
                "why": "Here the exam stands in for a police report.",
                "rule_ids": reporting.get("rule_ids", []),
            }
        )
    elif status == "satisfied":
        needed.append(
            {"document": "The police report number", "why": "The program checks police records.", "rule_ids": reporting.get("rule_ids", [])}
        )
    elif status == "required":
        needed.append(
            {
                "document": "A police report, or proof of an allowed alternative",
                "why": "This program requires a report.",
                "rule_ids": reporting.get("rule_ids", []),
            }
        )
    elif status == "unknown" and reporting.get("rule_ids"):
        needed.append(
            {
                "document": "Ask a Navigator whether you need a police report",
                "why": "Tend could not tell from what you shared.",
                "rule_ids": reporting.get("rule_ids", []),
            }
        )
    if any(ln.get("status") == "held" for ln in lines):
        needed.append(
            {
                "document": "A copy of the bill with the held line marked, to send back to billing",
                "why": "The law says you should not have been billed for it.",
                "rule_ids": [],
            }
        )
    waiting = sum(1 for ln in lines if ln.get("status") == "needs_confirmation")
    if waiting:
        needed.append(
            {
                "document": f"Your yes on {waiting} more {'line' if waiting == 1 else 'lines'} in Tend",
                "why": "Tend does not count a line until you confirm it.",
                "rule_ids": [],
            }
        )
    deadline = (view.get("checks") or {}).get("deadline", {})
    if deadline.get("status") == "late":
        needed.append(
            {
                "document": "A short written reason for filing late",
                "why": "Some programs accept a late claim for a good reason. The program decides.",
                "rule_ids": deadline.get("rule_ids", []),
            }
        )
    needed.append({"document": "Your signature on the application", "why": "Tend never signs or files for you.", "rule_ids": []})
    return needed


def _styles() -> dict[str, ParagraphStyle]:
    base = ParagraphStyle("base", fontName="Helvetica", fontSize=9.5, leading=13, textColor=INK)
    return {
        "base": base,
        "small": ParagraphStyle("small", parent=base, fontSize=8, leading=10.5, textColor=MUTED),
        "quote": ParagraphStyle("quote", parent=base, fontSize=8.5, leading=11.5, leftIndent=8, textColor=INK),
        "title": ParagraphStyle("title", parent=base, fontName="Helvetica-Bold", fontSize=17, leading=21),
        "h2": ParagraphStyle(
            "h2", parent=base, fontName="Helvetica-Bold", fontSize=11.5, leading=15, spaceBefore=14, spaceAfter=5, keepWithNext=1
        ),
        "big": ParagraphStyle("big", parent=base, fontName="Helvetica-Bold", fontSize=20, leading=24, textColor=GREEN),
        "cell": ParagraphStyle("cell", parent=base, fontSize=8.5, leading=11),
        "cellb": ParagraphStyle("cellb", parent=base, fontName="Helvetica-Bold", fontSize=8.5, leading=11),
        "banner": ParagraphStyle("banner", parent=base, fontSize=9, leading=12, textColor=CLAY),
        # Transaction ids have no spaces, so let them break anywhere instead of running into the next column.
        "id": ParagraphStyle("id", parent=base, fontName="Courier", fontSize=7, leading=9, textColor=MUTED, wordWrap="CJK"),
    }


def _natural(source_id: str) -> tuple[str, int]:
    prefix, _, number = source_id.rpartition("S")
    return (prefix, int(number)) if number.isdigit() else (source_id, 0)


def _quote_lines(citations: list[dict[str, Any]], st: dict[str, ParagraphStyle]) -> list[Paragraph]:
    out = []
    for c in citations:
        out.append(
            Paragraph(
                f'<b>{_text(c["rule_id"])}</b>, {_text(c.get("pinpoint"))}: "{_text(c.get("quote"))}" '
                f"<font color='#5b665f'>Source {_text(c.get('source_id'))}.</font>",
                st["quote"],
            )
        )
    return out


GROUP_ORDER = ("eligible", "needs_confirmation", "held", "excluded", "unknown_rule", "out_of_window")
GROUP_NOTE = {
    "needs_confirmation": "Tend counts these after you confirm them.",
    "held": "Don't pay this line. Ask billing to remove it first.",
    "excluded": "The program lists this as not covered.",
    "unknown_rule": "No rule for this expense was found. Ask a Navigator.",
    "out_of_window": "Dated before the incident or after this packet was made.",
}
STATUS_COLOR = {"held": "#9a4a2c", "eligible": "#2f6b4f"}


def _groups(lines: list[dict[str, Any]]) -> list[tuple[tuple[str, str], list[dict[str, Any]]]]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for ln in lines:
        groups.setdefault((ln.get("status", ""), ln.get("expense", "")), []).append(ln)
    order = {s: i for i, s in enumerate(GROUP_ORDER)}
    return sorted(groups.items(), key=lambda kv: (order.get(kv[0][0], len(order)), kv[0][1]))


def _unique_citations(group: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: dict[str, dict[str, Any]] = {}
    for ln in group:
        for c in ln.get("citations", []):
            seen.setdefault(c["rule_id"], c)
    return list(seen.values())


def _group_story(
    status: str, expense: str, group: list[dict[str, Any]], rules_doc: dict[str, Any], st: dict[str, ParagraphStyle]
) -> list[Any]:
    requested = sum(ln.get("requested_cents", ln.get("amount_cents") or 0) for ln in group)
    allowed = sum(ln.get("allowed_cents", 0) for ln in group)
    detail = f"{len(group)} {'line' if len(group) == 1 else 'lines'}, {format_cents(requested)}"
    if status == "eligible":
        detail += f", {format_cents(allowed)} you can ask for"
    color = STATUS_COLOR.get(status, "#5b665f")
    out: list[Any] = [
        Paragraph(
            f"<b>{_text(expense_label(expense))}</b>: <font color='{color}'>{_text(STATUS_LABEL.get(status, status))}</font>"
            f" <font color='#5b665f'>({_text(detail)})</font>",
            st["base"],
        )
    ]
    if status in GROUP_NOTE:
        out.append(Paragraph(f"<font color='{color}'>{_text(GROUP_NOTE[status])}</font>", st["base"]))
    citations = _unique_citations(group)
    if status == "held":
        out += _quote_lines([c for c in citations if c.get("category") == "exam_no_bill"], st)
        payers = [c for c in citations if c.get("category") == "exam_payment"]
        if payers:
            out.append(Paragraph("Who pays for the exam instead:", st["small"]))
            out += _quote_lines(payers, st)
        flags = [f for ln in group if (f := consent_flag(ln["item_id"], ln.get("description") or "", rules_doc, {}))]
        if flags:
            out.append(Paragraph(f"<font color='{color}'>{_text(flags[0]['message'])}</font>", st["base"]))
    else:
        out += _quote_lines(citations, st)
    out.append(Spacer(1, 3))
    out.append(_lines_table(group, st))
    return out


def _lines_table(group: list[dict[str, Any]], st: dict[str, ParagraphStyle]) -> Table:
    rows: list[list[Any]] = [[Paragraph(h, st["cellb"]) for h in ("Date", "What", "Transaction", "Amount", "Can ask for")]]
    # The group already quotes its rules; name them per line only when lines differ.
    shared = all(ln.get("rule_ids") == group[0].get("rule_ids") for ln in group)
    for ln in group:
        notes = [] if shared else [", ".join(ln.get("rule_ids") or [])]
        if ln.get("cap_rule_id"):
            notes.append(f"capped by {ln['cap_rule_id']}")
        if ln.get("flags"):
            notes.append(", ".join(ln["flags"]))
        what = _text(ln.get("description"))
        sub = "; ".join(n for n in notes if n)
        if sub:
            what += f"<br/><font size='7' color='#5b665f'>{_text(sub)}</font>"
        rows.append(
            [
                Paragraph(_text(ln.get("date")), st["cell"]),
                Paragraph(what, st["cell"]),
                Paragraph(_text(ln["item_id"]), st["id"]),
                Paragraph(format_cents(ln.get("requested_cents", ln.get("amount_cents") or 0)), st["cell"]),
                Paragraph(format_cents(ln.get("allowed_cents", 0)), st["cell"]),
            ]
        )
    table = Table(rows, colWidths=[0.8 * inch, 2.55 * inch, 1.75 * inch, 0.85 * inch, 0.95 * inch], repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LINEBELOW", (0, 0), (-1, 0), 0.6, INK),
                ("LINEBELOW", (0, 1), (-1, -1), 0.3, LINE),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    return table


def build_summary(view: dict[str, Any], rules_doc: dict[str, Any], generated_at: dt.datetime) -> bytes:
    st = _styles()
    totals = view.get("totals", {})
    lines = sorted(view["lines"], key=lambda ln: (ln.get("date") or "", ln["item_id"]))
    program = view.get("program") or {}
    story: list[Any] = []

    story.append(
        Paragraph(
            f"Claim packet: {_text(view.get('name') or view['jurisdiction'])} {_text(program.get('program_name') or 'crime victim compensation')}",
            st["title"],
        )
    )
    who = f" for {_text(view['display_name'])}" if view.get("display_name") else ""
    day = generated_at.astimezone(PROGRAM_TZ)
    story.append(Paragraph(f"Prepared{who} with Tend on {day:%B} {day.day}, {day.year}. Claim {_text(view['claim_id'])}.", st["small"]))
    if view.get("fictional"):
        story.append(Spacer(1, 6))
        story.append(
            Paragraph(
                "Demo packet. The person and every record in it are fictional. Bank records come from Capital One's Nessie sandbox, a mock bank.",
                st["banner"],
            )
        )
    story.append(Spacer(1, 12))
    story.append(Paragraph("Amount you can ask for", st["small"]))
    story.append(Paragraph(format_cents(totals.get("allowed_cents", 0)), st["big"]))
    story.append(Paragraph("The program decides. Eligibility rules have exceptions, and a Navigator can help.", st["small"]))
    counted = sum(1 for ln in lines if ln.get("status") == "eligible")
    held = totals.get("held_cents", 0)
    summary = f"{counted} of {len(lines)} lines counted, from {format_cents(totals.get('requested_cents', 0))} requested."
    if held:
        summary += f" {format_cents(held)} is held: bills the law says you should not have been sent."
    story.append(Spacer(1, 4))
    story.append(Paragraph(_text(summary), st["base"]))

    checks = view.get("checks") or {}
    if checks:
        story.append(Paragraph("Checks", st["h2"]))
        rows = []
        for name in ("deadline", "minimum_loss", "reporting"):
            check = checks.get(name)
            if not check:
                continue
            label = CHECK_LABEL.get(name, {}).get(check.get("status"), check.get("status"))
            detail = f" (by {check['deadline_date']})" if check.get("deadline_date") else ""
            notes = [DEADLINE_NOTES[f] for f in check.get("flags") or [] if name == "deadline" and f in DEADLINE_NOTES]
            if notes and check.get("status") == "late" and check.get("deadline_date"):
                label, detail = f"The usual deadline was {check['deadline_date']}, but you may have more time", ""
            if notes:
                detail += ". " + " ".join(notes)
            cites = ", ".join(f"{c['rule_id']} {c.get('pinpoint') or ''}".strip() for c in check.get("citations", []))
            rows.append(
                [
                    Paragraph(CHECK_TITLE.get(name, name), st["cellb"]),
                    Paragraph(_text(f"{label}{detail}"), st["cell"]),
                    Paragraph(_text(cites or "No rule found"), st["small"]),
                ]
            )
        table = Table(rows, colWidths=[1.3 * inch, 2.2 * inch, 3.5 * inch])
        table.setStyle(
            TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ]
            )
        )
        story.append(table)

    story.append(Paragraph("Every line, with the law behind it", st["h2"]))
    story.append(
        Paragraph(
            "Lines are grouped by expense. Each group quotes its law once, word for word; each line shows its transaction and rules.",
            st["small"],
        )
    )
    for (status, expense), group in _groups(lines):
        story.append(Spacer(1, 8))
        story += _group_story(status, expense, group, rules_doc, st)

    refused = view.get("refused") or []
    if refused:
        story.append(Paragraph("Not counted: no matching transaction", st["h2"]))
        for r in refused:
            story.append(Paragraph(f"{format_cents(r['amount_cents'])} ({_text(r['item_id'])}): {_text(r['reason'])}", st["base"]))

    story.append(Paragraph("Still needed", st["h2"]))
    rules = {r["id"]: r for r in rules_doc.get("rules", [])}
    for need in still_needed(view, rules_doc):
        cites = ", ".join(f"{rid} {rules[rid].get('pinpoint', '')}".strip() for rid in need["rule_ids"] if rid in rules)
        suffix = f" <font color='#5b665f'>({_text(cites)})</font>" if cites else ""
        story.append(Paragraph(f"&bull; {_text(need['document'])}. {_text(need['why'])}{suffix}", st["base"]))

    spec = FORM_SPECS.get(view["jurisdiction"])
    if spec:
        name_filled = bool(application_values(spec, view).get(spec.name_fields[0]))
        filled = (
            "your name, the costs you are asking for, and the dates of service"
            if name_filled
            else "the costs you are asking for and the dates of service"
        )
        story.append(Paragraph("Only you write this", st["h2"]))
        story.append(Paragraph(f"Tend filled in {filled} on the state's application. It left these blank on purpose:", st["base"]))
        for item in spec.only_you:
            story.append(Paragraph(f"&bull; {_text(item)}", st["base"]))

    story.append(Paragraph("Program contact", st["h2"]))
    contact = [program.get("program_name"), program.get("agency")]
    if program.get("phone"):
        contact.append(f"Phone {program['phone']} (from source {program.get('phone_source_id') or 'on file'})")
    contact += [
        program.get("website"),
        program.get("apply_url") and f"How to apply: {program['apply_url']}",
        program.get("statute_citation") and f"Law: {program['statute_citation']}",
    ]
    for entry in filter(None, contact):
        story.append(Paragraph(_text(entry), st["base"]))

    cited = {}
    for ln in view["lines"]:
        for c in ln.get("citations", []):
            cited[c["source_id"]] = c
    for check in checks.values():
        for c in check.get("citations", []):
            cited[c["source_id"]] = c
    if cited:
        story.append(Paragraph("Sources", st["h2"]))
        story.append(
            Paragraph(
                "Each quote above is copied word for word from a saved copy of these pages. The sha256 identifies that exact copy.",
                st["small"],
            )
        )
        rows = [[Paragraph(h, st["cellb"]) for h in ("Source", "Where", "Saved copy")]]
        for sid in sorted(cited, key=_natural):
            c = cited[sid]
            rows.append(
                [
                    Paragraph(_text(sid), st["cell"]),
                    Paragraph(f"{_text(c.get('source_title'))}<br/><font color='#5b665f'>{_text(c.get('source_url'))}</font>", st["cell"]),
                    Paragraph(f"{_text(c.get('retrieved_at'))}<br/><font size='6.5'>{_text(c.get('source_sha256'))}</font>", st["small"]),
                ]
            )
        src_table = Table(rows, colWidths=[0.7 * inch, 3.7 * inch, 2.6 * inch], repeatRows=1)
        src_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE)]))
        story.append(src_table)

    footer = f"Tend claim {view['claim_id']}. Rules can have exceptions. The program decides."

    def on_page(canvas: Any, doc: Any) -> None:
        canvas.saveState()
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(MUTED)
        canvas.drawString(0.75 * inch, 0.5 * inch, footer)
        canvas.drawRightString(letter[0] - 0.75 * inch, 0.5 * inch, f"Page {doc.page}")
        canvas.restoreState()

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=letter,
        leftMargin=0.75 * inch,
        rightMargin=0.75 * inch,
        topMargin=0.7 * inch,
        bottomMargin=0.8 * inch,
        title="Tend claim packet",
        author="Tend",
        subject=f"Claim {view['claim_id']}",
    )
    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    return buf.getvalue()


def render_packet(view: dict[str, Any], rules_doc: dict[str, Any], forms_dir: Path, generated_at: dt.datetime) -> bytes:
    summary = build_summary(view, rules_doc, generated_at)
    return build_packet(summary, fill_application(forms_dir, view["jurisdiction"], view))


def build_packet(summary_pdf: bytes, application_pdf: bytes | None) -> bytes:
    """The cited summary first, then the state's own application (still fillable) when there is one."""
    if application_pdf is None:
        return summary_pdf
    from pypdf import PdfReader, PdfWriter

    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(application_pdf)))
    writer.merge(0, PdfReader(io.BytesIO(summary_pdf)))
    writer.set_need_appearances_writer(True)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()
