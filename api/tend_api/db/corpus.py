"""Turn rules/verified and rules/ir into the rows of the public corpus tables. Pure: no database here."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# rules/SCHEMA.md, the category table. `decides` marks the categories the law engine decides with;
# the rest are shown as information.
CATEGORIES: dict[str, tuple[str, bool]] = {
    "exam_no_bill": ("survivor may not be billed for a sexual assault forensic exam", True),
    "exam_payment": ("who pays for the exam (state fund, program, county)", True),
    "total_cap": ("maximum total award", True),
    "expense_cap": ("cap on one expense type", True),
    "covered_expense": ("an expense type is reimbursable", True),
    "excluded_expense": ("an expense type is not reimbursable", True),
    "filing_deadline": ("time limit to apply", True),
    "reporting_requirement": ("police report rules", True),
    "minimum_loss": ("minimum out-of-pocket loss to qualify", True),
    "collateral_source": ("program pays after insurance and other sources", True),
    "conduct_reduction": ("award may be reduced for the victim's conduct (information only; Tend never screens on it)", False),
    "emergency_award": ("emergency or advance award exists", False),
    "eligible_crime": ("sexual assault (or similar) is a covered crime", False),
    "residency": ("who can apply (residents, crimes in state, out-of-state victims)", False),
    "submission": ("how to file: one rule per method", False),
    "required_document": ("a document the program asks applicants to include or provide", False),
    "processing_time": ("stated time for a decision or payment", False),
    "address_confidentiality": ("the state's address confidentiality program", False),
    "record_confidentiality": ("the compensation program's records or claims are confidential by law", False),
}

_STATE = re.compile(r"^[A-Z]{2}$")


@dataclass(frozen=True)
class CorpusBundle:
    """One jurisdiction as it goes into the database: the verified file, its IR, and any compiled images."""

    st: str
    verified: dict[str, Any]
    verified_sha256: str
    ir: dict[str, Any] | None = None
    ir_sha256: str | None = None
    images: tuple[dict[str, Any], ...] = field(default_factory=tuple)

    @property
    def key(self) -> dict[str, str | None]:
        return {"verified_sha256": self.verified_sha256, "ir_sha256": self.ir_sha256}


ImageFn = Callable[[str], list[dict[str, Any]]]


def state_codes(rules_dir: Path) -> list[str]:
    return sorted(p.stem for p in rules_dir.glob("*.json") if _STATE.match(p.stem))


def read_bundle(rules_dir: Path, ir_dir: Path | None, st: str, images: ImageFn | None = None) -> CorpusBundle:
    raw = (rules_dir / f"{st}.json").read_bytes()
    verified = json.loads(raw)
    ir_doc, ir_sha = None, None
    ir_path = ir_dir / f"{st}.json" if ir_dir else None
    if ir_path is not None and ir_path.is_file():
        ir_raw = ir_path.read_bytes()
        ir_doc, ir_sha = json.loads(ir_raw), hashlib.sha256(ir_raw).hexdigest()
    bundle = CorpusBundle(st, verified, hashlib.sha256(raw).hexdigest(), ir_doc, ir_sha)
    if images is not None:
        bundle = CorpusBundle(st, verified, bundle.verified_sha256, ir_doc, ir_sha, tuple(images(st)))
    return bundle


def read_bundles(
    rules_dir: Path, ir_dir: Path | None, states: Iterable[str] | None = None, images: ImageFn | None = None
) -> list[CorpusBundle]:
    codes = [s.upper() for s in states] if states else state_codes(rules_dir)
    return [read_bundle(rules_dir, ir_dir, st, images) for st in codes]


def rule_expense(rule: dict[str, Any]) -> str | None:
    value = rule.get("expense") or (rule.get("params") or {}).get("expense")
    return value if isinstance(value, str) else None


def words(value: str | None) -> str:
    return (value or "").replace("_", " ")


def heading(rule: dict[str, Any], ir_rule: dict[str, Any] | None) -> str:
    parts = [words(rule.get("category")), words(rule_expense(rule))]
    if ir_rule:
        parts += [words(t) for t in ir_rule.get("tags") or []]
        parts.append(words(ir_rule.get("unit")))
    return " ".join(p for p in parts if p)


def jurisdiction_row(b: CorpusBundle) -> dict[str, Any]:
    doc = b.verified
    skipped = (b.ir or {}).get("skipped") or []
    return {
        "st": b.st,
        "name": doc.get("name") or b.st,
        "program": doc.get("program") or {},
        "coverage": doc.get("coverage"),
        "confidence": doc.get("confidence"),
        "verified_sha256": b.verified_sha256,
        "ir_sha256": b.ir_sha256,
        "ir_version": (b.ir or {}).get("ir_version"),
        "rule_count": len(doc.get("rules") or []),
        "source_count": len(doc.get("sources") or []),
        "skipped_count": len(skipped),
    }


def source_rows(b: CorpusBundle) -> list[dict[str, Any]]:
    return [
        {
            "st": b.st,
            "id": s["id"],
            "title": s.get("title") or s["id"],
            "url": s.get("url") or "",
            "kind": s.get("kind") or "",
            "retrieved_at": s.get("retrieved_at"),
            "raw_path": s.get("raw_path"),
            "text_path": s.get("text_path"),
            "sha256": s["sha256"],
        }
        for s in b.verified.get("sources") or []
    ]


def rule_rows(b: CorpusBundle) -> list[dict[str, Any]]:
    ir_rules = {r["id"]: r for r in (b.ir or {}).get("rules") or []}
    skipped = {s["id"]: s.get("reason") for s in (b.ir or {}).get("skipped") or []}
    rows = []
    for ord_, rule in enumerate(b.verified.get("rules") or []):
        ir_rule = ir_rules.get(rule["id"])
        kind = ir_rule["kind"] if ir_rule else ("skipped" if rule["id"] in skipped else None)
        rows.append(
            {
                "st": b.st,
                "id": rule["id"],
                "ord": ord_,
                "category": rule["category"],
                "expense": rule_expense(rule),
                "params": rule.get("params") or {},
                "summary": rule.get("summary") or "",
                "quote": rule.get("quote") or "",
                "pinpoint": rule.get("pinpoint") or "",
                "source_id": rule["source_id"],
                "fragment_url": rule.get("fragment_url"),
                "ir": ir_rule,
                "ir_kind": kind,
                "skipped_reason": skipped.get(rule["id"]),
                "heading": heading(rule, ir_rule),
            }
        )
    return rows


def image_rows(b: CorpusBundle) -> list[dict[str, Any]]:
    return [{"st": b.st, "verified_sha256": b.verified_sha256, "ir_sha256": b.ir_sha256, **img} for img in b.images]


def corpus_sha256(hashes: dict[str, dict[str, str | None]]) -> str:
    """The identity of a whole corpus: sha256 of the sorted [st, verified sha256, IR sha256] list. The same
    files give the same hash whether they are read from disk, from git, or from a database's jurisdictions table."""
    listing = [[st, hashes[st].get("verified_sha256"), hashes[st].get("ir_sha256")] for st in sorted(hashes)]
    return hashlib.sha256(json.dumps(listing, separators=(",", ":")).encode("utf-8")).hexdigest()


def bundle_hashes(bundles: Iterable[CorpusBundle]) -> dict[str, dict[str, str | None]]:
    return {b.st: b.key for b in bundles}
