from __future__ import annotations

import datetime as dt
from typing import Annotated, Any, Literal

from pydantic import (
    AliasChoices,
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
    tags: Annotated[list[Annotated[str, Field(pattern=r"^[a-z][a-z_]{0,31}$")]], Field(max_length=8)] = []  # e.g. ["phone"], SPEC v1.1

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
    st: StateCode | None = None  # defaults to the persona's jurisdiction
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


AccountId = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9\-_]+$")]


class ProposeRequest(Strict):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    from_account: Annotated[AccountId, Field(validation_alias=AliasChoices("from", "from_account_id", "from_account"))]
    payee: Annotated[str, Field(min_length=1, max_length=80)]
    amount_cents: PositiveCents
    kind: Literal["pay_bill"] | None = None
    bill_id: Slug | None = None
    item_ids: Annotated[list[ItemId], Field(max_length=200)] | None = None  # the bill lines this pays; amounts must add up
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

    @model_validator(mode="after")
    def _bill_lines(self) -> ProposeRequest:
        if self.kind == "pay_bill" and not self.item_ids:
            raise ValueError("pay_bill needs item_ids: the bill lines this pays")
        return self


class ConfirmRequest(Strict):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    action_id: Slug
    confirm_code: Annotated[str, Field(pattern=r"^[0-9]{6}$")]
    amount_cents: PositiveCents | None = None
    from_account: Annotated[str | None, Field(alias="from", max_length=64)] = None
    payee: Annotated[str | None, Field(max_length=80)] = None


BASE64 = r"^[A-Za-z0-9+/_\-]+={0,2}$"


class ShareRequest(Strict):
    """One of: ciphertext sealed in the browser (docs/PRIVACY.md), a stored claim_id, or a claim
    computed on the device (input, which the server evaluates again)."""

    ciphertext: Annotated[str, Field(min_length=16, max_length=8_000_000, pattern=BASE64)] | None = None
    nonce: Annotated[str, Field(min_length=8, max_length=64, pattern=BASE64)] | None = None
    alg: Literal["AES-256-GCM"] = "AES-256-GCM"
    open_once: StrictBool = False
    claim_id: Slug | None = None
    input: ClaimInput | None = None
    output: dict[str, Any] | None = None
    ttl_hours: Annotated[int, Field(strict=True, ge=1, le=168)] = 72

    @model_validator(mode="after")
    def _one_kind(self) -> ShareRequest:
        if sum(x is not None for x in (self.ciphertext, self.claim_id, self.input)) != 1:
            raise ValueError("send ciphertext (with nonce), claim_id, or input")
        if (self.ciphertext is None) != (self.nonce is None):
            raise ValueError("ciphertext and nonce go together")
        if self.open_once and self.ciphertext is None:
            raise ValueError("open_once applies to sealed shares")
        return self


class AgentLinkRequest(Strict):
    claim_id: Slug


class AgentRedeemRequest(Strict):
    link_code: Annotated[str, Field(min_length=8, max_length=16)]


class AgentPayRequest(Strict):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    from_account: Annotated[str, Field(alias="from", min_length=1, max_length=64, pattern=r"^[A-Za-z0-9\-_]+$")]
    payee: Annotated[str, Field(min_length=1, max_length=80)]
    amount_cents: PositiveCents
    item_id: ItemId | None = None


class AgentConfirmRequest(Strict):
    action_id: Slug
    confirm_code: Annotated[str, Field(pattern=r"^[0-9]{6}$")]
    typed: Annotated[str, Field(min_length=1, max_length=64, description='what the survivor typed, e.g. "confirm 118.00"')]
