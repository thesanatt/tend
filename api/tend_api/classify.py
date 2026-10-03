"""Map a bank transaction to an expense type from rules/SCHEMA.md.

Order: a registry of known merchants, keyword rules over the merchant and description, then
Gemini for whatever is left, then a pass that links rides to same-day care, then a pass that
reads lost pay from paychecks that dipped after the date it happened. The model only picks a
label from a fixed list; it never sees or returns an amount, and its picks always start
unconfirmed, as do rides linked to care and pay gaps. Each label also carries the SPEC v1.2
shape of its item: a typed unit (a counseling charge is one session, a pay gap counts weeks,
lodging counts days, a ride has no unit) and tags (a replaced phone is tagged "phone").
Eligibility, caps and totals belong to the law engine, not to this module.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import statistics
import threading
from collections.abc import Callable, Iterable, Sequence
from dataclasses import asdict, dataclass, replace
from datetime import date as _date
from pathlib import Path

from .nessie import BankSnapshot

EXPENSES = (
    "medical", "forensic_exam", "counseling", "lost_wages", "transportation", "relocation",
    "temporary_housing", "security", "crime_scene_cleanup", "childcare", "property_replacement",
    "clothing_bedding", "prescription", "dental", "funeral", "legal", "tuition", "other",
)
UNKNOWN = "unknown"
MODEL_LABELS = EXPENSES + (UNKNOWN,)

PRIMARY_MODEL = "gemini-3.8-flash"
FALLBACK_MODEL = "gemini-3.5-flash-lite"
MODEL_TIMEOUT_S = 10
MODEL_BATCH = 25
MODEL_CONFIDENCE = 0.6  # self-reported model confidence is not calibrated, so it is not asked for
PROMPT_VERSION = "classify-v3"  # bump when the prompt changes; old cache entries are then ignored
MAX_REASON_WORDS = 19
CONFIRM_AT = 0.85

# Care a same-day ride can be travel to, and the word the ride's reason uses for it.
CARE_EXPENSES = {"counseling": "counseling", "medical": "medical", "forensic_exam": "medical",
                 "dental": "dental", "prescription": "prescription"}

DEFAULT_CACHE_PATH = Path(os.environ.get(
    "TEND_CLASSIFY_CACHE", Path(__file__).resolve().parents[2] / "seed" / "cache" / "classify_cache.json"))


@dataclass(frozen=True)
class TxnFacts:
    """Everything the classifier may look at. There is no amount field on purpose."""

    ref: str
    kind: str  # purchase, withdrawal, deposit, transfer, bill, bill_line
    merchant_name: str = ""
    merchant_category: str = ""
    description: str = ""
    date: str = ""  # used only to link rides to care on the same day


@dataclass(frozen=True)
class Classification:
    ref: str
    expense: str  # a member of EXPENSES, or "unknown"
    candidate: bool  # offer it to the survivor as a possible recovery cost
    confidence: float
    method: str  # registry, keyword, model, link, income, transfer, unresolved
    reason: str
    confirmed: bool  # where review starts; model picks and inferred links are always False
    linked_refs: tuple[str, ...] = ()
    model: str | None = None
    cached: bool = False
    unit: str | None = None  # SPEC v1.2: session, week, day, ... or None
    units: int = 0  # how many of that unit; 0 when unknown
    tags: tuple[str, ...] = ()  # e.g. ("phone",), which an excluded rule can name

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class _Rule:
    pattern: re.Pattern
    expense: str | None  # None: ordinary spending, never offered
    confidence: float
    reason: str


def _rule(pattern: str, expense: str | None, confidence: float, reason: str) -> _Rule:
    return _Rule(re.compile(pattern, re.IGNORECASE), expense, confidence, reason)


# Known single-purpose merchants. A real deployment would curate this table; it holds the
# fictional demo providers. Multi-purpose stores (pharmacy, phone store) go through keywords.
MERCHANT_REGISTRY: dict[str, tuple[str | None, str]] = {
    "clearwater counseling group": ("counseling", "Known counseling practice"),
    "riverbend general hospital": ("medical", "Known hospital"),
    "larkfield market": (None, "Grocery store"),
    "lumen streaming": (None, "Streaming subscription"),
}

# First match wins, so the narrow patterns sit above the broad ones ("security deposit" is a
# move-in cost, not home security; "new phone" beats "monthly plan").
KEYWORD_RULES: tuple[_Rule, ...] = (
    _rule(r"\bforensic (exam|examination)\b|\bsane exam\b|\bsexual assault (medical )?(forensic )?exam",
          "forensic_exam", 0.95, "Names a medical forensic exam"),
    _rule(r"\bsecurity deposit\b|\bfirst month'?s rent\b|\butilit(y|ies) (setup|start|connection)\b",
          "relocation", 0.85, "Deposit or move-in cost for a new home"),
    _rule(r"\btruck rental\b|\bmoving (truck|van|company|services?)\b|\bmovers\b", "relocation", 0.85, "Moving cost"),
    _rule(r"\blocksmith|\brekey|\bdeadbolt|\block (&|and) (safe|key)\b|\balarm (system|install)|\bsecurity camera",
          "security", 0.85, "Lock or home security work"),
    _rule(r"\bcounsel(ing|or|ling)\b|\btherap(y|ist)\b|\bpsycho(therapy|logist)\b|\b(behavioral|mental) health\b",
          "counseling", 0.9, "Counseling or therapy charge"),
    _rule(r"\brx\b|\bprescription\b", "prescription", 0.85, "Prescription charge"),
    _rule(r"\bdent(al|ist)\b|\borthodont", "dental", 0.9, "Dental care"),
    _rule(r"\bhospital\b|\bmedical center\b|\burgent care\b|\bclinic\b|\bemergency (department|room)\b|"
          r"\blaboratory\b|\bambulance\b|\bphysician\b", "medical", 0.85, "Medical care"),
    _rule(r"\bhotel\b|\bmotel\b|\blodging\b|\bextended stay\b", "temporary_housing", 0.7, "Short-term lodging"),
    _rule(r"\bchild ?care\b|\bdaycare\b|\bbabysit", "childcare", 0.85, "Child care"),
    _rule(r"\bfuneral\b|\bburial\b|\bcremation\b", "funeral", 0.9, "Funeral cost"),
    _rule(r"\battorney\b|\blaw (office|firm)\b|\blegal (aid|services?)\b", "legal", 0.85, "Legal services"),
    _rule(r"\btuition\b", "tuition", 0.85, "Tuition"),
    _rule(r"\bnew (phone|laptop)\b|\bphone replacement\b|\bdevice purchase\b", "property_replacement", 0.85,
          "Replaces a phone or other personal property"),
    _rule(r"\bbedding\b|\bcomforter\b|\bduvet\b|\bapparel\b|\bclothing\b", "clothing_bedding", 0.7,
          "Clothing or bedding"),
    _rule(r"\brideshare\b|\brides?\b|\btaxi\b|\bcab\b|\btransit\b|\bbus fare\b|\bparking\b", "transportation", 0.8,
          "Ride or transit fare"),
    _rule(r"\bgrocer(y|ies)\b|\bsupermarket\b|\bcoffee\b|\bcafe\b|\brestaurant\b|\btakeout\b|\bstreaming\b|"
          r"\bsubscription\b|\bmonthly plan\b|\batm\b", None, 0.9, "Everyday spending"),
)

_TAG = re.compile(r"\[[a-z_]+:[^\]]*\]", re.IGNORECASE)


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", _TAG.sub(" ", text or "")).strip().lower()


# The same keyword table as rules/tools/normalize.py, so an excluded rule's tags and an item's meet.
TAG_WORDS: tuple[tuple[tuple[str, ...], str], ...] = (
    (("cell phone", "mobile phone", "phone"), "phone"),
    (("purse", "wallet", "handbag"), "purse"),
    (("jewelry", "jewellery"), "jewelry"),
    (("cash", "money"), "cash"),
    (("vehicle", "car "), "vehicle"),
    (("pain and suffering",), "pain_suffering"),
)
SESSION_KINDS = frozenset({"purchase", "withdrawal", "bill_line"})  # one charge, one session; a whole bill may hold many
_NIGHTS = re.compile(r"\b(\d{1,2})\s*-?\s*(?:nights?|days?)\b", re.IGNORECASE)


def tags_for(text: str) -> tuple[str, ...]:
    padded = f" {_norm(text)} "
    return tuple(sorted({tag for words, tag in TAG_WORDS if any(w in padded for w in words)}))


def item_shape(expense: str, kind: str, text: str) -> tuple[str | None, int, tuple[str, ...]]:
    """(unit, units, tags) for an item of this expense, as SPEC v1.2 types them."""
    if expense == "counseling":
        return "session", 1 if kind in SESSION_KINDS else 0, ()
    if expense == "temporary_housing":
        nights = _NIGHTS.search(text or "")
        return "day", int(nights.group(1)) if nights else 0, ()
    if expense == "lost_wages":
        return "week", 0, ()
    if expense == "property_replacement":
        # Tags only on replaced property: a rule that excludes phones must not catch a phone plan.
        return None, 0, tags_for(text)
    return None, 0, ()


def content_key(facts: TxnFacts) -> str:
    payload = {"v": PROMPT_VERSION, "kind": facts.kind, "merchant": _norm(facts.merchant_name),
               "category": _norm(facts.merchant_category), "description": _norm(facts.description)}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def _made(facts: TxnFacts, expense: str | None, confidence: float, method: str, reason: str) -> Classification:
    if expense is None:
        return Classification(facts.ref, UNKNOWN, False, confidence, method, reason, False)
    if expense == "transportation":
        # A ride is only a recovery cost when it is travel to care; link_care_rides decides.
        return Classification(facts.ref, expense, False, confidence, method, reason, False)
    unit, units, tags = item_shape(expense, facts.kind, f"{facts.merchant_name} {facts.description}")
    return Classification(facts.ref, expense, True, confidence, method, reason, confidence >= CONFIRM_AT,
                          unit=unit, units=units, tags=tags)


def classify_deterministic(facts: TxnFacts) -> Classification | None:
    if facts.kind == "deposit":
        return Classification(facts.ref, UNKNOWN, False, 0.95, "income", "Money coming in, not a cost", False)
    if facts.kind == "transfer":
        return Classification(facts.ref, UNKNOWN, False, 0.95, "transfer", "Money moved between accounts", False)
    exam = KEYWORD_RULES[0]
    if exam.pattern.search(_norm(facts.description)):
        # Checked before the registry: an exam line on a hospital bill is not plain "medical".
        return _made(facts, exam.expense, exam.confidence, "keyword", exam.reason)
    known = MERCHANT_REGISTRY.get(_norm(facts.merchant_name))
    if known and facts.kind != "bill_line":
        return _made(facts, known[0], 0.95, "registry", known[1])
    haystack = " | ".join(_norm(x) for x in (facts.merchant_name, facts.description, facts.merchant_category))
    if facts.kind == "bill_line":
        haystack = _norm(facts.description)  # each line says what it is; the payee is the same on all
    for rule in KEYWORD_RULES:
        if rule.pattern.search(haystack):
            return _made(facts, rule.expense, rule.confidence, "keyword", rule.reason)
    return None


LABEL_TEXT = {
    "medical": "medical care", "forensic_exam": "a forensic exam", "counseling": "counseling",
    "lost_wages": "lost pay", "transportation": "a ride or fare", "relocation": "a moving cost",
    "temporary_housing": "short-term lodging", "security": "home security", "crime_scene_cleanup": "cleanup",
    "childcare": "child care", "property_replacement": "replacement property",
    "clothing_bedding": "clothing or bedding", "prescription": "a prescription", "dental": "dental care",
    "funeral": "a funeral cost", "legal": "legal help", "tuition": "tuition", "other": "a prescribed device",
    UNKNOWN: "ordinary spending",
}
_COVERAGE_TALK = re.compile(r"\b(cover(ed|s|age)?|eligib\w*|qualif\w*|reimburs\w*|compensab\w*)\b", re.IGNORECASE)


def clean_reason(text: str, label: str) -> str:
    """Model reasons are shown to people: under 20 words, no numbers, no dashes as punctuation,
    and no word on coverage, which only the law engine decides."""
    text = re.sub(r"\s*[\u2013\u2014]\s*", ", ", text or "")
    text = text.replace("\u2018", "'").replace("\u2019", "'").replace("\u201c", '"').replace("\u201d", '"')
    words = [w for w in text.split() if not re.search(r"[0-9$\u20ac\u00a3]", w)]
    out = " ".join(words[:MAX_REASON_WORDS]).strip(" ,;:-.")
    if not out or _COVERAGE_TALK.search(out):
        return f"Looks like {LABEL_TEXT.get(label, 'ordinary spending')}"
    return out[0].upper() + out[1:]


SYSTEM_PROMPT = """You sort bank transactions for a tool that helps crime survivors find costs their state's
victim compensation program may cover. For each transaction choose the one expense type it most likely is.
Choose "unknown" for ordinary spending (food, household basics, entertainment) and whenever you cannot tell.
Judge only from the merchant, its category, and the description. Do not mention amounts or numbers.
Give a plain reason under 20 words that says what the purchase is. Never say whether it is covered,
eligible, or reimbursable; the program's rules decide that, not you.

