from __future__ import annotations

import datetime as dt
import io
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .errors import TendError
from .money import MONEY_TOKEN, dollars_match_cents, parse_cents, sha256_hex

BILL_DIRS = ("bills", "fixtures", "documents", "")
BILL_EXTS = (".json", ".pdf", ".txt")

# A bill row: optional line number, a date, a description, then one or more money columns ending the line.
_ROW_START = re.compile(r"^\s*(?:\d{1,3}\s+)?(?:(?P<y>\d{4})-(?P<m>\d{2})-(?P<d>\d{2})|(?P<m2>\d{1,2})/(?P<d2>\d{1,2})/(?P<y2>\d{2,4}))\b")
_TRAILING_AMOUNT = re.compile(rf"(?:{MONEY_TOKEN.pattern})\s*$")
_META = re.compile(
    r"(?:^|\s{2,})(?P<key>provider|facility|statement date|bill id|account number|account)\s*[:#]\s*(?P<value>\S.*?)\s*$", re.I
)
_FICTIONAL = re.compile(r"\bfictional\b|\bnot a real\b", re.I)
_BANNER = re.compile(r"^\W*fictional demo|\bnot a real\b", re.I)  # a whole line about the document, never the provider name
_DUE = re.compile(r"amount due|balance due|total due|you owe|patient responsibility|please pay", re.I)
_TOTAL = re.compile(r"\btotals?\b", re.I)
_ADJUSTMENT = re.compile(r"insurance|payment|paid|adjust|discount|credit|write.?off", re.I)

# First match wins. Hospital pharmacy and supply charges are medical care on a hospital bill.
EXPENSE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "forensic_exam",
        re.compile(r"forensic|sexual assault (?:medical )?exam|\bSANE\b|\bSAFE\b exam|evidence (?:collection|kit)|rape kit", re.I),
    ),
    ("counseling", re.compile(r"counsel|therap|psych|behavioral health", re.I)),
    ("dental", re.compile(r"dental|dentist|\btooth\b|\bteeth\b", re.I)),
    (
        "medical",
        re.compile(
            r"emergency|\bE[DR]\b|visit|physician|laborator|\blab\b|labs\b|x-?ray|imaging|radiolog|\bCT\b|\bMRI\b|urgent care|triage"
            r"|facility|clinic|nurs|exam|treatment|injection|suppl|ambulance|pharmacy|medication|prophyla|\bsuture",
            re.I,
        ),
    ),
)
INSURANCE_MENTION = re.compile(r"insurance|insurer|deductible|co-?pay|coinsurance|\bEOB\b", re.I)


class BillRefused(TendError):
    def __init__(self, message: str, detail: dict[str, Any] | None = None, status_code: int = 422):
        super().__init__(message, status_code, {"message": message, **(detail or {})})


@dataclass
class BillLine:
    line_no: int
    date: dt.date
    description: str
    amount_cents: int  # what the patient owes on this line: the last money column
    columns_cents: list[int] = field(default_factory=list)
    item_id: str = ""
    expense: str = "unknown"
    match: str | None = None


@dataclass
class Bill:
    sha256: str
    format: str
    lines: list[BillLine]
    provider: str | None = None
    statement_date: str | None = None
    bill_id: str | None = None
    fictional: bool = False
    nessie_bill_id: str | None = None
    total_cents: int | None = None
    amount_due_cents: int | None = None
    adjustments: list[dict[str, Any]] = field(default_factory=list)

    @property
    def lines_sum_cents(self) -> int:
        return sum(line.amount_cents for line in self.lines)

    @property
    def due_cents(self) -> int | None:
        return self.amount_due_cents if self.amount_due_cents is not None else self.total_cents


@dataclass
class BillSource:
    raw: bytes
    format: str
    document: dict[str, Any] | None = None  # the persona snapshot's record of this file, when it has one


def match_expense(description: str) -> tuple[str, str | None]:
    for expense, pattern in EXPENSE_PATTERNS:
        m = pattern.search(description)
        if m:
            return expense, m.group(0)
    return "unknown", None


def _parse_date(m: re.Match[str]) -> dt.date:
    if m.group("y"):
        return dt.date(int(m.group("y")), int(m.group("m")), int(m.group("d")))
    year = int(m.group("y2"))
    year = year + 2000 if year < 100 else year
    return dt.date(year, int(m.group("m2")), int(m.group("d2")))


