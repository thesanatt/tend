from __future__ import annotations

import datetime as dt
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    field_validator,
    model_validator,
)

EXPENSES = (
    "medical",
    "forensic_exam",
    "counseling",
    "lost_wages",
    "transportation",
    "relocation",
    "temporary_housing",
    "security",
    "crime_scene_cleanup",
    "childcare",
    "property_replacement",
    "clothing_bedding",
    "prescription",
    "dental",
    "funeral",
    "legal",
    "tuition",
    "other",
)
Expense = Literal[
    "medical",
    "forensic_exam",
    "counseling",
    "lost_wages",
    "transportation",
    "relocation",
    "temporary_housing",
    "security",
    "crime_scene_cleanup",
    "childcare",
    "property_replacement",
    "clothing_bedding",
    "prescription",
    "dental",
    "funeral",
    "legal",
    "tuition",
    "other",
    "unknown",
]
PoliceReport = Literal["yes", "no", "unknown"]

MAX_CENTS = 100_000_000_00  # $100M; anything larger is a data error, not a claim
Cents = Annotated[int, Field(strict=True, ge=0, le=MAX_CENTS)]
PositiveCents = Annotated[int, Field(strict=True, gt=0, le=MAX_CENTS)]
StateCode = Annotated[str, Field(pattern=r"^[A-Z]{2}$")]
ItemId = Annotated[str, Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9][A-Za-z0-9:._\-]*$")]
Slug = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9_\-]*$")]


def _upper_state(value: object) -> object:
    return value.strip().upper() if isinstance(value, str) else value


def _printable(value: str) -> str:
    return "".join(ch for ch in value if ch.isprintable()).strip()


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Context(Strict):
    incident_date: dt.date
    as_of_date: dt.date
    police_report: PoliceReport = "unknown"
    forensic_exam: StrictBool = False


class Item(Strict):
    item_id: ItemId
    date: dt.date
    amount_cents: Cents
    expense: Expense
    confirmed: StrictBool = False
    insurance_paid_cents: Cents = 0
    is_bill: StrictBool = False
    units: Annotated[int, Field(strict=True, ge=0, le=100_000)] = 0
    description: Annotated[str, Field(max_length=200)] = ""

    @field_validator("description")
    @classmethod
    def _clean_description(cls, v: str) -> str:
        return _printable(v)


class ClaimInput(Strict):
    jurisdiction: StateCode
    context: Context
    items: Annotated[list[Item], Field(max_length=5000)]

    @field_validator("jurisdiction", mode="before")
    @classmethod
    def _upper(cls, v: object) -> object:
        return _upper_state(v)

    @model_validator(mode="after")
    def _unique_ids(self) -> ClaimInput:
        seen: set[str] = set()
        for item in self.items:
            if item.item_id in seen:
                raise ValueError(f"duplicate item_id {item.item_id}")
            seen.add(item.item_id)
        return self


class ScanRequest(Strict):
    persona_id: Slug | None = None
    customer_id: Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9\-]+$")] | None = None
    st: StateCode
    incident_date: dt.date | None = None

    @field_validator("st", mode="before")
    @classmethod
    def _upper(cls, v: object) -> object:
        return _upper_state(v)

    @model_validator(mode="after")
    def _one_source(self) -> ScanRequest:
        if (self.persona_id is None) == (self.customer_id is None):
            raise ValueError("send exactly one of persona_id or customer_id")
        return self


class BillAuditRequest(Strict):
    st: StateCode
    bill_id: Slug | None = None
    persona_id: Slug | None = None
    bill_text: Annotated[str, Field(max_length=20_000)] | None = None
    scan_id: Slug | None = None
    incident_date: dt.date | None = None
    as_of_date: dt.date | None = None
    police_report: PoliceReport | None = None

    @field_validator("st", mode="before")
    @classmethod
    def _upper(cls, v: object) -> object:
        return _upper_state(v)

    @model_validator(mode="after")
    def _has_bill(self) -> BillAuditRequest:
        if not (self.bill_id or self.persona_id or self.bill_text):
            raise ValueError("send bill_id, persona_id, or bill_text")
        return self


class ProposeRequest(Strict):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    from_account: Annotated[str, Field(alias="from", min_length=1, max_length=64, pattern=r"^[A-Za-z0-9\-_]+$")]
    payee: Annotated[str, Field(min_length=1, max_length=80)]
    amount_cents: PositiveCents
    claim_id: Slug | None = None
    item_id: ItemId | None = None
    dry_run: StrictBool | None = None

    @field_validator("payee")
    @classmethod
    def _payee(cls, v: str) -> str:
        cleaned = _printable(v)
        if not cleaned:
            raise ValueError("payee is empty")
        return cleaned


class ConfirmRequest(Strict):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    action_id: Slug
    confirm_code: Annotated[str, Field(pattern=r"^\d{6}$")]
    amount_cents: PositiveCents | None = None
    from_account: Annotated[str | None, Field(alias="from", max_length=64)] = None
    payee: Annotated[str | None, Field(max_length=80)] = None


class ShareRequest(Strict):
    claim_id: Slug
    ttl_hours: Annotated[int, Field(strict=True, ge=1, le=168)] = 72
