"""Law IR version 2 (rules/ir/ST.json), read the way tendc reads it.

The checks and their messages follow engine/src/compiler.cpp one for one, so an IR file either
loads in both engines or is refused by both with the same words. The verified file
(rules/verified/ST.json) is optional: it supplies quotes and pinpoints for display, and when it
is given its sha256 must match the IR's source_sha256, as in tendc.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

IR_VERSION = 2
KINDS = ("exam_no_bill", "exam_payment", "total_cap", "expense_cap", "covered", "excluded", "deadline",
         "reporting", "minimum_loss", "collateral", "info")
# rules/SCHEMA.md order; an item may also say "unknown", a rule never does.
RULE_EXPENSES = ("medical", "forensic_exam", "counseling", "lost_wages", "transportation", "relocation",
                 "temporary_housing", "security", "crime_scene_cleanup", "childcare", "property_replacement",
                 "clothing_bedding", "prescription", "dental", "funeral", "legal", "tuition", "other")
ITEM_EXPENSES = RULE_EXPENSES + ("unknown",)
UNITS = ("session", "week", "hour", "mile", "day", "month", "item")
ANCHORS = ("crime", "incident", "discovery", "injury", "offense", "report")
WAIVERS = ("none", "other", "discretionary", "automatic")

MAX_CENTS = 10**15  # $10 trillion
MAX_DAYS = 4_000_000
MAX_COUNT = 1_000_000
MAX_TAGS = 31  # item tags become bits of a 31-bit immediate in the image
MAX_TAG_EXCLUSIONS = 6  # per expense: the compiled switch has 2^n cases
MAX_RULES = 65535
INT64_MAX = 2**63 - 1
INT64_MIN = -(2**63)

_HEX64 = re.compile(r"[0-9a-fA-F]{64}")
_CODE = re.compile(r"[A-Z0-9]+")


class LawError(ValueError):
    """The IR (or its verified file) is one tendc would refuse; the message is tendc's."""


@dataclass
class Rule:
    """One IR rule, or one rule the front end set aside (kind "skipped")."""

    index: int
    id: str
    kind: str
    category: str = ""
    expense: str | None = None
    per: str | None = None  # "claim" or "unit" for expense caps
    unit: str | None = None  # per-unit caps
    cap: int | None = None  # cap_cents of caps and minimum loss
    count_limit: int | None = None
    alt_ids: list[str] = field(default_factory=list)
    tags: frozenset[str] = frozenset()
    days: int = 0  # deadlines
    anchor: str = "crime"  # deadlines: what the period is counted from
    required: bool = True  # reporting
    alt_exam: bool = False  # reporting: a forensic exam counts instead of a report
    days_lost: int | None = None  # minimum loss
    waiver: str = ""
    waiver_sa: bool = False
    skip_reason: str = ""
    # From the verified file, for display only.
    quote: str = ""
    pinpoint: str = ""
    summary: str = ""
    source_id: str = ""


def _str_field(obj, key: str) -> str:
    # tendc's str_field: the value when it is a string, else "".
    value = obj.get(key) if isinstance(obj, dict) else None
    return value if isinstance(value, str) else ""


def _dump(value) -> str:
    # nlohmann::json::dump(): compact, keys sorted, UTF-8 kept.
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, sort_keys=True)


