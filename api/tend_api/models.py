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
Unit = Literal["session", "week", "hour", "mile", "day", "month", "item"]  # SPEC v1.2 typed units
PoliceReport = Literal["yes", "no", "unknown"]

MAX_CENTS = 100_000_000_00  # $100M; anything larger is a data error, not a claim
Cents = Annotated[int, Field(strict=True, ge=0, le=MAX_CENTS)]
PositiveCents = Annotated[int, Field(strict=True, gt=0, le=MAX_CENTS)]
StateCode = Annotated[str, Field(pattern=r"^[A-Z]{2}$")]
ItemId = Annotated[str, Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9][A-Za-z0-9:._\-]*$")]
Slug = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9_\-]*$")]
AccountId = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9\-_]+$")]
ActionId = Annotated[str, Field(pattern=r"^act_[0-9a-f]{20}$")]
ConfirmCode = Annotated[str, Field(pattern=r"^[0-9]{6}$")]
# Display fields of a ClassifiedItem (web/lib/contracts.ts). The engine never reads them, so a
# claim may carry them and they are dropped before evaluation.
CLASSIFIED_EXTRAS = ("source", "reason", "confidence")


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
    unit: Unit | None = None
    description: Annotated[str, Field(max_length=200)] = ""
    tags: Annotated[list[Annotated[str, Field(pattern=r"^[a-z][a-z_]{0,31}$")]], Field(max_length=8)] = []  # e.g. ["phone"]

    @model_validator(mode="before")
    @classmethod
    def _drop_display_fields(cls, data: Any) -> Any:
        if isinstance(data, dict) and any(k in data for k in CLASSIFIED_EXTRAS):
            return {k: v for k, v in data.items() if k not in CLASSIFIED_EXTRAS}
        return data

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
    """A demo persona's itemized bill, which the server already holds (seed/bills)."""

    persona_id: Slug | None = None
    bill_id: Slug | None = None
    st: StateCode | None = None  # defaults to the persona's jurisdiction
    incident_date: dt.date | None = None
    as_of_date: dt.date | None = None
    police_report: PoliceReport | None = None

    @field_validator("st", mode="before")
    @classmethod
    def _upper(cls, v: object) -> object:
        return _upper_state(v)

    @model_validator(mode="after")
    def _has_bill(self) -> BillAuditRequest:
        if not (self.bill_id or self.persona_id):
            raise ValueError("send bill_id or persona_id")
        return self


def _clean_payee(v: str) -> str:
    cleaned = _printable(v)
    if not cleaned:
        raise ValueError("payee is empty")
    return cleaned


class ProposeRequest(Strict):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    from_account: Annotated[AccountId, Field(validation_alias=AliasChoices("from", "from_account_id", "from_account"))]
    payee: Annotated[str, Field(min_length=1, max_length=80)]
    amount_cents: PositiveCents
    kind: Literal["pay_bill", "payment"] | None = None
    bill_id: Slug | None = None  # the Nessie bill being paid
    item_ids: Annotated[list[ItemId], Field(max_length=200)] | None = None  # the bill lines this pays
    dry_run: StrictBool | None = None

    @field_validator("payee")
    @classmethod
    def _payee(cls, v: str) -> str:
        return _clean_payee(v)

    @model_validator(mode="after")
    def _bill_lines(self) -> ProposeRequest:
        if self.kind == "pay_bill" and not self.bill_id:
            raise ValueError("pay_bill needs bill_id: the bill being paid")
        if self.item_ids and not self.bill_id:
            raise ValueError("item_ids name lines of a bill, so bill_id is needed too")
        return self


class ConfirmRequest(Strict):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    action_id: ActionId
    confirm_code: ConfirmCode
    amount_cents: PositiveCents | None = None
    from_account: Annotated[str | None, Field(alias="from", max_length=64)] = None
    payee: Annotated[str | None, Field(max_length=80)] = None


BASE64 = r"^[A-Za-z0-9+/_\-]+={0,2}$"
# 2 MiB of ciphertext is 2,796,203 base64 characters; the service checks the decoded size exactly.
MAX_SHARE_B64 = 2_796_204


