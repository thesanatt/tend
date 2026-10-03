"""Itemized hospital statement for the demo. Fictional, and every page says so.

Drawn with reportlab in invariant mode, so the same persona always produces the same bytes and
the sha256 in the snapshot stays valid. Each table row is drawn left to right on one baseline,
which keeps text extraction (pypdf, or a model reading the PDF) in row order.
"""
from __future__ import annotations

import hashlib
from datetime import date
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

from history import PlannedBill, hospital_address
from personas import Persona

INK = HexColor("#1f2421")
MUTED = HexColor("#5b625d")
RULE = HexColor("#c9ccc6")
BANNER = HexColor("#efe9dc")


def money(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}${cents // 100:,}.{cents % 100:02d}"


def us_date(iso: str) -> str:
    return date.fromisoformat(iso).strftime("%m/%d/%Y")


def statement_account_number(persona: Persona) -> str:
    digits = int(hashlib.sha256(persona.id.encode()).hexdigest(), 16) % 1_000_000
    return f"RGH-{digits:06d}"


def bill_pdf_path(root: Path, persona: Persona) -> Path:
    return root / "bills" / f"{persona.id}-riverbend.pdf"


def write_bill_pdf(persona: Persona, bill: PlannedBill, path: Path) -> str:
    if sum(line.patient_cents for line in bill.lines) != bill.amount_cents:
        raise ValueError("bill lines do not add up to the bill total")
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(path), pagesize=letter, invariant=1)
    pdf.setTitle(f"{bill.payee} statement (fictional demo)")
    pdf.setAuthor("Tend demo seed")
    pdf.setSubject("Fictional itemized hospital statement for a hackathon demo")
    width, height = letter
    left, right = 54, width - 54

    pdf.setFillColor(BANNER)
    pdf.rect(left, height - 74, right - left, 30, stroke=0, fill=1)
    pdf.setFillColor(INK)
    pdf.setFont("Helvetica-Bold", 9)
    pdf.drawString(left + 10, height - 63,
                   "FICTIONAL DEMO DOCUMENT. Not a real bill, patient, or hospital. Made for the Tend demo at MHacks 2026.")

    hosp = hospital_address(persona)
    y = height - 112
    pdf.setFont("Helvetica-Bold", 16)
    pdf.drawString(left, y, bill.payee)
    pdf.setFont("Helvetica", 9.5)
    pdf.setFillColor(MUTED)
    pdf.drawString(left, y - 16, f"{hosp['street_number']} {hosp['street_name']}, {hosp['city']}, {hosp['state']} {hosp['zip']}")
    pdf.drawString(left, y - 29, f"Patient Financial Services ({persona.area_code}) 555-0142")

    pdf.setFillColor(INK)
    pdf.setFont("Helvetica-Bold", 12)
    pdf.drawRightString(right, y, "Itemized statement")
    pdf.setFont("Helvetica", 9.5)
    pdf.drawRightString(right, y - 16, f"Statement date: {us_date(bill.statement_date)}")
    pdf.drawRightString(right, y - 29, f"Account: {statement_account_number(persona)}")

    y -= 66
    pdf.setFont("Helvetica-Bold", 9.5)
    pdf.drawString(left, y, "Patient")
    pdf.drawString(left + 260, y, "Coverage")
    pdf.setFont("Helvetica", 9.5)
    pdf.drawString(left, y - 14, persona.display_name)
    pdf.drawString(left, y - 27, f"{persona.street_number} {persona.street_name}")
    pdf.drawString(left, y - 40, f"{persona.city}, {persona.jurisdiction} {persona.zip}")
    pdf.drawString(left + 260, y - 14, f"Insurance billed: {bill.insurer}")
    pdf.drawString(left + 260, y - 27, f"Date of service: {us_date(bill.service_date)}")

    # Right edges checked against Helvetica 9 pt widths so no header or amount overlaps.
    cols = [("Line", left, "l"), ("Date", left + 26, "l"), ("Description", left + 82, "l"),
            ("Charges", left + 318, "r"), ("Insurance paid", left + 394, "r"), ("Adjustments", left + 456, "r"),
            ("You owe", right, "r")]

    def row(values: list[str], ypos: float, bold: bool = False) -> None:
        pdf.setFont("Helvetica-Bold" if bold else "Helvetica", 9)
        for (_, x, align), text in zip(cols, values):
            if align == "r":
                pdf.drawRightString(x, ypos, text)
            else:
                pdf.drawString(x, ypos, text)

    y -= 76
    row([c[0] for c in cols], y, bold=True)
    pdf.setStrokeColor(RULE)
    pdf.line(left, y - 6, right, y - 6)
    for line in bill.lines:
        y -= 20
        row([str(line.line), us_date(line.date), line.description, money(line.charge_cents),
             money(line.insurance_paid_cents), money(line.adjustment_cents), money(line.patient_cents)], y)
    pdf.line(left, y - 8, right, y - 8)
    y -= 22
    row(["", "", "Totals", money(sum(line.charge_cents for line in bill.lines)),
         money(sum(line.insurance_paid_cents for line in bill.lines)),
         money(sum(line.adjustment_cents for line in bill.lines)), money(bill.amount_cents)], y, bold=True)

    y -= 44
    pdf.setFont("Helvetica-Bold", 12)
    pdf.drawString(left, y, f"Amount due by {us_date(bill.payment_date)}: {money(bill.amount_cents)}")
    pdf.setFont("Helvetica", 9)
    pdf.setFillColor(MUTED)
    pdf.drawString(left, y - 18, "Charges are listed by line. Insurance payments and adjustments are applied before the amount you owe.")
    pdf.drawString(left, 54, "Every name, number, and address on this page is invented for a demo.")
    pdf.showPage()
    pdf.save()
    return hashlib.sha256(path.read_bytes()).hexdigest()