class _Parser:
    def __init__(self):
        self.notes: list[str] = []
        self.tags: list[str] = []  # in order of first appearance, as tendc assigns bits

    def integer(self, r: dict, key: str, limit: int, where: str) -> int | None:
        value = r.get(key)
        if value is None:
            return None
        # nlohmann reads integers past the int64 range as unsigned or as floats; tendc refuses both.
        if type(value) is not int or not INT64_MIN <= value <= INT64_MAX:
            raise LawError(f"{where}: {key} must be an integer")
        if value < 0 or value > limit:
            raise LawError(f"{where}: {key} is out of range")
        return value

    def expense(self, r: dict, where: str, required: bool) -> str | None:
        value = r.get("expense")
        if value is None:
            if required:
                raise LawError(f"{where}: expense is required")
            return None
        if not isinstance(value, str) or value not in RULE_EXPENSES:
            raise LawError(f"{where}: unknown expense {_dump(value)}")
        return value

    def rule(self, r, index: int) -> Rule:
        where = f"rules[{index}]"
        if not isinstance(r, dict):
            raise LawError(f"{where} is not an object")
        rule_id = _str_field(r, "id")
        if not rule_id:
            raise LawError(f"{where}: missing id")
        where = rule_id
        kind = _str_field(r, "kind")
        if kind not in KINDS:
            raise LawError(f"{where}: unknown kind '{kind}'")
        category = _str_field(r, "category")
        # SPEC v1.1 wrote these as info rules; IR v2 gives them their own kinds.
        if kind == "info" and category == "collateral_source":
            kind = "collateral"
        if kind == "info" and category == "exam_payment":
            kind = "exam_payment"
        c = Rule(index=index, id=rule_id, kind=kind, category=category)

        if kind == "total_cap":
            c.cap = self.integer(r, "cap_cents", MAX_CENTS, where)
            if c.cap is None:
                raise LawError(f"{where}: cap_cents is required")
        elif kind == "expense_cap":
            c.expense = self.expense(r, where, True)
            c.cap = self.integer(r, "cap_cents", MAX_CENTS, where)
            if c.cap is None:
                raise LawError(f"{where}: cap_cents is required")
            per = _str_field(r, "per")
            if per == "claim":
                c.per = "claim"
            elif per == "unit":
                c.per = "unit"
                c.unit = _str_field(r, "unit")
                if not c.unit:
                    raise LawError(f"{where}: a per-unit cap needs a unit")
                if c.unit not in UNITS:
                    raise LawError(f"{where}: unknown unit '{c.unit}'")
            else:
                raise LawError(f"{where}: per must be claim or unit")
            c.count_limit = self.integer(r, "count_limit", MAX_COUNT, where)
            if c.count_limit is not None and c.per == "claim":
                self.notes.append(f"{where}: count_limit on a per-claim cap has no units to count and is ignored")
                c.count_limit = None
            alts = r.get("alt_rule_ids")
            if alts is not None:
                if not isinstance(alts, list):
                    raise LawError(f"{where}: alt_rule_ids must be a list")
                for alt in alts:
                    if not isinstance(alt, str) or not alt:
                        raise LawError(f"{where}: alt_rule_ids must hold rule ids")
                    c.alt_ids.append(alt)
        elif kind == "covered":
            c.expense = self.expense(r, where, True)
        elif kind == "excluded":
            c.expense = self.expense(r, where, False)
            tags = r.get("tags")
            found = []
            if tags is not None:
                if not isinstance(tags, list):
                    raise LawError(f"{where}: tags must be a list")
                for tag in tags:
                    if not isinstance(tag, str) or not tag:
                        raise LawError(f"{where}: tags must be non-empty strings")
                    if tag not in self.tags:
                        self.tags.append(tag)
                    if self.tags.index(tag) >= MAX_TAGS:
                        raise LawError("more than 31 distinct tags")
                    found.append(tag)
            c.tags = frozenset(found)
            if c.expense is None and not c.tags:
                raise LawError(f"{where}: an exclusion needs an expense or tags")
        elif kind == "deadline":
            days = self.integer(r, "days", MAX_DAYS, where)
            if days is None:
                raise LawError(f"{where}: days is required")
            c.days = days
            anchor = r.get("from")
            if anchor is not None:
                if not isinstance(anchor, str) or anchor not in ANCHORS:
                    raise LawError(f"{where}: from must be crime, incident, discovery, injury, offense, or report")
                c.anchor = anchor
        elif kind == "reporting":
            required = r.get("required")
            if required is not None:
                if not isinstance(required, bool):
                    raise LawError(f"{where}: required must be true or false")
                c.required = required
            alternatives = r.get("alternatives")
            if alternatives is not None:
                if not isinstance(alternatives, list):
                    raise LawError(f"{where}: alternatives must be a list")
                c.alt_exam = any(isinstance(a, str) and a == "forensic_exam" for a in alternatives)
        elif kind == "minimum_loss":
            c.cap = self.integer(r, "cap_cents", MAX_CENTS, where)
            c.days_lost = self.integer(r, "days_lost", MAX_DAYS, where)
            c.waiver = _str_field(r, "waiver")
            if c.waiver and c.waiver not in WAIVERS:
                raise LawError(f"{where}: unknown waiver '{c.waiver}'")
            sa = r.get("waiver_for_sexual_assault")
            if sa is not None:
                if not isinstance(sa, bool):
                    raise LawError(f"{where}: waiver_for_sexual_assault must be true or false")
                c.waiver_sa = sa
            if c.cap is None and c.days_lost is None:
                raise LawError(f"{where}: a minimum loss rule needs cap_cents or days_lost")
        return c


