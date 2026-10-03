"""Turning a message (typed, clicked, or relayed by the ASI:One planner) into structured fields.

Only the fields are kept. The text itself is never stored or logged.
"""

from __future__ import annotations

import datetime as dt
import json
import re
from dataclasses import dataclass
from typing import Any

# ---------------------------------------------------------------- dates (only the date, never what happened)

_MONTH = r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?"
_MONTHS = {m: i for i, m in enumerate(("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1)}
_ISO = re.compile(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b")
_US = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4}|\d{2})\b")
_MDY = re.compile(rf"\b{_MONTH}\s+(\d{{1,2}})(?:st|nd|rd|th)?\b(?:,?\s+(\d{{4}})\b)?", re.I)
_DMY = re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?{_MONTH}(?:,?\s+(\d{{4}})\b)?", re.I)


@dataclass(frozen=True)
class FoundDate:
    date: dt.date
    future: bool = False


def _safe_date(y: int, m: int, d: int) -> dt.date | None:
    try:
        return dt.date(y, m, d)
    except ValueError:
        return None


def _year_or_recent(year: str | None, month: int, day: int, today: dt.date) -> dt.date | None:
    if year:
        return _safe_date(int(year), month, day)
    this_year = _safe_date(today.year, month, day)
    if this_year is not None and this_year > today:
        return _safe_date(today.year - 1, month, day)
    return this_year


def find_date(text: str, today: dt.date) -> FoundDate | None:
    """The first date in the text. A date without a year means the most recent one."""
    candidates: list[tuple[int, dt.date | None]] = []
    for m in _ISO.finditer(text):
        candidates.append((m.start(), _safe_date(int(m.group(1)), int(m.group(2)), int(m.group(3)))))
    for m in _US.finditer(text):
        yy = m.group(3)
        year = int(yy) if len(yy) == 4 else (2000 + int(yy) if 2000 + int(yy) <= today.year else 1900 + int(yy))
        candidates.append((m.start(), _safe_date(year, int(m.group(1)), int(m.group(2)))))
    for m in _MDY.finditer(text):
        candidates.append((m.start(), _year_or_recent(m.group(3), _MONTHS[m.group(1)[:3].lower()], int(m.group(2)), today)))
    for m in _DMY.finditer(text):
        candidates.append((m.start(), _year_or_recent(m.group(3), _MONTHS[m.group(2)[:3].lower()], int(m.group(1)), today)))
    found = [d for _, d in sorted(candidates, key=lambda c: c[0]) if d is not None]
    if not found:
        return None
    return FoundDate(found[0], future=found[0] > today)


def parse_iso_date(value: Any) -> dt.date | None:
    if not isinstance(value, str):
        return None
    m = _ISO.fullmatch(value.strip())
    return _safe_date(int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


# ---------------------------------------------------------------- exam and police report (yes / no / not sure)

_EXAM = r"(?:forensic|sane|sart|rape kit|kit|exam|examination)"
_EXAM_KV = re.compile(rf"\b{_EXAM}\w*\s*[:=]?\s*(yes|no|not sure|unsure|unknown|maybe)\b", re.I)
_EXAM_UNSURE = re.compile(rf"\b(?:not sure|unsure|don'?t know|do not know|can'?t remember|maybe)\b[^.?!,;]{{0,40}}\b{_EXAM}", re.I)
_EXAM_NO = re.compile(rf"\b(?:no|not|didn'?t|did not|never|without|haven'?t|have not|wasn'?t|was not)\b[^.?!,;]{{0,30}}\b{_EXAM}", re.I)
_EXAM_YES = re.compile(rf"\b(?:had|got|have had|went for|went in for|i did)\b[^.?!,;]{{0,30}}\b{_EXAM}", re.I)

_REPORT = r"(?:police|cops?|law enforcement|report\w*)"
_REPORT_KV = re.compile(r"\b(?:police report|police|report(?:ed)?)\s*[:=]?\s*(yes|no|not yet|not sure|unsure|unknown)\b", re.I)
_REPORT_UNSURE = re.compile(rf"\b(?:not sure|unsure|don'?t know|do not know)\b[^.?!,;]{{0,40}}\b{_REPORT}", re.I)
_REPORT_NO = re.compile(
    rf"\b(?:no|not|didn'?t|did not|never|haven'?t|have not|without|not yet)\b[^.?!,;]{{0,30}}\b{_REPORT}|\bunreported\b", re.I
)
_REPORT_YES = re.compile(
    r"\b(?:i reported|we reported|reported it|reported to|filed a (?:police )?report|made a (?:police )?report|"
    r"went to the police|told the police|called the police|called 911)\b",
    re.I,
)

YES_WORDS = {"yes", "y", "true", "done", "had"}
NO_WORDS = {"no", "n", "false", "none", "not yet", "not_yet"}
UNSURE_WORDS = {"not sure", "not_sure", "unsure", "unknown", "maybe"}


def find_exam(text: str) -> str | None:
    """'yes', 'no', 'not_sure', or None when the message does not say."""
    kv = _EXAM_KV.search(text)
    if kv:
        v = kv.group(1).lower()
        return "yes" if v in YES_WORDS else "no" if v in NO_WORDS else "not_sure"
    if _EXAM_UNSURE.search(text):
        return "not_sure"
    if _EXAM_NO.search(text):
        return "no"
    if _EXAM_YES.search(text):
        return "yes"
    return None


def find_report(text: str) -> str | None:
    """'yes', 'no', 'unknown', or None. "Not yet" counts as no."""
    kv = _REPORT_KV.search(text)
    if kv:
        v = kv.group(1).lower()
        return "yes" if v in YES_WORDS else "no" if v in NO_WORDS else "unknown"
    if _REPORT_UNSURE.search(text):
        return "unknown"
    if _REPORT_NO.search(text):
        return "no"
    if _REPORT_YES.search(text):
        return "yes"
    return None


def exam_value(choice: Any) -> bool | None:
    """Card or text choice to the API's forensic_exam (true / false / null for not sure)."""
    if isinstance(choice, bool):
        return choice
    v = str(choice or "").strip().lower().replace("_", " ")
    return True if v in YES_WORDS else False if v in NO_WORDS else None


def report_value(choice: Any) -> str:
    if isinstance(choice, bool):
        return "yes" if choice else "no"
    v = str(choice or "").strip().lower().replace("_", " ")
    return "yes" if v in YES_WORDS else "no" if v in NO_WORDS else "unknown"


# ---------------------------------------------------------------- codes

_CODE_ONLY = re.compile(
    r"^\s*(?:(?:the\s+)?code(?:\s+is)?|confirm(?:ation)?(?:\s+code)?|pay|yes|ok(?:ay)?|it'?s|here)?\s*[:#,]?\s*(\d{3})[\s-]?(\d{3})\s*[.!]?\s*$",
    re.I,
)
_CODE_WORD = re.compile(r"\b(?:code|confirm\w*)\b\D{0,20}?(\d{3})[\s-]?(\d{3})(?!\d)", re.I)
_LINK = re.compile(r"\blink(?:\s+code)?\s*[:#]?\s*([2-9A-HJKMNP-Z]{4})[\s-]?([2-9A-HJKMNP-Z]{4})\b", re.I)


def find_confirm_code(text: str) -> str | None:
    """A 6-digit code the person typed: the whole message, or right after "code" or "confirm"."""
    m = _CODE_ONLY.match(text) or _CODE_WORD.search(text)
    return m.group(1) + m.group(2) if m else None


def find_link_code(text: str) -> str | None:
    m = _LINK.search(text)
    return f"{m.group(1)}-{m.group(2)}".upper() if m else None


# ---------------------------------------------------------------- what the person wants

_GREETING = re.compile(
    r"^\s*(?:hi|hello|hey|hiya|good (?:morning|afternoon|evening)|help|start|menu|options|"
    r"what can you do|what do you do|who are you|what is tend|how does this work)\b",
    re.I,
)
_DEMO = re.compile(
    r"\b(?:demo|rowan|example claim|sample claim|test claim|fictional (?:person|claim|survivor|persona)|"
    r"walk (?:me )?through (?:the |a |an )?(?:demo|claim|example|sample)|show (?:me )?(?:a|the) claim|see (?:a|the) claim)\b",
    re.I,
)
_PAY = re.compile(
    r"^\s*(?:yes[,.!]?\s*)?(?:please\s+)?(?:pay\b|make (?:the|a) payment|send (?:the )?payment)|"
    r"\bpay (?:the|that|this) (?:rest|bill|balance|remaining|hospital)\b|\bpay (?:it|now)\b",
    re.I,
)
_CHECK = re.compile(
    r"^\s*(?:please\s+)?(?:run\s+(?:a\s+|the\s+|my\s+)?)?check\b|\brun (?:a |the |my )?check\b|"
    r"\beligibility check\b|\bcheck (?:my )?eligibility\b",
    re.I,
)
_ELIGIBLE = re.compile(r"\b(?:am i eligible|eligib\w*|qualif\w*|can i (?:still )?(?:apply|file|get help)|could i apply)\b", re.I)
_CANCEL = re.compile(r"\b(?:cancel\w*|never ?mind|don'?t pay|do not pay|abort)\b", re.I)
_CANCEL_SHORT = re.compile(r"^\s*(?:stop|no thanks|quit|exit)\b", re.I)  # only as a short reply, not inside a question
_BILL_WORDS = re.compile(r"\b(?:bill|rest|balance|remaining)\b", re.I)
_YES = re.compile(
    r"^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|count (?:them|it|these|all)|go ahead|do it|please do|confirm(?:ed)?|approve\w*|y)\b",
    re.I,
)
_NO = re.compile(r"^\s*(?:no|nope|not now|skip|later|n)\b", re.I)
_PROSE_APPROVE = re.compile(r"\b(?:user|they|she|he)\s+(?:has\s+)?(?:approved|confirmed|accepted|clicked|chose|selected|picked)\b", re.I)
_PROSE_REJECT = re.compile(r"\b(?:user|they|she|he)\s+(?:has\s+)?(?:rejected|declined|cancel+ed|dismissed)\b", re.I)


def is_greeting(text: str) -> bool:
    return bool(_GREETING.search(text)) and len(text) < 48


def wants_demo(text: str) -> bool:
    return bool(_DEMO.search(text))


def wants_pay(text: str) -> bool:
    """Requests like "pay the bill" or "yes, pay it". A question like "Pay for therapy in Ohio?" is not one."""
    if "?" in text and not _BILL_WORDS.search(text):
        return False
    return bool(_PAY.search(text))


def wants_check(text: str) -> bool:
    return bool(_CHECK.search(text))


def asks_eligibility(text: str) -> bool:
    return bool(_ELIGIBLE.search(text))


def wants_cancel(text: str) -> bool:
    short = len(text) <= 24 and "?" not in text and bool(_CANCEL_SHORT.search(text))
    return bool(_CANCEL.search(text)) or short or bool(_PROSE_REJECT.search(text))


def says_yes(text: str) -> bool:
    """A plain yes ("yes", "ok", "count them"), or the planner reporting an approval. "OK, what about Ohio?" is a
    new question, not a yes."""
    if _PROSE_APPROVE.search(text):
        return True
    return "?" not in text and bool(_YES.search(text))


def says_no(text: str) -> bool:
    return "?" not in text and bool(_NO.search(text)) and not says_yes(text)


# ---------------------------------------------------------------- topics and expenses (for cited answers)

TOPICS: list[tuple[str, re.Pattern[str]]] = [
    (
        "excluded",
        re.compile(
            r"\b(?:not covered|exclud\w*|won'?t (?:pay|cover)|doesn'?t (?:pay|cover)|does not (?:pay|cover)|isn'?t covered)\b", re.I
        ),
    ),
    (
        "deadline",
        re.compile(
            r"\b(?:deadline|time limit|too late|how long do i have|how much time|statute of limitations?|when (?:do|must|should|can) i (?:apply|file))\b",
            re.I,
        ),
    ),
    ("reporting", re.compile(r"\b(?:police|cops?|law enforcement|report\w*)\b", re.I)),
    ("exam", re.compile(r"\b(?:forensic|rape kit|sane|exam\w*)\b", re.I)),
    ("time", re.compile(r"\b(?:processing|how long (?:does|will|until|before)|when will i (?:get|be paid|hear)|decision time)\b", re.I)),
    (
        "privacy",
        re.compile(
            r"\b(?:confidential\w*|privacy|private|anonym\w*|jane doe|my address|substitute address|find me|find out|safe at home)\b", re.I
        ),
    ),
    ("emergency", re.compile(r"\b(?:emergency award|emergency|advance|right away|urgent)\b", re.I)),
    ("minimum", re.compile(r"\b(?:minimum|at least|threshold|too small)\b", re.I)),
    ("insurance", re.compile(r"\b(?:insurance|insured|medicaid|medicare|copays?|deductibles?|payer of last resort)\b", re.I)),
    (
        "residency",
        re.compile(
            r"\b(?:residen\w*|citizen\w*|immigra\w*|undocumented|visa|social security|ssn|out of state|another state|live in)\b", re.I
        ),
    ),
    (
        "documents",
        re.compile(r"\b(?:documents?|paperwork|proof|receipts?|records?|what do i need to (?:send|bring|include)|attach\w*)\b", re.I),
    ),
    (
        "apply",
        re.compile(
            r"\b(?:how (?:do|can) i (?:apply|file)|where (?:do|can) i (?:apply|send|file|submit)|submit\w*|application|apply|mail|fax|email|online|portal)\b",
            re.I,
        ),
    ),
    ("max", re.compile(r"\b(?:how much|maximum|max|caps?|limits?|up to|the most)\b", re.I)),
    ("covered", re.compile(r"\b(?:cover\w*|pay for|pays for|reimburs\w*|what costs|what expenses|expenses|costs)\b", re.I)),
    ("eligibility", re.compile(r"\b(?:eligib\w*|qualif\w*|can i apply|who can apply|is sexual assault)\b", re.I)),
    ("contact", re.compile(r"\b(?:phone|call|contact|website|number|reach|talk to|address of the program)\b", re.I)),
]

EXPENSE_WORDS: list[tuple[str, re.Pattern[str]]] = [
    ("counseling", re.compile(r"\b(?:counsel\w*|therap\w*|psycholog\w*|mental health|psychiatr\w*)\b", re.I)),
    ("lost_wages", re.compile(r"\b(?:wages?|lost (?:pay|income|work|earnings)|missed work|time off|salary|paychecks?|earnings)\b", re.I)),
    ("transportation", re.compile(r"\b(?:rides?|uber|lyft|taxis?|bus|gas|mileage|transport\w*|travel|parking)\b", re.I)),
    ("temporary_housing", re.compile(r"\b(?:hotels?|motels?|shelters?|temporary housing|lodging|place to stay)\b", re.I)),
    ("relocation", re.compile(r"\b(?:mov(?:e|ing)|relocat\w*|security deposit|rent)\b", re.I)),
    ("security", re.compile(r"\b(?:locks?|alarms?|cameras?|deadbolts?|home security|security system)\b", re.I)),
    ("crime_scene_cleanup", re.compile(r"\b(?:clean ?up|cleaning)\b", re.I)),
    ("childcare", re.compile(r"\b(?:child ?care|babysit\w*|daycare)\b", re.I)),
    ("property_replacement", re.compile(r"\b(?:phones?|purses?|wallets?|laptops?|property|stolen|damaged)\b", re.I)),
    ("clothing_bedding", re.compile(r"\b(?:cloth\w*|bedding|sheets)\b", re.I)),
    ("prescription", re.compile(r"\b(?:prescriptions?|medications?|pharmacy|medicines?|meds|plan b|pep)\b", re.I)),
    ("dental", re.compile(r"\b(?:dental|dentists?|teeth|tooth)\b", re.I)),
    ("funeral", re.compile(r"\b(?:funerals?|burial)\b", re.I)),
    ("legal", re.compile(r"\b(?:lawyers?|attorneys?|legal)\b", re.I)),
    ("tuition", re.compile(r"\b(?:tuition|school|college)\b", re.I)),
    ("medical", re.compile(r"\b(?:medical|hospital|doctors?|er visit|emergency room|ambulance|surgery|health care)\b", re.I)),
]


def find_topics(text: str) -> list[str]:
    return [name for name, pattern in TOPICS if pattern.search(text)]


def find_expense(text: str) -> str | None:
    return next((name for name, pattern in EXPENSE_WORDS if pattern.search(text)), None)


# ---------------------------------------------------------------- privacy guard

_NARRATIVE = re.compile(
    r"\b(?:he|she|they|him)\s+(?:was|were|did|had|took|grabbed|hit|forced|attacked|raped|assaulted|touched|followed|drugged|pushed|choked)\b|"
    r"\b(?:raped|assaulted|attacked|molested|abused|drugged|strangled|choked|groped)\s+(?:me|my)\b|"
    r"\bmy (?:ex|boyfriend|girlfriend|husband|wife|partner|coworker|boss|roommate|neighbou?r|date|friend|uncle|stepdad)\b|"
    r"\b(?:it happened (?:at|in|on)|at (?:his|her|their) (?:place|house|apartment))\b",
    re.I,
)


def looks_like_story(text: str) -> bool:
    """True when someone starts telling what happened. Tend never needs it, so the agent says so and does
    not pass the message on."""
    return len(text) > 40 and bool(_NARRATIVE.search(text))


# ---------------------------------------------------------------- incoming message


@dataclass
class Incoming:
    text: str = ""
    selection: dict[str, Any] | None = None
    cancelled: bool = False
    card_id: str | None = None
    start: bool = False
    end: bool = False

    @property
    def empty(self) -> bool:
        return not self.text.strip() and self.selection is None and not self.cancelled


def selection_from_text(text: str) -> dict[str, Any] | None:
    """Direct @mentions deliver a card click as a JSON object in the text."""
    s = text.strip()
    if not (s.startswith("{") and s.endswith("}")):
        return None
    try:
        value = json.loads(s)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None