Expense types:
medical: hospital, clinic, doctor, ambulance, or lab charges
forensic_exam: a sexual assault medical forensic exam
counseling: therapy, counseling, or other mental health care
lost_wages: pay lost from missed work (never a purchase)
transportation: rides, transit, parking, or mileage
relocation: moving costs, or a deposit or first month's rent on a new home
temporary_housing: hotel or other short-term lodging
security: locks, door hardware, alarms, cameras, or lighting that makes a home safer
crime_scene_cleanup: cleaning a home or vehicle after a crime
childcare: child care or babysitting
property_replacement: replacing personal property such as a phone, laptop, or purse
clothing_bedding: replacement clothing, sheets, pillows, or other bedding
prescription: prescription medicine (over-the-counter items are not prescriptions)
dental: dentist or dental care
funeral: funeral or burial
legal: attorney or legal services
tuition: school tuition or fees
other: eyeglasses, hearing aids, or other prescribed devices
unknown: everyday spending, or not clear"""

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "ref": {"type": "string"},
                    "expense": {"type": "string", "enum": list(MODEL_LABELS)},
                    "reason": {"type": "string"},
                },
                "required": ["ref", "expense", "reason"],
            },
        }
    },
    "required": ["results"],
}

# A model backend takes rows of {ref, kind, merchant, category, description} and returns the
# parsed JSON object plus the name of the model that answered.
ModelFn = Callable[[list[dict]], tuple[dict, str]]


def gemini_backend(api_key: str, primary: str = PRIMARY_MODEL, fallback: str = FALLBACK_MODEL,
                   timeout_s: float = MODEL_TIMEOUT_S, client=None) -> ModelFn:
    from google import genai
    from google.genai import types

    # One attempt per model: the fallback is the retry, and the scan should not stall past 10 s a call.
    client = client or genai.Client(api_key=api_key, http_options=types.HttpOptions(
        timeout=int(timeout_s * 1000), retry_options=types.HttpRetryOptions(attempts=1)))

    def call(model: str, rows: list[dict], thinking: bool) -> dict:
        config = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            response_mime_type="application/json",
            response_json_schema=RESPONSE_SCHEMA,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW) if thinking else None,
        )
        resp = client.models.generate_content(model=model, contents=json.dumps(rows), config=config)
        return json.loads(resp.text or "")

    def run(rows: list[dict]) -> tuple[dict, str]:
        try:
            return call(primary, rows, thinking=True), primary
        except Exception:  # 503s from the primary are common at peak; any failure falls back once
            return call(fallback, rows, thinking=False), fallback

    return run


class ClassificationCache:
    """Model answers keyed by content hash, so a merchant and description are sent at most once.

    The file is committed with the fictional seed, so by default a new entry keeps only the label,
    reason and model. record_text=True also keeps the merchant and description for review; only
    the seeder sets it, so a real customer's transaction text is never written to disk.
    """

    def __init__(self, path: Path | str | None, record_text: bool = False):
        self.path = Path(path) if path else None
        self.record_text = record_text
        self._lock = threading.Lock()
        self._entries: dict[str, dict] = {}
        self._dirty = False
        if self.path and self.path.exists():
            try:
                data = json.loads(self.path.read_text())
            except (OSError, ValueError):
                data = {}  # an unreadable cache only costs model calls
            if isinstance(data, dict) and data.get("prompt_version") == PROMPT_VERSION:
                self._entries = data.get("entries", {})

    def get(self, key: str) -> dict | None:
        return self._entries.get(key)

    def put(self, key: str, entry: dict) -> None:
        if not self.record_text:
            entry = {k: v for k, v in entry.items() if k in ("expense", "reason", "model", "kind")}
        with self._lock:
            self._entries[key] = entry
            self._dirty = True

    def __len__(self) -> int:
        return len(self._entries)

    def flush(self) -> None:
        if not (self.path and self._dirty):
            return
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            body = {"prompt_version": PROMPT_VERSION, "entries": dict(sorted(self._entries.items()))}
            tmp = self.path.with_suffix(".tmp")
            try:
                tmp.write_text(json.dumps(body, indent=1) + "\n")
                tmp.replace(self.path)
                self._dirty = False
            except OSError:
                pass  # read-only deploys keep the answers in memory


class Classifier:
    def __init__(self, cache: ClassificationCache | Path | str | None = DEFAULT_CACHE_PATH,
                 model: ModelFn | None = None, use_model: bool = True):
        self.cache = cache if isinstance(cache, ClassificationCache) else ClassificationCache(cache)
        if model is None and use_model and os.environ.get("GEMINI_API_KEY"):
            model = gemini_backend(os.environ["GEMINI_API_KEY"])
        self.model = model if use_model else None
        self.model_errors: list[str] = []

    def classify(self, facts: Sequence[TxnFacts]) -> list[Classification]:
        done: dict[str, Classification] = {}
        pending: dict[str, TxnFacts] = {}
        for f in facts:
            hit = classify_deterministic(f)
            if hit:
                done[f.ref] = hit
                continue
            entry = self.cache.get(content_key(f))
            if entry:
                done[f.ref] = self._from_entry(f, entry, cached=True)
            else:
                pending.setdefault(content_key(f), f)
        if pending and self.model:
            self._ask_model(pending)
        out = []
        for f in facts:
            if f.ref in done:
                out.append(done[f.ref])
                continue
            entry = self.cache.get(content_key(f))
            out.append(self._from_entry(f, entry, cached=False) if entry else Classification(
                f.ref, UNKNOWN, True, 0.0, "unresolved", "Could not sort this one; review it by hand", False))
        self.cache.flush()
        return out

    def _ask_model(self, pending: dict[str, TxnFacts]) -> None:
        items = list(pending.items())
        for start in range(0, len(items), MODEL_BATCH):
            batch = items[start:start + MODEL_BATCH]
            refs = {f"t{i + 1}": key for i, (key, _) in enumerate(batch)}
            # Short refs instead of Nessie ids, and no amounts: the model sees only what a label needs.
            rows = []
            for ref, key in refs.items():
                f = pending[key]
                rows.append({"ref": ref, "kind": f.kind, "merchant": f.merchant_name, "category": f.merchant_category,
                             "description": _TAG.sub("", f.description).strip()})
            try:
                answer, model_name = self.model(rows)
            except Exception as exc:  # the scan must finish even when the model is down
                self.model_errors.append(f"{type(exc).__name__}: {str(exc)[:200]}")
                continue
            for item in (answer or {}).get("results", []):
                key = refs.get(str(item.get("ref")))
                label = item.get("expense")
                if key is None or label not in MODEL_LABELS:
                    continue
                f = pending[key]
                self.cache.put(key, {"expense": label, "reason": clean_reason(str(item.get("reason", "")), label),
                                     "model": model_name, "kind": f.kind, "merchant": f.merchant_name,
                                     "category": f.merchant_category, "description": _norm(f.description)})

    @staticmethod
    def _from_entry(f: TxnFacts, entry: dict, cached: bool) -> Classification:
        expense = entry["expense"] if entry.get("expense") in MODEL_LABELS else UNKNOWN
        candidate = expense not in (UNKNOWN, "transportation")  # rides wait for link_care_rides
        reason = clean_reason(entry.get("reason", ""), expense)  # again on read, in case the file was edited
        unit, units, tags = item_shape(expense, f.kind, f"{f.merchant_name} {f.description}") if candidate else (None, 0, ())
        return Classification(f.ref, expense, candidate, MODEL_CONFIDENCE, "model", reason, False,
                              model=entry.get("model"), cached=cached, unit=unit, units=units, tags=tags)


def link_care_rides(facts: Sequence[TxnFacts], results: Sequence[Classification],
                    extra_anchors: Iterable[tuple[str, str, str]] = ()) -> list[Classification]:
    """A ride counts only as travel to care: same day as a confident care charge.

    extra_anchors are (date, ref, expense) for care that is not a bank transaction, such as the
    service date on an itemized bill. Links are inferences, so they always come back unconfirmed.
    """
    by_ref = {r.ref: r for r in results}
    anchors: dict[str, list[tuple[str, str]]] = {}
    for f in facts:
        r = by_ref[f.ref]
        if f.date and r.expense in CARE_EXPENSES and r.candidate and r.confidence >= CONFIRM_AT:
            anchors.setdefault(f.date, []).append((f.ref, r.expense))
    for day, ref, expense in extra_anchors:
        anchors.setdefault(day, []).append((ref, expense))

    out = []
    for f in facts:
        r = by_ref[f.ref]
        if r.expense == "transportation" and f.date:
            hits = anchors.get(f.date, [])
            if hits:
                care = CARE_EXPENSES.get(hits[0][1], "care")
                r = replace(r, candidate=True, confirmed=False, method="link", confidence=0.7,
                            linked_refs=tuple(ref for ref, _ in hits), reason=f"Same day as a {care} charge")
            else:
                r = replace(r, candidate=False, confirmed=False, linked_refs=(),
                            reason="Ride on a day with no care charge")
        out.append(r)
    return out


def facts_from_snapshot(snapshot: BankSnapshot) -> list[TxnFacts]:
    facts = []
    for t in snapshot.txns:
        m = snapshot.merchant(t.merchant_id)
        name, category = (m.name, m.category) if m else ("", "")
        facts.append(TxnFacts(t.id, t.kind, name, category, t.display_description, t.date))
    for b in snapshot.bills:
        # A Nessie bill has no service date (creation_date is when it was entered), so it is not
        # a link anchor; pass the itemized bill's service date through extra_anchors instead.
        facts.append(TxnFacts(b.id, "bill", b.payee, "", b.nickname, ""))
    return facts


_TEND_ACTION = re.compile(r"\[tend:[^\]]+\]", re.IGNORECASE)
ITEMIZED_REASON = "Itemized statement on file, so its lines are reviewed one by one instead"
TEND_PAYMENT_REASON = "Payment made through Tend, so the bill lines it paid are reviewed instead"


def _set_aside(r: Classification, reason: str) -> Classification:
    return replace(r, candidate=False, confirmed=False, linked_refs=(), reason=reason)


# Lost pay. A paycheck from the same employer that comes in well under the usual amount after the
# date it happened is offered as lost wages: an inference, so it always waits for the survivor's yes.
PAY_WORDS = re.compile(r"payroll|salary|paycheck|direct dep|\bwages?\b|\bpay\b", re.IGNORECASE)
GAP_MIN_CENTS = 20_00  # a dip must be at least $20 ...
GAP_MIN_TENTHS = 1  # ... and at least a tenth of the usual check
MIN_USUAL_CHECKS = 3  # checks before the date that set what "usual" means


@dataclass(frozen=True)
class WageGap:
    ref: str  # the deposit that came in short
    date: str
    paid_cents: int
    usual_cents: int
    gap_cents: int
    weeks: int  # the pay period, in weeks


def wage_gaps(deposits: Iterable[tuple[str, str, int, str]], incident_date: str | None) -> dict[str, WageGap]:
    """deposits are (ref, date, amount_cents, description), amounts positive. Ref -> the gap it shows."""
    if not incident_date:
        return {}
    groups: dict[str, list[tuple[str, str, int]]] = {}
    for ref, day, cents, description in deposits:
        key = _norm(description)
        if cents > 0 and day and PAY_WORDS.search(key):
            groups.setdefault(key, []).append((day, ref, cents))
    out: dict[str, WageGap] = {}
    for rows in groups.values():
        rows.sort()
        before = [cents for day, _, cents in rows if day < incident_date]
        if len(before) < MIN_USUAL_CHECKS:
            continue
        usual = statistics.median_low(before)  # an actual check amount, so integer cents
        days = [_date.fromisoformat(day) for day, _, _ in rows]
        spacing = [(b - a).days for a, b in zip(days, days[1:], strict=False) if (b - a).days > 0]
        weeks = max(1, round(statistics.median_low(spacing) / 7)) if spacing else 1
        for day, ref, cents in rows:
            gap = usual - cents
            if day >= incident_date and gap >= GAP_MIN_CENTS and gap * 10 >= usual * GAP_MIN_TENTHS:
                out[ref] = WageGap(ref, day, cents, usual, gap, weeks)
    return out


def _dollars(cents: int) -> str:
    return f"${cents // 100:,}" if cents % 100 == 0 else f"${cents // 100:,}.{cents % 100:02d}"


def gap_classification(gap: WageGap) -> Classification:
    reason = f"Paycheck was {_dollars(gap.paid_cents)}, {_dollars(gap.gap_cents)} below your usual {_dollars(gap.usual_cents)}"
    return Classification(gap.ref, "lost_wages", True, 0.6, "inference", reason, False, unit="week", units=gap.weeks)


def snapshot_incident_date(snapshot: BankSnapshot) -> str | None:
    return (snapshot.meta.get("demo_inputs") or {}).get("incident_date")


def snapshot_wage_gaps(snapshot: BankSnapshot, incident_date: str | None = None) -> dict[str, WageGap]:
    deposits = [(t.id, t.date, t.amount_cents, t.display_description) for t in snapshot.txns
                if t.kind == "deposit" and t.status != "cancelled"]
    return wage_gaps(deposits, incident_date or snapshot_incident_date(snapshot))


def classify_snapshot(snapshot: BankSnapshot, classifier: Classifier | None = None,
                      extra_anchors: Iterable[tuple[str, str, str]] = (),
                      incident_date: str | None = None) -> dict[str, Classification]:
    """Nessie id -> Classification for every transaction and bill in the snapshot.

    Two kinds of record are set aside so no dollar is offered twice: a Nessie bill that has an
    itemized document (its lines, which the scan reads from the PDF, carry the expenses, and one
    of them may be a forensic exam the engine holds), and a payment Tend made (its description
    carries [tend:<action id>]; it pays bill lines that are already offered). A paycheck that
    dipped after incident_date (default: the snapshot's demo date) becomes a lost-wages label.
    """
    facts = facts_from_snapshot(snapshot)
    results = (classifier or Classifier()).classify(facts)
    documents = [d for d in snapshot.meta.get("documents", []) if d.get("bill_id")]
    itemized = {d["bill_id"] for d in documents}
    tend_paid = {t.id for t in snapshot.txns if _TEND_ACTION.search(t.description)}
    results = [_set_aside(r, ITEMIZED_REASON) if r.ref in itemized
               else _set_aside(r, TEND_PAYMENT_REASON) if r.ref in tend_paid else r for r in results]
    anchors = list(extra_anchors)
    known = {(day, ref) for day, ref, _ in anchors}
    # The itemized bill's service date is care on that day, so a ride then is travel to care.
    anchors += [(d["service_date"], d["bill_id"], "medical") for d in documents
                if d.get("service_date") and (d["service_date"], d["bill_id"]) not in known]
    gaps = snapshot_wage_gaps(snapshot, incident_date)
    linked = link_care_rides(facts, results, anchors)
    return {r.ref: gap_classification(gaps[r.ref]) if r.ref in gaps else r for r in linked}


# Engine items. A ClassifiedItem (web/lib/contracts.ts) is an engine item plus unit, tags, source,
# reason, and confidence. Only direct matches (a known merchant or a keyword) may start confirmed.
DIRECT_METHODS = frozenset({"registry", "keyword"})


def classified_item(item_id: str, day: str, amount_cents: int, description: str, r: Classification,
                    is_bill: bool = False, model_source: str = "cloud_ai") -> dict:
    return {
        "item_id": item_id,
        "date": day,
        "amount_cents": amount_cents,
        "expense": r.expense,
        "confirmed": bool(r.confirmed) and r.method in DIRECT_METHODS,
        "insurance_paid_cents": 0,
        "is_bill": is_bill,
        "units": r.units,
        "unit": r.unit,
        "description": " ".join(description.split())[:200],
        "tags": list(r.tags),
        "source": model_source if r.method == "model" else "rule",
        "reason": r.reason,
        "confidence": r.confidence,
    }


def snapshot_items(snapshot: BankSnapshot, results: dict[str, Classification],
                   incident_date: str | None = None) -> list[dict]:
    """ClassifiedItems for every candidate in the snapshot, in date order. Pay gaps claim the shortfall."""
    gaps = snapshot_wage_gaps(snapshot, incident_date)
    items = []
    for t in sorted(snapshot.txns, key=lambda t: (t.date, t.id)):
        r = results.get(t.id)
        if r is None or not r.candidate:
            continue
        m = snapshot.merchant(t.merchant_id)
        description = " ".join(filter(None, [m.name if m else "", t.display_description]))
        amount = gaps[t.id].gap_cents if t.id in gaps else t.amount_cents
        items.append(classified_item(t.item_id, t.date, amount, description, r))
    for b in snapshot.bills:
        r = results.get(b.id)
        if r is not None and r.candidate:
            day = b.creation_date or b.payment_date or ""
            items.append(classified_item(b.item_id, day, b.amount_cents, b.payee, r, is_bill=True))
    return items


def statement_facts(rows: Sequence[dict]) -> list[TxnFacts]:
    """TxnFacts for StatementTxn rows (web/lib/contracts.ts). Money in (a negative amount) reads as a deposit."""
    facts = []
    for row in rows:
        cents = row.get("amount_cents")
        kind = row.get("kind") or ("deposit" if isinstance(cents, int) and cents < 0 else "purchase")
        facts.append(TxnFacts(str(row["id"]), kind, row.get("merchant") or "", row.get("category") or "",
                              row.get("description") or "", str(row.get("date") or "")))
    return facts


def label_statement(rows: Sequence[dict], incident_date: str | None = None, classifier: Classifier | None = None,
                    extra_anchors: Iterable[tuple[str, str, str]] = ()) -> tuple[list[Classification], dict[str, WageGap]]:
    """One label per StatementTxn row, in row order, with the same steps as a snapshot: rules, the model for
    what is left, rides linked to care, Tend's own payments set aside, and pay gaps after incident_date."""
    facts = statement_facts(rows)
    results = (classifier or Classifier()).classify(facts)
    results = [_set_aside(r, TEND_PAYMENT_REASON)
               if row.get("tend_action") or _TEND_ACTION.search(str(row.get("description") or "")) else r
               for r, row in zip(results, rows, strict=True)]
    deposits = [(f.ref, f.date, -int(row["amount_cents"]), f.description) for f, row in zip(facts, rows, strict=True)
                if f.kind == "deposit" and isinstance(row.get("amount_cents"), int)]
    gaps = wage_gaps(deposits, incident_date)
    linked = link_care_rides(facts, results, extra_anchors)
    return [gap_classification(gaps[r.ref]) if r.ref in gaps else r for r in linked], gaps


def classify_statement(rows: Sequence[dict], incident_date: str | None = None, classifier: Classifier | None = None,
                       extra_anchors: Iterable[tuple[str, str, str]] = (), model_source: str = "cloud_ai") -> list[dict]:
    """ClassifiedItems for StatementTxn rows: id, date, amount_cents with money out positive, description,
    merchant, and optionally kind and category. Rows without a date or an amount get no item."""
    labels, gaps = label_statement(rows, incident_date, classifier, extra_anchors)
    items = []
    for f, r, row in zip(statement_facts(rows), labels, rows, strict=True):
        cents = row.get("amount_cents")
        if not r.candidate or not isinstance(cents, int) or not f.date:
            continue
        amount = gaps[f.ref].gap_cents if f.ref in gaps else abs(cents)
        description = " ".join(filter(None, [f.merchant_name, _TAG.sub("", f.description).strip()]))
        items.append(classified_item(f.ref, f.date, amount, description, r, is_bill=f.kind == "bill",
                                     model_source=model_source))
    return items