def _check_hex(text: str) -> bool:
    return bool(_HEX64.fullmatch(text))


class Law:
    """One jurisdiction's law IR, indexed by the step that uses each rule."""

    def __init__(self, ir: dict, verified: dict | None = None, *, verified_sha256: str | None = None,
                 law_sha256: str | None = None):
        p = _Parser()
        if not isinstance(ir, dict):
            raise LawError("IR: top level is not an object")
        version = ir.get("ir_version")
        if type(version) is not int or version != IR_VERSION:
            raise LawError(f"IR: ir_version must be {IR_VERSION}")
        code = _str_field(ir, "jurisdiction")
        if not code or len(code.encode("utf-8")) > 8:
            raise LawError("IR: jurisdiction must be a 1 to 8 character code")
        if not _CODE.fullmatch(code):
            raise LawError("IR: jurisdiction must be uppercase letters or digits")
        raw_rules = ir.get("rules")
        if not isinstance(raw_rules, list):
            raise LawError("IR: rules must be a list")
        rules = [p.rule(r, i) for i, r in enumerate(raw_rules)]
        skipped: list[Rule] = []
        raw_skipped = ir.get("skipped")
        if raw_skipped is not None:
            if not isinstance(raw_skipped, list):
                raise LawError("IR: skipped must be a list")
            for s in raw_skipped:
                rule_id = _str_field(s, "id")
                if not rule_id:
                    raise LawError("IR: a skipped entry has no id")
                skipped.append(Rule(index=len(rules) + len(skipped), id=rule_id, kind="skipped",
                                    category=_str_field(s, "category"), skip_reason=_str_field(s, "reason")))
        if len(rules) + len(skipped) > MAX_RULES:
            raise LawError("IR: too many rules")
        ids: set[str] = set()
        for r in rules + skipped:
            if r.id in ids:
                raise LawError(f"IR: duplicate rule id {r.id}")
            ids.add(r.id)
        for r in rules:
            for alt in r.alt_ids:
                if alt not in ids:
                    raise LawError(f"{r.id}: alt rule {alt} is not in the IR")
        if verified is not None:
            for r in rules + skipped:
                v = verified.get(r.id)
                if v is None:
                    raise LawError(f"{r.id} is in the IR but not in the verified file")
                r.quote, r.pinpoint, r.summary, r.source_id = v["quote"], v["pinpoint"], v["summary"], v["source_id"]
                if v["category"]:
                    r.category = v["category"]
        # Code generation limit: one switch per expense over its tagged exclusions.
        for e in ITEM_EXPENSES:
            if e == "forensic_exam":
                continue  # an exam is held or becomes medical before exclusions apply
            tagged = [r for r in rules if r.kind == "excluded" and r.tags and r.expense in (None, e)]
            if len(tagged) > MAX_TAG_EXCLUSIONS:
                raise LawError("more than 6 tagged exclusions apply to one expense")

        self.jurisdiction = code
        self.name = _str_field(ir, "name")
        self.source_sha256 = _str_field(ir, "source_sha256") or None
        self.verified_sha256 = verified_sha256
        self.notes = p.notes
        self.tags = tuple(p.tags)
        self.rules = rules
        self.skipped = skipped
        self.law_sha256 = law_sha256 or hashlib.sha256(
            json.dumps(ir, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()

        def of(kind: str) -> list[Rule]:
            return [r for r in rules if r.kind == kind]

        self.exam_no_bill = of("exam_no_bill")
        self.exam_payment = of("exam_payment")
        # SPEC v1.2: an exam is held only when a rule says the survivor may not be billed.
        self.hold_proof = [r.id for r in self.exam_no_bill + self.exam_payment] if self.exam_no_bill else []
        self.collateral_ids = [r.id for r in of("collateral")]
        self.excluded = of("excluded")
        self.coverage = {e: [r for r in rules if r.kind in ("covered", "expense_cap") and r.expense == e]
                         for e in RULE_EXPENSES}
        self.unit_caps = [r for r in rules if r.kind == "expense_cap" and r.per == "unit"]
        self.claim_caps = [r for r in rules if r.kind == "expense_cap" and r.per == "claim"]
        totals = of("total_cap")
        self.total_cap = min(totals, key=lambda r: r.cap) if totals else None  # min() keeps the first on ties
        self.minimum_loss = of("minimum_loss")
        self.deadlines = of("deadline")
        self.reporting = of("reporting")
        self.info_ids = [r.id for r in rules if r.kind in ("info", "collateral")
                         or (r.kind == "exam_payment" and not self.exam_no_bill)]
        self.by_id = {r.id: r for r in rules + skipped}

    def evaluate(self, engine_input: dict) -> dict:
        from .engine import evaluate_law
        return evaluate_law(self, engine_input)


def _load_verified(doc) -> dict[str, dict]:
    # tendc's load_verified: the sources and rules a quote can come from.
    if not isinstance(doc, dict):
        raise LawError("verified file: top level is not an object")
    sources: set[str] = set()
    raw_sources = doc.get("sources")
    if isinstance(raw_sources, list):
        for src in raw_sources:
            sid = _str_field(src, "id")
            if not sid or sid in sources:
                raise LawError("verified file: missing or duplicate source id")
            sha = _str_field(src, "sha256")
            if sha and not _check_hex(sha):
                raise LawError(f"verified file: source {sid} has a bad sha256")
            sources.add(sid)
    raw_rules = doc.get("rules")
    if not isinstance(raw_rules, list):
        raise LawError("verified file: rules must be a list")
    out: dict[str, dict] = {}
    for r in raw_rules:
        rid = _str_field(r, "id")
        if not rid:
            continue
        entry = {k: _str_field(r, k) for k in ("category", "pinpoint", "quote", "summary", "source_id")}
        if entry["source_id"] and entry["source_id"] not in sources:
            raise LawError(f"verified file: {rid} cites unknown source {entry['source_id']}")
        out[rid] = entry
    return out


def law_from_bytes(ir_bytes: bytes, verified_bytes: bytes | None = None, *, law_sha256: str | None = None) -> Law:
    """Builds a Law from the raw IR (and optionally verified) bytes, checking them in tendc's order."""
    try:
        ir = json.loads(ir_bytes)
    except (ValueError, RecursionError) as e:
        raise LawError(f"IR: invalid JSON: {e}") from None
    declared = _str_field(ir, "source_sha256") if isinstance(ir, dict) else ""
    if declared and not _check_hex(declared):
        raise LawError("IR: source_sha256 must be 64 hex characters")
    verified = None
    actual = None
    if verified_bytes:
        actual = hashlib.sha256(verified_bytes).hexdigest()
        if declared and declared.lower() != actual:
            raise LawError("stale IR: source_sha256 does not match the verified file (rerun rules/tools/normalize.py)")
        try:
            vdoc = json.loads(verified_bytes)
        except (ValueError, RecursionError) as e:
            raise LawError(f"verified file: invalid JSON: {e}") from None
        if isinstance(ir, dict) and _str_field(vdoc, "jurisdiction") != _str_field(ir, "jurisdiction"):
            raise LawError("the IR and the verified file are for different jurisdictions")
        verified = _load_verified(vdoc)
    return Law(ir, verified, verified_sha256=actual, law_sha256=law_sha256)


def load_law(ir_path: str | Path, verified_path: str | Path | None = None, *, law_sha256: str | None = None,
             use_verified: bool = True) -> Law:
    """Reads rules/ir/ST.json. The verified file defaults to ../verified/ST.json next to it (as in tendc)
    and is used when present; pass use_verified=False to skip it."""
    ir_path = Path(ir_path)
    verified_bytes = None
    if use_verified:
        path = Path(verified_path) if verified_path else ir_path.parent.parent / "verified" / ir_path.name
        if verified_path or path.is_file():
            verified_bytes = path.read_bytes()
    return law_from_bytes(ir_path.read_bytes(), verified_bytes, law_sha256=law_sha256)
