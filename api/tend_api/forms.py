from __future__ import annotations

import datetime as dt
import io
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .errors import TendError
from .money import format_cents

# Never filled, whatever a spec says: the survivor writes these or nobody does.
FORBIDDEN = re.compile(
    r"signature|social security|\bssn\b|offender|date of crime|crime was reported|describe the crime|location of crime"
    r"|county in which|incident number|law enforcement|court|type of crime|restitution|civil|settlement",
    re.I,
)


class FormGuardError(TendError):
    status_code = 500


@dataclass(frozen=True)
class FormSpec:
    name_fields: tuple[str, ...]
    expense_checkboxes: dict[str, str]
    summary_field: str | None
    never: frozenset[str] = field(default_factory=frozenset)
    only_you: tuple[str, ...] = ()

    @property
    def allowlist(self) -> frozenset[str]:
        names = set(self.name_fields) | set(self.expense_checkboxes.values())
        if self.summary_field:
            names.add(self.summary_field)
        return frozenset(names)


# Michigan DCH-0560 (Rev. 1-26), 202 AcroForm fields. Field names copied from the PDF.
MI = FormSpec(
    name_fields=(
        "1 Name of Victim",
        # The "(name of victim)" blank in the release authorization on page 4.
        "rendered services any employer any police or other local government agency including State and",
    ),
    expense_checkboxes={
        "medical": "Medical Expenses",
        "prescription": "Medical Expenses",
        "dental": "Dental Expenses",
        "counseling": "Psychological Counseling",
        "lost_wages": "Loss of Earnings",
        "temporary_housing": "Relocation Temporary",
        "relocation": "Relocation Permanent",
        "security": "Residential Security",
        "transportation": "Transportation",
        "crime_scene_cleanup": "Crime Scene Cleanup",
        "funeral": "Funeral and Burial Expenses",
    },
    summary_field="SECTION 6  Compensation Benefits",
    never=frozenset(
        {
            "3 Social Security Number",
            "12 Social Security Number",
            "Claimant Signature",
            "Date of Signature",
            "Claimants Signature",
            "Date of Signature_2",
            "expire one year from the signature date below if you leave this section blank",
            "27 Date of Crime",
            "28 Date Crime was Reported",
            "29 Law enforcement agency to which crime was reported",
            "30 County in which Crime Occurred",
            "31 Location of Crime",
            "32 Incident Number",
            "33 Briefly describe the crime and injuries that resulted from this crime",
            "34 If the crime was NOT reported to law enforcement explain why",
            "35 If you are NOT filing this claim within five years of the date of crime explain delay waivers may apply",
            "36 Name of Offenders if known",
            "38 Name of Court and Case Number",
            "undefined_3",
            "the victim an individual with whom the victim had a child in common or a resident or former resident",
            "Sexual Assault",
            "Assault",
            "Child Sexual Assault",
            "Human Trafficking",
            "Stalking",
            "Other_5",
        }
    ),
    only_you=(
        "What happened, where, and when (questions 25 to 35)",
        "Anything about the person who did it (questions 26 and 36 to 42)",
        "Your Social Security number (questions 3 and 12)",
        "Your signatures and the dates you sign",
    ),
)

FORM_SPECS: dict[str, FormSpec] = {"MI": MI}


def application_path(forms_dir: Path, st: str) -> Path:
    return forms_dir / st / "application.pdf"


def application_values(spec: FormSpec, view: dict[str, Any]) -> dict[str, str]:
    values: dict[str, str] = {}
    name = view.get("display_name") if view.get("fictional") else None
    if name:
        for field_name in spec.name_fields:
            values[field_name] = name
    eligible = [ln for ln in view["lines"] if ln.get("status") == "eligible" and (ln.get("allowed_cents") or 0) > 0]
    for ln in eligible:
        box = spec.expense_checkboxes.get(ln.get("expense", ""))
        if box:
            values[box] = "/On"
    if spec.summary_field and eligible:
        dates = sorted(dt.date.fromisoformat(ln["date"]) for ln in eligible if ln.get("date"))
        total = sum(ln["allowed_cents"] for ln in eligible)
        span = f"{dates[0]:%m/%d/%Y} to {dates[-1]:%m/%d/%Y}" if dates else "see list"
        noun = "expense" if len(eligible) == 1 else "expenses"
        values[spec.summary_field] = f"Itemized list attached: {len(eligible)} {noun}, {span}, {format_cents(total)}"
    guard(spec, values)
    return values


def guard(spec: FormSpec, names: dict[str, Any] | set[str]) -> None:
    names = set(names)
    outside = names - spec.allowlist
    never = names & spec.never
    forbidden = {n for n in names if FORBIDDEN.search(n)}
    if outside or never or forbidden:
        raise FormGuardError(f"refusing to fill fields outside the allowlist: {sorted(outside | never | forbidden)}")


def filled_fields(pdf: bytes) -> dict[str, str]:
    from pypdf import PdfReader

    fields = PdfReader(io.BytesIO(pdf)).get_fields() or {}
    return {name: str(f.get("/V")) for name, f in fields.items() if f.get("/V") not in (None, "", "/Off")}


def fill_application(forms_dir: Path, st: str, view: dict[str, Any]) -> bytes | None:
    spec = FORM_SPECS.get(st)
    path = application_path(forms_dir, st)
    if spec is None or not path.is_file():
        return None
    from pypdf import PdfReader, PdfWriter

    values = application_values(spec, view)
    writer = PdfWriter(clone_from=PdfReader(path))
    if values:
        writer.update_page_form_field_values(None, values, auto_regenerate=False)
    writer.set_need_appearances_writer(True)
    buf = io.BytesIO()
    writer.write(buf)
    data = buf.getvalue()
    guard(spec, set(filled_fields(data)))  # check what actually landed in the file, not just what was asked
    return data