def parse_text_bill(text: str, sha256: str, fmt: str = "text") -> Bill:
    bill = Bill(sha256=sha256, format=fmt, lines=[])
    title: str | None = None
    totals: list[int] = []
    dues: list[int] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if _FICTIONAL.search(line):
            bill.fictional = True
        amounts = list(MONEY_TOKEN.finditer(line)) if _TRAILING_AMOUNT.search(line) else []
        if not amounts:
            meta = _META.search(line)
            if meta:
                key, value = meta.group("key").lower(), meta.group("value")
                if key in ("provider", "facility"):
                    bill.provider = value
                elif key == "statement date":
                    bill.statement_date = value
                elif key == "bill id":
                    bill.bill_id = value
            elif title is None and not _BANNER.search(line):
                title = re.split(r"\s{2,}", line)[0]
            continue
        row = _ROW_START.match(line)
        if row and amounts[0].start() > row.end():
            try:
                when = _parse_date(row)
            except ValueError as exc:
                raise BillRefused(f"bad date on bill line: {line!r}") from exc
            description = re.sub(r"\s{2,}", " ", line[row.end() : amounts[0].start()]).strip(" .\t-")
            columns = [parse_cents(a.group(0)) for a in amounts]
            if columns[-1] < 0:  # a dated credit, e.g. a payment received, reduces what is due
                bill.adjustments.append({"label": description, "amount_cents": -columns[-1]})
                continue
            bill.lines.append(BillLine(len(bill.lines) + 1, when, description, columns[-1], columns))
            continue
        label = line[: amounts[0].start()].strip(" .:\t")
        cents = parse_cents(amounts[-1].group(0))
        if _DUE.search(label):
            dues.append(cents)
        elif _TOTAL.search(label):
            totals.append(cents)
        elif _ADJUSTMENT.search(label):
            bill.adjustments.append({"label": label, "amount_cents": abs(cents)})
    bill.provider = bill.provider or title
    bill.total_cents = totals[-1] if totals else None
    bill.amount_due_cents = dues[-1] if dues else None
    return bill


def parse_json_bill(data: dict[str, Any], sha256: str) -> Bill:
    raw_lines = data.get("lines") or data.get("items") or []
    lines = []
    for i, raw in enumerate(raw_lines, start=1):
        cents = raw.get("amount_cents")
        if isinstance(cents, bool) or not isinstance(cents, int):
            raise BillRefused(f"bill line {i} amount_cents must be integer cents")
        lines.append(BillLine(i, dt.date.fromisoformat(raw["date"]), str(raw.get("description", "")), cents, [cents]))
    for key in ("total_cents", "amount_due_cents"):
        value = data.get(key)
        if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
            raise BillRefused(f"{key} must be integer cents")
    return Bill(
        sha256=sha256,
        format="json",
        lines=lines,
        provider=data.get("provider"),
        statement_date=data.get("statement_date"),
        bill_id=data.get("bill_id"),
        fictional=bool(data.get("fictional", False)),
        nessie_bill_id=data.get("nessie_bill_id"),
        total_cents=data.get("total_cents"),
        amount_due_cents=data.get("amount_due_cents"),
        adjustments=[{"label": a.get("label", ""), "amount_cents": abs(int(a["amount_cents"]))} for a in data.get("adjustments") or []],
    )


def pdf_text(raw: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(raw))
    return "\n".join(page.extract_text(extraction_mode="layout") or "" for page in reader.pages)


def extract_bill(raw: bytes, fmt: str) -> Bill:
    digest = sha256_hex(raw)
    if fmt == "json":
        bill = parse_json_bill(json.loads(raw), digest)
    elif fmt == "pdf":
        bill = parse_text_bill(pdf_text(raw), digest, "pdf")
    else:
        bill = parse_text_bill(raw.decode("utf-8", errors="replace"), digest, "text")
    if not bill.lines:
        raise BillRefused("No itemized lines were found on this bill.")
    for line in bill.lines:
        line.item_id = f"bill:{digest[:16]}:{line.line_no}"
        line.expense, line.match = match_expense(line.description)
    return bill


def balance_checks(bill: Bill) -> list[dict[str, Any]]:
    """The lines must add up to the bill's own total. Any mismatch refuses the whole audit."""
    lines_sum = bill.lines_sum_cents
    adjustments = sum(a["amount_cents"] for a in bill.adjustments)
    checks = []
    if bill.total_cents is not None:
        checks.append(
            {
                "name": "lines_equal_total",
                "ok": lines_sum == bill.total_cents,
                "lines_sum_cents": lines_sum,
                "total_cents": bill.total_cents,
            }
        )
        if bill.amount_due_cents is not None:
            checks.append(
                {
                    "name": "total_less_adjustments_equals_due",
                    "ok": bill.total_cents - adjustments == bill.amount_due_cents,
                    "total_cents": bill.total_cents,
                    "adjustments_cents": adjustments,
                    "amount_due_cents": bill.amount_due_cents,
                }
            )
    elif bill.amount_due_cents is not None:
        checks.append(
            {
                "name": "lines_less_adjustments_equal_due",
                "ok": lines_sum - adjustments == bill.amount_due_cents,
                "lines_sum_cents": lines_sum,
                "adjustments_cents": adjustments,
                "amount_due_cents": bill.amount_due_cents,
            }
        )
    else:
        raise BillRefused("This bill does not state a total, so its lines cannot be checked.", {"lines_sum_cents": lines_sum})
    if not all(c["ok"] for c in checks):
        raise BillRefused("The bill's lines do not add up to its total, so Tend will not audit it.", {"checks": checks})
    return checks


