"""Find the verified rules that answer a question, or say that none do.

The database does the full-text part (Postgres tsvector in Neon, FTS5 offline). This module turns
a plain question into search terms and intents (which categories and expenses it is about), ranks
the hits the same way on both backends, and decides whether any rule actually supports an answer.
No model writes the answer: every sentence is a rule's own verified summary, next to its quote.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

STOPWORDS = frozenset(
    """a about after again all am an and any are as at be because been before being but by can could
    did do does doing don for from get gets getting go going got had has have having he her here hers
    him his how i if in into is it its just know let like ll me might more my need needs no not now of
    off on once one only or other our out over own please re really s same she should so some still such
    t than that the their them then there these they this those through to too under until up us use
    very was way we were what when where which while who whom why will with would you your yours""".split()
)
# Words that match nearly every rule in a state's file, so they cannot show that a rule fits.
GENERIC = frozenset(
    """program programs victim victims crime crimes compensation compensate state states money claim claims
    help survivor survivors assault sexual law laws rule rules covered cover covers pay paid
    pays payment get qualify eligible eligibility tend""".split()
)

# (pattern, categories) checked against the lowercased question.
CATEGORY_INTENTS: tuple[tuple[re.Pattern[str], frozenset[str]], ...] = tuple(
    (re.compile(p), frozenset(c))
    for p, c in (
        (
            r"\bdeadline|\bhow long (do|does|can|until|to)\b(?!.*\b(take|wait)\b)|time limit|too late|statute of limitation|"
            r"\b(when|by when) (do|must|should) i (apply|file)|\b(years?|days?|months?) to (apply|file)",
            {"filing_deadline"},
        ),
        (r"\bpolice\b|\breport(ed|ing)?\b|\bcops?\b|law enforcement", {"reporting_requirement"}),
        (r"\bforensic\b|rape kit|\bsane\b|\bsafe exam\b|evidence kit|\bexam\b", {"exam_no_bill", "exam_payment"}),
        (r"\b(the )?most\b|\bmax(imum)?\b|\blimit\b|\bcap\b|\bup to\b|how much", {"total_cap", "expense_cap"}),
        (r"\bminimum\b|\bat least\b", {"minimum_loss"}),
        (r"\binsurance\b|\binsurer\b|medicaid|medicare|deductible|\bco-?pay", {"collateral_source"}),
        (
            r"how (do|can) i (apply|file)|where (do|can|should) i (send|mail|apply|file)|\bsubmit|\bapplication\b|\bapply online\b|\bfax\b",
            {"submission"},
        ),
        (r"\bdocuments?\b|paperwork|\bproof\b|\breceipts?\b|what (do|will) i need", {"required_document"}),
        (
            r"how long (does|will) (it|the) (take|decision)|\bprocessing\b|hear back|when will (they|i) (decide|pay|get paid)",
            {"processing_time"},
        ),
        (
            r"anonymous|\bmy address\b|\baddress\b|confidential|\bprivate\b|privacy|jane doe|\bmy name\b|safe at home",
            {"address_confidentiality", "record_confidentiality"},
        ),
        (r"\bemergency (award|money|payment|funds?)|\badvance\b|right away", {"emergency_award"}),
        (r"who can apply|\bresidents?\b|\bout of state\b|\blive in\b|\bmoved\b|\bcitizen", {"residency"}),
        (r"\bfault\b|\bdrinking\b|\bdrunk\b|\bblame\b|\bmy (own )?conduct\b", {"conduct_reduction"}),
    )
)
COVERAGE = re.compile(r"\bcover(ed|s|age)?\b|\bpay (for|back)\b|\breimburs\w*|\bget (money|paid) for\b|\bpaid for\b|\binclude")
EXPENSE_INTENTS: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(p), e)
    for p, e in (
        (r"\bcounsel\w*|\btherap\w*|\bpsycholog\w*|mental health|psychiatr\w*", "counseling"),
        (r"lost (wages|pay|income)|\bwages?\b|missed work|time off( work)?|\bpaychecks?\b|\bsalary\b|\bmy job\b", "lost_wages"),
        (
            r"\brides?\b|\buber\b|\blyft\b|\btaxi\b|\bcab\b|\bbus\b|\btransit\b|\bmileage\b|\bparking\b|transportation|\btravel",
            "transportation",
        ),
        (r"\bmov(e|ing)\b|\brelocat\w*|new (place|apartment|home)|\brent\b|security deposit", "relocation"),
        (r"\bhotel\b|\bmotel\b|\bshelter\b|temporary housing|place to stay|\blodging\b", "temporary_housing"),
        (r"\blocks?\b|\blocksmith\b|\balarm\b|\bcameras?\b|security system|\bdeadbolt", "security"),
        (r"\bclean(ing|up)?\b|crime scene", "crime_scene_cleanup"),
        (r"child ?care|\bdaycare\b|\bbabysit\w*", "childcare"),
        (r"\bphone\b(?! number)|\blaptop\b|\bpurse\b|\bwallet\b|\bproperty\b|\bstolen\b|\bjewelry\b", "property_replacement"),
        (r"\bcloth(es|ing)\b|\bbedding\b|\bsheets\b|\bpillows?\b", "clothing_bedding"),
        (r"\bprescriptions?\b|\bmedicines?\b|\bmedications?\b|\bpills?\b|\bpharmacy\b|\brx\b", "prescription"),
        (r"\bdent(al|ist)\b|\bteeth\b|\btooth\b", "dental"),
        (r"\bfuneral\b|\bburial\b", "funeral"),
        (r"\blawyer\b|\battorney\b|\blegal\b", "legal"),
        (r"\btuition\b|\bschool\b|\bcollege\b", "tuition"),
        (r"\bmedical\b|\bhospital\b|\bdoctors?\b|emergency room|\bclinic\b|\bambulance\b|\bnurse\b|\ber\b", "medical"),
    )
)
TAG_INTENTS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bphone\b(?! number)"), "phone"),
    (re.compile(r"\bpurse\b|\bwallet\b|\bhandbag\b"), "purse"),
    (re.compile(r"\bjewel(le)?ry\b"), "jewelry"),
    (re.compile(r"\bcash\b"), "cash"),
    (re.compile(r"\bcar\b|\bvehicle\b"), "vehicle"),
    (re.compile(r"pain and suffering"), "pain_suffering"),
)
CONTACT = re.compile(r"phone number|\bcall\b|\bcontact\b|\bwebsite\b|\bhotline\b|\breach (them|the program)\b|\bemail address\b")
COVERAGE_CATEGORIES = frozenset({"covered_expense", "excluded_expense", "expense_cap"})
# Lists of forms and steps match many questions loosely; they rank last unless asked for.
QUIET = frozenset({"required_document", "submission", "processing_time"})
MAX_POINTS = 4


@dataclass
class Query:
    text: str
    terms: list[str]  # content words for full-text search, lowercase ASCII only
    own: list[str] = field(default_factory=list)  # the question's own content words, before any expansion
    categories: set[str] = field(default_factory=set)
    expenses: set[str] = field(default_factory=set)
    tags: set[str] = field(default_factory=set)
    contact: bool = False

    @property
    def has_intent(self) -> bool:
        return bool(self.categories or self.expenses or self.tags)


def _tokens(text: str) -> list[str]:
    return re.findall(r"[a-z][a-z0-9]+", text.lower())


def parse_query(text: str, drop: frozenset[str] | set[str] = frozenset()) -> Query:
    """drop: words to leave out of the search, such as the state's own name."""
    low = " ".join(text.lower().split())
    terms: list[str] = []
    for tok in _tokens(low):
        if len(tok) >= 3 and tok not in STOPWORDS and tok not in GENERIC and tok not in drop and tok not in terms:
            terms.append(tok)
    q = Query(text=text, terms=terms[:24], own=list(terms))
    for pattern, cats in CATEGORY_INTENTS:
        if pattern.search(low):
            q.categories |= cats
    for pattern, expense in EXPENSE_INTENTS:
        if pattern.search(low):
            q.expenses.add(expense)
    for pattern, tag in TAG_INTENTS:
        if pattern.search(low):
            q.tags.add(tag)
    if q.expenses and (COVERAGE.search(low) or not q.categories):
        q.categories |= COVERAGE_CATEGORIES
    if "forensic_exam" not in q.expenses and q.categories & {"exam_no_bill", "exam_payment"}:
        q.expenses.add("forensic_exam")
    if q.tags:
        q.categories.add("excluded_expense")
    q.contact = bool(CONTACT.search(low))
    for word in sorted(q.expenses):
        for part in word.split("_"):
            if part not in q.terms and part not in GENERIC:
                q.terms.append(part)
    return q


