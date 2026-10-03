import hashlib
import re
from pathlib import Path

import pytest
from pypdf import PdfReader

from bill_pdf import bill_pdf_path, money, write_bill_pdf
from history import RIVERBEND_BILL
from personas import PERSONAS

SEED = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("pid", sorted(PERSONAS))
def test_pdf_is_reproducible_and_matches_the_committed_file(pid, tmp_path):
    persona = PERSONAS[pid]
    sha = write_bill_pdf(persona, RIVERBEND_BILL, tmp_path / "bill.pdf")
    assert sha == write_bill_pdf(persona, RIVERBEND_BILL, tmp_path / "again.pdf")
    assert sha == hashlib.sha256(bill_pdf_path(SEED, persona).read_bytes()).hexdigest()


def test_pdf_text_reads_in_row_order_and_adds_up(tmp_path):
    path = tmp_path / "bill.pdf"
    write_bill_pdf(PERSONAS["rowan-mi"], RIVERBEND_BILL, path)
    text = PdfReader(str(path)).pages[0].extract_text()
    assert text.startswith("FICTIONAL DEMO DOCUMENT")
    assert "Rowan Hale" in text and "Date of service: 06/14/2026" in text
    lines = text.splitlines()
    owed = []
    for line in RIVERBEND_BILL.lines:
        at = lines.index(line.description)
        assert lines[at - 2] == str(line.line)
        owed.append(lines[at + 4])
    assert owed == ["$75.00", "$325.00", "$43.00"]
    cents = sum(int(re.sub(r"[$,.]", "", amount)) for amount in owed)
    assert cents == RIVERBEND_BILL.amount_cents
    assert f"Amount due by 10/20/2026: {money(RIVERBEND_BILL.amount_cents)}" in text


def test_lines_that_do_not_add_up_are_refused(tmp_path):
    from dataclasses import replace

    with pytest.raises(ValueError):
        write_bill_pdf(PERSONAS["rowan-mi"], replace(RIVERBEND_BILL, amount_cents=500_00), tmp_path / "bad.pdf")


def test_money_format():
    assert money(443_00) == "$443.00"
    assert money(1_180_00) == "$1,180.00"
    assert money(5) == "$0.05"