class ShareCreate(Strict):
    """A packet sealed in the browser: ciphertext and IV only (docs/PRIVACY.md). Never a key."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    ciphertext: Annotated[str, Field(min_length=16, max_length=MAX_SHARE_B64, pattern=BASE64)]
    iv: Annotated[str, Field(min_length=16, max_length=44, pattern=BASE64, validation_alias=AliasChoices("iv", "nonce"))]
    expires_hours: Annotated[int, Field(strict=True, ge=1, le=168, validation_alias=AliasChoices("expires_hours", "ttl_hours"))] = 72
    once: Annotated[StrictBool, Field(validation_alias=AliasChoices("once", "open_once"))] = False
    alg: Literal["AES-256-GCM"] = "AES-256-GCM"


class AiTxn(Strict):
    """One statement line offered to cloud AI. The model sees the merchant and description, never the amount."""

    id: ItemId
    description: Annotated[str, Field(max_length=200)] = ""
    merchant: Annotated[str, Field(max_length=120)] | None = None
    category: Annotated[str, Field(max_length=80)] | None = None  # the merchant's category, when the bank gives one
    date: dt.date | None = None
    amount_cents: Annotated[int, Field(strict=True, ge=-MAX_CENTS, le=MAX_CENTS)] | None = None
    kind: Literal["purchase", "withdrawal", "deposit", "transfer", "bill"] | None = None
    origin: Literal["csv", "ofx", "pdf", "nessie"] | None = None
    tend_action: Annotated[str, Field(max_length=40)] | None = None  # set by the relay on a payment Tend made


class AiClassifyRequest(Strict):
    consent: StrictBool
    st: StateCode | None = None
    incident_date: dt.date | None = None
    txns: Annotated[list[AiTxn], Field(min_length=1, max_length=500, validation_alias=AliasChoices("txns", "transactions"))]

    @field_validator("st", mode="before")
    @classmethod
    def _upper(cls, v: object) -> object:
        return _upper_state(v)


BillMime = Literal["application/pdf", "image/png", "image/jpeg", "image/webp", "image/heic", "text/plain"]
MAX_BILL_B64 = 14_000_000  # about 10 MB of file


class AiBillRequest(Strict):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    consent: StrictBool
    file: Annotated[
        str, Field(min_length=4, max_length=MAX_BILL_B64, pattern=BASE64, validation_alias=AliasChoices("file", "file_b64", "data"))
    ]
    mime: Annotated[BillMime, Field(validation_alias=AliasChoices("mime", "mime_type", "content_type"))]


class AgentAnswerRequest(Strict):
    question: Annotated[str, Field(min_length=2, max_length=500)]
    st: StateCode | None = None

    @field_validator("st", mode="before")
    @classmethod
    def _upper(cls, v: object) -> object:
        return _upper_state(v) or None


class AgentCheckRequest(Strict):
    st: StateCode
    incident_date: dt.date | None = None
    forensic_exam: StrictBool | None = None  # None: not sure
    police_report: Literal["yes", "no", "not_yet", "unknown"] = "unknown"

    @field_validator("st", mode="before")
    @classmethod
    def _upper(cls, v: object) -> object:
        return _upper_state(v)


class AgentPayRequest(Strict):
    """A payment the agent sets up. The survivor approves it by typing the amount back."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    persona_id: Slug | None = None  # demo persona whose account pays
    account: Literal["checking", "cushion"] = "checking"
    from_account: Annotated[AccountId | None, Field(validation_alias=AliasChoices("from", "from_account"))] = None
    payee: Annotated[str, Field(min_length=1, max_length=80)]
    amount_cents: PositiveCents
    bill_id: Slug | None = None
    item_ids: Annotated[list[ItemId], Field(max_length=200)] | None = None

    @field_validator("payee")
    @classmethod
    def _payee(cls, v: str) -> str:
        return _clean_payee(v)

    @model_validator(mode="after")
    def _one_account(self) -> AgentPayRequest:
        if (self.persona_id is None) == (self.from_account is None):
            raise ValueError("send persona_id (the demo persona whose account pays) or from (an account id)")
        if self.item_ids and not self.bill_id:
            raise ValueError("item_ids name lines of a bill, so bill_id is needed too")
        return self


class AgentConfirmRequest(Strict):
    action_id: ActionId
    confirm_code: ConfirmCode
    typed: Annotated[str, Field(min_length=1, max_length=64, description='what the survivor typed, e.g. "confirm 118.00"')]