def document_check(bill: Bill, document: dict[str, Any]) -> dict[str, Any]:
    """The file must be the exact one the persona snapshot recorded, with the same total."""
    expected = document.get("sha256")
    total = document.get("total_cents")
    ok = (expected is None or expected == bill.sha256) and (total is None or total == bill.due_cents)
    return {
        "name": "matches_snapshot_document",
        "ok": ok,
        "sha256": bill.sha256,
        "expected_sha256": expected,
        "expected_total_cents": total,
    }


def nessie_bill_check(bill: Bill, snapshot: dict[str, Any] | None) -> dict[str, Any] | None:
    if not bill.nessie_bill_id or not snapshot:
        return None
    record = next((b for b in snapshot.get("bills") or [] if bill.nessie_bill_id in (b.get("id"), b.get("_id"))), None)
    if record is None:
        return {"name": "matches_nessie_bill", "ok": False, "nessie_bill_id": bill.nessie_bill_id, "reason": "bill not in snapshot"}
    due = bill.due_cents
    for key in ("amount_cents", "payment_amount_cents"):
        if key in record:
            ok = due is not None and record[key] == due and not isinstance(record[key], bool)
            return {"name": "matches_nessie_bill", "ok": ok, "nessie_bill_id": bill.nessie_bill_id}
    ok = due is not None and dollars_match_cents(record.get("payment_amount"), due)
    return {"name": "matches_nessie_bill", "ok": ok, "nessie_bill_id": bill.nessie_bill_id}


def snapshot_documents(snapshot: dict[str, Any] | None) -> list[dict[str, Any]]:
    snapshot = snapshot or {}
    docs = list((snapshot.get("meta") or {}).get("documents") or snapshot.get("documents") or [])
    legacy = snapshot.get("itemized_bill")
    if isinstance(legacy, str):
        docs.append({"kind": "itemized_bill", "path": legacy})
    return [d for d in docs if isinstance(d, dict) and d.get("kind", "itemized_bill") == "itemized_bill"]


def find_bill(seed_dir: Path, bill_id: str | None, persona_id: str | None, snapshot: dict[str, Any] | None) -> BillSource:
    """An explicit bill_id wins, then the persona's own itemized bill, then a bill file named after the persona."""
    if bill_id:
        found = _find_named(seed_dir, bill_id)
        if found is None:
            raise BillRefused(f"No itemized bill named {bill_id!r} under {seed_dir}.", status_code=404)
        return found
    inline = (snapshot or {}).get("itemized_bill")
    if isinstance(inline, dict):
        return BillSource(json.dumps(inline).encode("utf-8"), "json")
    for doc in snapshot_documents(snapshot):
        path = _resolve_inside(seed_dir, str(doc.get("path", "")))
        if path is not None:
            return BillSource(path.read_bytes(), _format_of(path), doc)
    if persona_id:
        for prefix in (persona_id, persona_id.split("-")[0]):
            for sub in BILL_DIRS[:3]:
                matches = sorted(p for p in (seed_dir / sub).glob(f"{prefix}*") if p.suffix in BILL_EXTS and p.is_file())
                if matches:
                    return BillSource(matches[0].read_bytes(), _format_of(matches[0]))
    raise BillRefused(f"No itemized bill found for {persona_id!r} under {seed_dir}.", status_code=404)


def _resolve_inside(seed_dir: Path, ref: str) -> Path | None:
    # Snapshot paths may be relative to seed/ or to the repo root ("seed/bills/x.pdf"); never leave seed_dir.
    if not ref:
        return None
    root = seed_dir.resolve()
    for candidate in (seed_dir / ref, seed_dir.parent / ref, seed_dir / "bills" / Path(ref).name):
        path = candidate.resolve()
        if path.is_file() and root in path.parents:
            return path
    return None


def _find_named(seed_dir: Path, name: str) -> BillSource | None:
    for sub in BILL_DIRS:
        for ext in BILL_EXTS:
            path = seed_dir / sub / f"{name}{ext}"
            if path.is_file():
                return BillSource(path.read_bytes(), _format_of(path))
    return None


def _format_of(path: Path) -> str:
    return {".json": "json", ".pdf": "pdf"}.get(path.suffix.lower(), "text")