def _stems(text: str) -> set[str]:
    return {tok[:5] for tok in _tokens(text)}


def term_overlap(query: Query, rule: dict[str, Any]) -> int:
    """How many of the question's own content words the rule contains (by a crude five-letter stem)."""
    text = _stems(f"{rule.get('heading', '')} {rule.get('summary', '')} {rule.get('quote', '')}")
    return len({t[:5] for t in query.own} & text)


def rank(query: Query, fts_hits: list[dict[str, Any]], intent_rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge full-text hits with the rules the intents name, and score them the same way on both backends."""
    top = max((h["score"] for h in fts_hits), default=0.0) or 1.0
    merged: dict[str, dict[str, Any]] = {}
    for hit in fts_hits:
        merged[hit["id"]] = {**hit, "fts": hit["score"] / top}
    for rule in intent_rules:
        merged.setdefault(rule["id"], {**rule, "fts": 0.0})
    out = []
    for rule in merged.values():
        intent = 0.0
        if rule["category"] in query.categories:
            intent += 1.0
        if rule.get("expense") and rule["expense"] in query.expenses:
            intent += 0.9
        if query.tags & set((rule.get("ir") or {}).get("tags") or []):
            intent += 0.8
        if query.expenses and rule["category"] in COVERAGE_CATEGORIES and rule.get("expense") not in query.expenses:
            intent -= 0.6  # a rule about another expense does not answer this one
        score = 0.6 * rule["fts"] + intent
        if rule["category"] in QUIET and rule["category"] not in query.categories:
            score -= 0.5
        if rule.get("ir_kind") == "skipped":
            score -= 0.8  # a less generous duplicate the engines set aside
        out.append({**rule, "intent": intent, "rank": round(score, 6)})
    out.sort(key=lambda r: (-r["rank"], r["ord"]))
    return out


def supported(query: Query, ranked: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The rules that answer the question, best first; empty when nothing in the corpus supports an answer."""
    if not ranked:
        return []
    if query.has_intent:
        fits = [r for r in ranked if r["intent"] > 0.5]
    else:
        if not query.own:
            return []
        need = 1 if len({t[:5] for t in query.own}) <= 1 else 2
        fits = [r for r in ranked if r["fts"] > 0 and term_overlap(query, r) >= need]
    if not fits:
        return []
    best = fits[0]["rank"]
    keep = [r for r in fits if r["rank"] >= max(0.5, best * 0.6)]
    return keep[:MAX_POINTS]


def citation(rule: dict[str, Any]) -> dict[str, Any]:
    return {
        "rule_id": rule["id"],
        "category": rule["category"],
        "expense": rule.get("expense"),
        "summary": rule.get("summary"),
        "quote": rule.get("quote"),
        "pinpoint": rule.get("pinpoint"),
        "fragment_url": rule.get("fragment_url"),
        "source_id": rule.get("source_id"),
        "source_title": rule.get("source_title"),
        "source_url": rule.get("source_url"),
        "source_sha256": rule.get("source_sha256"),
    }
