"""Tend Navigator, as an Agentverse-hosted agent (always on).

GENERATED FILE. Do not edit by hand: it is built from agent/tend_agent by agent/scripts/build_hosted.py, and the
tests check that it matches. Paste the whole file into a new hosted agent on agentverse.ai (steps in
agent/AGENTVERSE.md).

What it does in one ASI:One chat: cited answers about crime victim compensation in all 50 states and DC (or "not in
the rules I have"), a Check, and a fictional demo claim run end to end: costs from Capital One's Nessie mock bank, the
forensic exam line held under the state's law with a letter to billing, the rest of the bill paid only after the
person types the server's 6-digit code, and an encrypted link for an advocate. It never asks for a name or a story.

Locally the Law and Bank+Packet desks are separate uAgents; here they run in this one process, calling the same
public Tend API. Allowed imports only: uagents, uagents_core, httpx, pycryptodome (or cryptography), and the
standard library.
"""

# The Tend deployment this agent calls. Change these two lines to point the agent somewhere else.
TEND_API_URL = "https://youreowed.tech"  # the API, served under /api
TEND_PUBLIC_URL = "https://youreowed.tech"  # the web app, where an advocate opens a share link


# ======================================================================== states.py
# The 51 jurisdictions Tend covers, and finding one in a sentence.

import re

STATES: dict[str, str] = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
    "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon",
    "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota",
    "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia",
    "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}  # fmt: skip

_ALIASES = {
    "washington dc": "DC", "washington d.c.": "DC", "washington d. c.": "DC", "washington, dc": "DC",
    "washington, d.c.": "DC", "d.c.": "DC", "district of columbia": "DC", "new york city": "NY", "nyc": "NY",
}  # fmt: skip

# Two-letter codes that are also everyday words or abbreviations (photo ID, MD, CT scan, VA benefits).
# They count only right after "in", "for", "state", or "check". "LA" usually means the city, so it never counts.
_AMBIGUOUS = {"OK", "HI", "ID", "IN", "ME", "OR", "AL", "MD", "PA", "CT", "MS", "VA", "MA", "DE", "CO"}
_NAME_ONLY = {"LA"}
_STATE_CONTEXT = re.compile(r"\b(?:in|for|state|st|of|check|about)\s*$", re.I)

_NAME_PATTERNS: list[tuple[re.Pattern[str], str]] = sorted(
    [(re.compile(rf"(?<![\w.]){re.escape(k)}(?![\w])"), v) for k, v in _ALIASES.items()]
    + [(re.compile(rf"\b{re.escape(name.lower())}\b"), code) for code, name in STATES.items()],
    key=lambda p: -len(p[0].pattern),
)
_CODE = re.compile(r"\b([A-Z]{2})\b")


def state_name(code: str | None) -> str:
    return STATES.get((code or "").upper(), code or "")


def find_states(text: str) -> list[str]:
    """Every jurisdiction named in the text, in reading order, without double counting
    (West Virginia is not also Virginia; Washington DC is not also Washington)."""
    if not text:
        return []
    low = text.lower()
    taken: list[tuple[int, int]] = []
    found: list[tuple[int, str]] = []
    for pattern, code in _NAME_PATTERNS:
        for m in pattern.finditer(low):
            if any(m.start() < e and s < m.end() for s, e in taken):
                continue
            taken.append((m.start(), m.end()))
            found.append((m.start(), code))
    shouting = sum(c.isupper() for c in text) > 0.6 * max(1, sum(c.isalpha() for c in text))
    if not shouting:
        for m in _CODE.finditer(text):
            code = m.group(1)
            if code not in STATES or code in _NAME_ONLY or any(m.start() < e and s < m.end() for s, e in taken):
                continue
            if code in _AMBIGUOUS and not _STATE_CONTEXT.search(text[: m.start()]):
                continue
            found.append((m.start(), code))
    # A message that is only a code ("mi", "check oh"). "ok" or "hi" alone is a reply, not a state.
    bare = re.fullmatch(r"\s*(check\s+)?([a-zA-Z]{2})[\s.!?]*", text)
    if bare and not found:
        code = bare.group(2).upper()
        if code in STATES and code not in _NAME_ONLY and (bare.group(1) or code not in _AMBIGUOUS):
            found.append((0, code))
    out: list[str] = []
    for _, code in sorted(found):
        if code not in out:
            out.append(code)
    return out


def find_state(text: str) -> str | None:
    states = find_states(text)
    return states[0] if states else None


# ======================================================================== fmt.py
# Plain words for money, expenses, dates, and law citations. Integer cents only.

import datetime as dt
import re
from typing import Any

EXPENSE_LABELS = {
    "medical": "Medical care",
    "forensic_exam": "Forensic exam",
    "counseling": "Counseling",
    "lost_wages": "Lost wages",
    "transportation": "Rides and travel to care",
    "relocation": "Moving",
    "temporary_housing": "A temporary place to stay",
    "security": "Locks and home security",
    "crime_scene_cleanup": "Cleanup",
    "childcare": "Child care",
    "property_replacement": "Replacing property",
    "clothing_bedding": "Clothing and bedding",
    "prescription": "Prescriptions",
    "dental": "Dental care",
    "funeral": "Funeral costs",
    "legal": "Legal help",
    "tuition": "Tuition",
    "other": "Other costs",
    "unknown": "Not sorted yet",
}

UNIT_WORDS = {
    "session": "a session",
    "week": "a week",
    "hour": "an hour",
    "mile": "a mile",
    "day": "a day",
    "month": "a month",
    "item": "per item",
}


# The sentence after a deadline the engines flag deadline_from_discovery (docs/SPEC.md v1.3): it is dated from the
# incident, the earliest discovery can be, so the true date may be later and a late may not be late. The web's words.
DISCOVERY_NOTE = (
    "This deadline may count from when the crime was discovered, which can be later than the date it happened. The program decides."
)


def money(cents: int) -> str:
    """$1,234.56 from integer cents."""
    if not isinstance(cents, int) or isinstance(cents, bool):
        raise TypeError("money takes integer cents")
    sign = "-" if cents < 0 else ""
    dollars, rest = divmod(abs(cents), 100)
    return f"{sign}${dollars:,}.{rest:02d}"


def money_short(cents: int) -> str:
    """$45,000 for whole dollars, $12.50 otherwise. For caps and limits."""
    text = money(cents)
    return text[:-3] if text.endswith(".00") else text


def expense_label(expense: str | None) -> str:
    return EXPENSE_LABELS.get(expense or "", (expense or "other").replace("_", " ").capitalize())


def long_date(value: str | dt.date | None) -> str:
    if value is None:
        return ""
    d = value if isinstance(value, dt.date) else dt.date.fromisoformat(str(value)[:10])
    return f"{d:%B} {d.day}, {d.year}"


def plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def clean(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def short_quote(quote: str, limit: int = 300) -> str:
    """The verbatim quote, cut at a word boundary with an ellipsis when long. The link has the full text."""
    q = clean(quote)
    if len(q) <= limit:
        return q
    cut = q[:limit].rsplit(" ", 1)[0].rstrip(",;:")
    return f"{cut} ..."


def cite_url(c: dict[str, Any]) -> str | None:
    for key in ("fragment_url", "url", "link", "source_url"):
        value = c.get(key)
        if isinstance(value, str) and value.startswith(("http://", "https://")):
            return value
    return None


def cite_label(c: dict[str, Any]) -> str:
    return clean(c.get("pinpoint") or c.get("source_title") or c.get("rule_id") or "Source")


def cite_link(c: dict[str, Any]) -> str:
    url = cite_url(c)
    label = cite_label(c)
    return f"[{label}]({url})" if url else label


def cite_block(c: dict[str, Any], *, with_quote: bool = True, limit: int = 300) -> str:
    """One rule: plain summary, the verbatim quote, and the pinpoint link."""
    summary = clean(c.get("summary"))
    lines = [f"{summary} ({cite_link(c)})" if summary else f"{cite_link(c)}:"]
    quote = clean(c.get("quote"))
    if with_quote and quote:
        lines.append(f'> "{short_quote(quote, limit)}"')
    return "\n".join(lines)


def program_line(program: dict[str, Any] | None, name: str | None = None) -> str:
    if not program:
        return ""
    bits = []
    title = clean(program.get("program_name")) or "Victim compensation program"
    if name:
        title = f"{name} {title}" if name.lower() not in title.lower() else title
    bits.append(f"**{title}**")
    if program.get("phone"):
        bits.append(f"phone {program['phone']}")
    site = program.get("apply_url") or program.get("website")
    if site:
        bits.append(f"[website]({site})")
    return ", ".join(bits)


# ======================================================================== parse.py
# Turning a message (typed, clicked, or relayed by the ASI:One planner) into structured fields.
#
# Only the fields are kept. The text itself is never stored or logged.

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


def find_confirm_code(text: str) -> str | None:
    """A 6-digit code the person typed: the whole message, or right after "code" or "confirm"."""
    m = _CODE_ONLY.match(text) or _CODE_WORD.search(text)
    return m.group(1) + m.group(2) if m else None


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
    r"^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|count (?:them|it|these|all)|go ahead|do it|please do|confirm(?:ed)?|approve\w*|continue|y)\b",
    re.I,
)
_NO = re.compile(r"^\s*(?:no|nope|not now|skip|later|n)\b", re.I)
_SHARE = re.compile(
    r"\bshare\b|\blink for (?:an |the |my )?advocate\b|\b(?:the|my|this) packet\b|"
    r"\b(?:make|build|create|send|give me|get)\b[^.?!]{0,30}\b(?:link|packet)\b",
    re.I,
)
_STATUS = re.compile(
    r"\b(?:check|status of|what happened to)\b[^.?!]{0,20}\bpayment\b|\bpayment status\b|\b(?:did|has) (?:it|the payment) go(?:ne)? through\b",
    re.I,
)
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


def wants_share(text: str) -> bool:
    """Requests like "share with an advocate", "make the link", or "send the packet". A question counts only when
    it says share."""
    if "?" in text and not re.search(r"\bshare\b", text, re.I):
        return False
    return bool(_SHARE.search(text))


def wants_payment_status(text: str) -> bool:
    return bool(_STATUS.search(text))


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

# An act described in the first or third person. Caught at any length: "he raped me" is short.
_ACT = re.compile(
    r"\b(?:he|she|they|him|someone|somebody|a guy|a man|a woman)\s+(?:took|grabbed|hit|forced|attacked|raped|assaulted|touched|"
    r"followed|drugged|pushed|choked|strangled|molested|groped|abused|hurt|beat)\b|"
    r"\b(?:raped|assaulted|attacked|molested|abused|drugged|strangled|choked|groped|hit|hurt|beat|touched)\s+(?:me|my)\b|"
    r"\bi was (?:raped|assaulted|attacked|molested|abused|drugged|strangled|choked|groped)\b",
    re.I,
)
# Who or where. Only in longer messages, since "Can my partner apply?" is a fair question.
_CONTEXT = re.compile(
    r"\b(?:he|she|they|him)\s+(?:was|were|did|had)\b|"
    r"\bmy (?:ex|boyfriend|girlfriend|husband|wife|partner|coworker|boss|roommate|neighbou?r|date|friend|uncle|stepdad)\b|"
    r"\bit happened (?:at|in)\b|\bit happened on (?!(?:\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))|"
    r"\bat (?:his|her|their) (?:place|house|apartment)\b",
    re.I,
)


# Details that identify a person: a name, a home address, an email, a phone number, a Social Security number.
_IDENTITY = re.compile(
    r"\bmy (?:full |real |legal )?name(?:'s| is)\b|\bi(?:'m| am) (?:called|named)\b|\bcall me [A-Z]|"
    r"\bi live (?:at|on)\b|\bmy (?:home )?address\b|\bmy (?:birthday|date of birth|dob)\b|"
    r"\b\d{1,5} [A-Za-z]+(?: [A-Za-z]+)? (?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court)\b|"
    r"[\w.+-]+@[\w-]+\.[\w.]+|\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b|\b\d{3}-\d{2}-\d{4}\b",
    re.I,
)


def story_kind(text: str) -> str | None:
    """'act' when someone describes what was done to them, 'identity' when a message carries a name, an address,
    or a way to reach someone, 'context' when a longer message names who or where, else None. Either way the
    message is not passed on."""
    if _ACT.search(text):
        return "act"
    if _IDENTITY.search(text):
        return "identity"
    if len(text) > 40 and _CONTEXT.search(text):
        return "context"
    return None


def looks_like_story(text: str) -> bool:
    """True when someone starts telling what happened. Tend never needs it, so the agent does not pass the
    message on."""
    return story_kind(text) is not None


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


# ======================================================================== knowledge.py
# Cited answers built only from a state's verified rules (GET /api/jurisdictions/{st}).
#
# Used when the API's /api/agent/answer is missing or fails. Every sentence points at a rule with a verbatim quote,
# and when no rule covers the question the answer says it is not in the rules instead of guessing.

from dataclasses import dataclass, field
from typing import Any


CLAIM_PERS = {"claim", "residence", "crime_scene", None, ""}
TOPIC_CATEGORIES = {
    "deadline": ("filing_deadline",),
    "reporting": ("reporting_requirement",),
    "exam": ("exam_no_bill", "exam_payment"),
    "time": ("processing_time",),
    "privacy": ("address_confidentiality", "record_confidentiality"),
    "emergency": ("emergency_award",),
    "minimum": ("minimum_loss",),
    "insurance": ("collateral_source",),
    "residency": ("residency",),
    "documents": ("required_document",),
    "apply": ("submission",),
    "max": ("total_cap", "expense_cap"),
    "covered": ("covered_expense",),
    "excluded": ("excluded_expense",),
    "eligibility": ("eligible_crime", "residency"),
}
TOPIC_INTROS = {
    "deadline": "Here is the deadline to apply in {name}.",
    "reporting": "Here is what {name} says about a police report.",
    "exam": "Here is what {name} says about forensic exam bills.",
    "time": "Here is how long {name} says a decision takes.",
    "privacy": "{name} has these privacy protections.",
    "emergency": "Here is what {name} says about an emergency award.",
    "minimum": "Here is what {name} says about a minimum loss.",
    "insurance": "The {name} program pays after insurance and other sources.",
    "residency": "Here is who can apply in {name}.",
    "documents": "The {name} program asks for these documents.",
    "apply": "Here is how to apply in {name}.",
    "max": "Here are the limits in {name}.",
    "covered": "The {name} program lists these costs as covered.",
    "excluded": "The {name} program lists these as not covered.",
    "eligibility": "Here is what {name} says about who can apply.",
}
TOPIC_ABOUT = {
    "deadline": "the deadline to apply",
    "reporting": "police reports",
    "exam": "forensic exam bills",
    "time": "how long a decision takes",
    "privacy": "privacy protections",
    "emergency": "emergency awards",
    "minimum": "a minimum loss",
    "insurance": "insurance",
    "residency": "who can apply",
    "documents": "the documents to send",
    "apply": "how to apply",
    "max": "limits",
    "covered": "covered costs",
    "excluded": "costs that are not covered",
    "eligibility": "who can apply",
    "contact": "how to contact the program",
}
MAX_QUOTED = 3


@dataclass
class Answer:
    st: str
    known: bool
    text: str
    citations: list[dict[str, Any]] = field(default_factory=list)


def rule_expense(rule: dict[str, Any]) -> str | None:
    return rule.get("expense") or (rule.get("params") or {}).get("expense")


def cite(rule: dict[str, Any], sources: dict[str, dict[str, Any]]) -> dict[str, Any]:
    source = sources.get(rule.get("source_id", ""), {})
    return {
        "rule_id": rule.get("id"),
        "category": rule.get("category"),
        "pinpoint": rule.get("pinpoint"),
        "summary": rule.get("summary"),
        "quote": rule.get("quote"),
        "fragment_url": rule.get("fragment_url"),
        "source_url": source.get("url"),
        "source_title": source.get("title"),
    }


def applies_to(rule: dict[str, Any]) -> str:
    """Who or what a rule is limited to, as written (for example, family members, or crimes after a date)."""
    who = (rule.get("params") or {}).get("applies_to")
    if not who:
        return ""
    return clean(", ".join(map(str, who)) if isinstance(who, list) else str(who)).replace("_", " ")


def cap_phrase(rule: dict[str, Any]) -> str | None:
    params = rule.get("params") or {}
    amount = params.get("amount_cents")
    if not isinstance(amount, int):
        return None
    per = params.get("per")
    if per in CLAIM_PERS:
        text = f"up to {money_short(amount)}"
    else:
        unit = UNIT_WORDS.get(per)
        text = f"up to {money_short(amount)} {unit}" if unit else f"up to {money_short(amount)} per {per}"
    if isinstance(params.get("count_limit"), int):
        text += f", for up to {plural(params['count_limit'], str(per))}"
    who = applies_to(rule)
    if who:
        text += f" (for {who})"
    return text


def best_cap(rules: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The most generous cap that applies to the survivor, to show in a short list. Rules limited to someone
    else (family members, a date range) count only when nothing else exists."""
    caps = [r for r in rules if isinstance((r.get("params") or {}).get("amount_cents"), int)]
    plain = [r for r in caps if not applies_to(r)] or caps
    return max(plain, key=lambda r: r["params"]["amount_cents"]) if plain else None


def short_cap(caps: list[dict[str, Any]]) -> str:
    """For a one-line list: the most generous limit, and a note when the law sets more than one."""
    best = best_cap(caps)
    if best is None:
        return ""
    phrase = cap_phrase(best) or ""
    amounts = {(r.get("params") or {}).get("amount_cents") for r in caps if not applies_to(r)}
    return f"{phrase}, limits vary" if len(amounts) > 1 else phrase


def total_caps(rules: list[dict[str, Any]]) -> list[tuple[dict[str, Any], str]]:
    """(rule, "who it is for") for the total cap to show. Like the engine, the smallest cap that applies to
    everyone wins (a larger one is usually an exception, like catastrophic injury). When every cap is limited
    to some case (a crime date, a kind of injury), each one is listed with its case."""
    caps = [r for r in rules if isinstance((r.get("params") or {}).get("amount_cents"), int)]
    plain = [r for r in caps if not applies_to(r)]
    if plain:
        return [(min(plain, key=lambda r: r["params"]["amount_cents"]), "")]
    return [(r, applies_to(r)) for r in caps]


class RuleBook:
    def __init__(self, doc: dict[str, Any]):
        self.doc = doc
        self.st = str(doc.get("jurisdiction", ""))
        self.name = str(doc.get("name") or self.st)
        self.rules: list[dict[str, Any]] = list(doc.get("rules") or [])
        self.sources = {s.get("id"): s for s in doc.get("sources") or []}
        self.by_id = {r.get("id"): r for r in self.rules}

    def of(self, *categories: str, expense: str | None = None) -> list[dict[str, Any]]:
        out = [r for r in self.rules if r.get("category") in categories]
        if expense is not None:
            out = [r for r in out if rule_expense(r) == expense]
        return out

    def cites(self, rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [cite(r, self.sources) for r in rules]

    def summary(self, rule_id: str) -> str:
        return clean((self.by_id.get(rule_id) or {}).get("summary"))

    def covered_list(self) -> list[tuple[str, str, dict[str, Any], str]]:
        """(expense, label, first covering rule, short limit text) for each covered expense, in rule order.
        Rules limited to someone other than the survivor are left out of this short list."""
        out = []
        for expense in dict.fromkeys(rule_expense(r) for r in self.of("covered_expense") if not applies_to(r)):
            if not expense:
                continue
            first = next(r for r in self.of("covered_expense", expense=expense) if not applies_to(r))
            label = expense_label(expense)
            item = clean((first.get("params") or {}).get("item"))
            if expense == "other" and item:
                label = item[0].upper() + item[1:]
            out.append((expense, label, first, short_cap(self.of("expense_cap", expense=expense))))
        return out


def _blocks(cites: list[dict[str, Any]]) -> str:
    quoted = [cite_block(c) for c in cites[:MAX_QUOTED]]
    more = [cite_link(c) for c in cites[MAX_QUOTED:]]
    text = "\n\n".join(quoted)
    if more:
        text += "\n\nMore: " + ", ".join(more)
    return text


NOT_IN_RULES = "That's not in the rules I have."


def _dated(rule: dict[str, Any]) -> bool:
    params = rule.get("params") or {}
    return any(isinstance(params.get(k), int) for k in ("years", "months", "days"))


def report_note(book: RuleBook | None) -> str:
    """The sentence after a deadline the engine flags as counting from the police report. In some states that is the
    main rule (Washington, North Dakota). In others it is one narrow case, usually a survivor who was a child, while
    the main deadline counts from the crime (Michigan, Kansas, Minnesota, Mississippi). Then the note names that case
    and cites it, instead of telling an adult they may have longer."""
    lead = "This is measured from the date it happened."
    rules = book.of("filing_deadline") if book is not None else []
    from_report = [r for r in rules if (r.get("params") or {}).get("from") == "report"]
    main_from_crime = any((r.get("params") or {}).get("from") == "crime" and _dated(r) for r in rules)
    if book is None or not from_report:
        return f"{lead} In some cases the law counts from the police report instead, so ask the program."
    if not main_from_crime:
        return f"{lead} The law counts from the police report, so you may have longer."
    rule = from_report[0]
    return f"{lead} In one case {book.name}'s law counts from the police report instead ({cite_link(cite(rule, book.sources))}): {clean(rule.get('summary'))}"


def deadline_notes(flags: Any, book: RuleBook | None) -> str:
    """The sentences after a deadline for its flags, each after a space, in flag order; "" when there are none. A
    deadline counted from the report or from discovery is dated from the incident (docs/SPEC.md v1.3), so a late with
    either flag is never shown as plainly late."""
    have = {str(f) for f in flags or []}
    out = ""
    if "deadline_from_report" in have:
        out += " " + report_note(book)
    if "deadline_from_discovery" in have:
        out += " " + DISCOVERY_NOTE
    return out


def _unknown(book: RuleBook, about: str) -> Answer:
    contact = program_line(book.doc.get("program"), book.name)
    text = f"{NOT_IN_RULES} I found no verified {book.name} rule about {about}, so I won't guess."
    if contact:
        text += f" The program can answer it: {contact}."
    return Answer(book.st, False, text)


def expense_answer(book: RuleBook, expense: str) -> Answer:
    label = expense_label(expense).lower()
    covered = book.of("covered_expense", expense=expense)
    caps = book.of("expense_cap", expense=expense)
    excluded = book.of("excluded_expense", expense=expense)
    if covered or caps:
        parts = [f"The {book.name} program lists **{label}** as a covered cost."]
        phrases = [p for p in (cap_phrase(r) for r in caps) if p]
        if phrases:
            parts.append("Limits in the law: " + "; ".join(dict.fromkeys(phrases)) + ".")
        rules = covered + caps
        text = " ".join(parts) + "\n\n" + _blocks(book.cites(rules))
        if excluded:
            text += "\n\nSome of these costs are not covered:\n\n" + _blocks(book.cites(excluded))
        return Answer(book.st, True, text, book.cites(rules + excluded))
    if excluded:
        text = f"The {book.name} program lists this as **not covered**.\n\n" + _blocks(book.cites(excluded))
        return Answer(book.st, True, text, book.cites(excluded))
    return _unknown(book, f"whether {label} is covered")


def topic_answer(book: RuleBook, topic: str) -> Answer | None:
    if topic == "contact":
        contact = program_line(book.doc.get("program"), book.name)
        return Answer(book.st, True, f"Contact: {contact}.") if contact else None
    rules = book.of(*TOPIC_CATEGORIES.get(topic, ()))
    if not rules:
        return None
    intro = TOPIC_INTROS[topic].format(name=book.name)
    if topic == "covered":
        lines = []
        for _expense, label, first, limit in book.covered_list():
            lines.append(f"- {label}{', ' + limit if limit else ''} ({cite_link(cite(first, book.sources))})")
        return Answer(book.st, True, intro + "\n\n" + "\n".join(lines), book.cites(rules))
    if topic == "max":
        totals = book.of("total_cap")
        text = intro
        if totals:
            shown = total_caps(totals)
            if len(shown) == 1 and not shown[0][1]:
                text += f" The most the program pays in total is **{money_short(shown[0][0]['params']['amount_cents'])}**."
            elif shown:
                text += (
                    " The most the program pays in total depends on the case: "
                    + "; ".join(f"**{money_short(r['params']['amount_cents'])}** for {who}" for r, who in shown)
                    + "."
                )
            text += "\n\n" + _blocks(book.cites([r for r, _ in shown] + [r for r in totals if r not in [x for x, _ in shown]]))
        caps = [r for r in book.of("expense_cap") if cap_phrase(r)]
        if caps:
            text += "\n\nSome costs have their own limits:\n" + "\n".join(
                f"- {expense_label(rule_expense(r))}: {cap_phrase(r)} ({cite_link(cite(r, book.sources))})" for r in caps
            )
        return Answer(book.st, True, text, book.cites(totals + caps))
    if topic == "documents":
        general = [r for r in rules if not rule_expense(r)] or rules
        lines = [f"- {clean(r.get('summary'))} ({cite_link(cite(r, book.sources))})" for r in general[:8]]
        extra = len(rules) - len(lines)
        tail = f"\n\nThere are {plural(extra, 'more item')} for specific costs." if extra > 0 else ""
        return Answer(book.st, True, intro + "\n\n" + "\n".join(lines) + tail, book.cites(general[:8]))
    if topic == "apply":
        lines = []
        for r in rules:
            params = r.get("params") or {}
            how = str(params.get("method") or "").replace("_", " ")
            target = clean(params.get("target"))
            lines.append(f"- {how.capitalize()}: {target} ({cite_link(cite(r, book.sources))})" if how else f"- {clean(r.get('summary'))}")
        contact = program_line(book.doc.get("program"), book.name)
        tail = f"\n\nQuestions: {contact}." if contact else ""
        return Answer(book.st, True, intro + "\n\n" + "\n".join(lines) + tail, book.cites(rules))
    return Answer(book.st, True, intro + "\n\n" + _blocks(book.cites(rules)), book.cites(rules))


def answer_from_rules(doc: dict[str, Any], question: str = "", *, topics: list[str] | None = None, expense: str | None = None) -> Answer:
    book = RuleBook(doc)
    topics = topics if topics is not None else find_topics(question)
    expense = expense if expense is not None else find_expense(question)
    if "exam" in topics or expense == "forensic_exam":
        found = topic_answer(book, "exam")
        return found or _unknown(book, "forensic exam bills")
    if expense and (not topics or topics[0] in ("covered", "max", "excluded", "eligibility")):
        return expense_answer(book, expense)
    if topics:
        # Answer the main question or say "I don't know". Never swap in an answer to a different question.
        return topic_answer(book, topics[0]) or _unknown(book, TOPIC_ABOUT.get(topics[0], topics[0].replace("_", " ")))
    return Answer(
        book.st,
        False,
        f"{NOT_IN_RULES} I won't guess about {book.name}. I can answer questions about the deadline, police reports, "
        "forensic exam bills, what costs are covered, limits, documents, how to apply, and privacy.",
    )


# ======================================================================== check.py
# Rendering a Check: deadline, police report, exam bills, covered costs, limits, and the program. Every line cited.

from typing import Any


ALTERNATIVES = {
    "forensic_exam": "a forensic exam",
    "protective_order": "a protective order",
    "advocate": "talking with an advocate",
    "medical_provider": "telling a medical provider",
    "other": "other options the program accepts",
}


def _first(cites: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    return cites[0] if cites else None


def _with_summary(c: dict[str, Any] | None, book: RuleBook | None) -> dict[str, Any] | None:
    if c is None:
        return None
    if book is not None and not c.get("summary") and c.get("rule_id"):
        c = {**c, "summary": book.summary(c["rule_id"])}
    return c


def _alternatives(book: RuleBook | None) -> list[str]:
    if book is None:
        return []
    found: list[str] = []
    for r in book.of("reporting_requirement"):
        for alt in (r.get("params") or {}).get("alternatives") or []:
            label = ALTERNATIVES.get(alt, str(alt).replace("_", " "))
            if label not in found:
                found.append(label)
    return found


def _rule_with_alt(cites: list[dict[str, Any]], book: RuleBook | None, alt: str) -> dict[str, Any] | None:
    if book is None:
        return _first(cites)
    for c in cites:
        rule = book.by_id.get(c.get("rule_id"))
        if rule and alt in ((rule.get("params") or {}).get("alternatives") or []):
            return c
    return _first(cites)


def _requiring_rule(cites: list[dict[str, Any]], book: RuleBook | None) -> dict[str, Any] | None:
    """The rule that asks for a report (required, with no alternatives), else the first one."""
    if book is not None:
        for c in cites:
            params = (book.by_id.get(c.get("rule_id")) or {}).get("params") or {}
            if params.get("required") and not params.get("alternatives"):
                return c
    return _first(cites)


def deadline_section(check: dict[str, Any], book: RuleBook | None, *, have_date: bool = False, name: str = "") -> str:
    cites = check.get("citations") or []
    status = check.get("status")
    date = check.get("deadline_date")
    main = _with_summary(_first(cites), book)
    where = f" for {name}" if name else ""
    if status == "ok" and date:
        head = f"**Deadline:** apply by **{long_date(date)}**."
    elif status == "late" and date:
        head = (
            f"**Deadline:** the usual deadline was **{long_date(date)}**. Some programs allow more time for a good "
            "reason, so it is still worth calling."
        )
    elif not cites:
        head = f"**Deadline:** I could not find a verified filing deadline{where}. Ask the program how long you have."
    elif have_date:
        # The date was given but the rules do not reduce to one day (for example, a deadline in months).
        head = "**Deadline:** I could not work out the exact day from the verified rules. Read the rule below, or ask the program."
    else:
        head = "**Deadline:** counted from the date it happened. Tell me the date (only the date) for the exact day."
    head += deadline_notes(check.get("flags"), book)
    return head + ("\n" + cite_block(main) if main else "")


def reporting_section(
    check: dict[str, Any], if_exam: dict[str, Any] | None, *, exam: bool | None, report: str, book: RuleBook | None, name: str
) -> str:
    cites = check.get("citations") or []
    status = check.get("status")
    alts = _alternatives(book)
    if status == "satisfied" and report == "yes":
        head, c = "**Police report:** you reported it, so this part is met.", _first(cites)
    elif status == "satisfied":
        head, c = "**Police report:** your forensic exam counts in place of a police report.", _rule_with_alt(cites, book, "forensic_exam")
    elif status == "not_required":
        head, c = "**Police report:** not required.", _first(cites)
    elif exam is None and if_exam and if_exam.get("status") == "satisfied":
        # Not sure about the exam: the API answered both ways, so say both.
        head = (
            "**Police report:** if you had a forensic exam, it counts in place of a police report. "
            f"If not, {name} usually asks for a report."
        )
        c = _rule_with_alt(cites or if_exam.get("citations") or [], book, "forensic_exam")
    elif status == "required":
        head = f"**Police report:** {name} asks for one."
        if alts:
            head += f" These can count instead: {', '.join(alts)}."
        c = _requiring_rule(cites, book)
    elif cites and alts:
        head = f"**Police report:** it may be needed. These can count instead: {', '.join(alts)}. Read the rule, or ask the program."
        c = _first(cites)
    elif cites:
        head, c = "**Police report:** the rules here have conditions. Read the rule, or ask the program.", _first(cites)
    else:
        return "**Police report:** I could not find a verified rule about this. Ask the program."
    c = _with_summary(c, book)
    return head + ("\n" + cite_block(c) if c else "")


def exam_section(exam_billing: dict[str, Any] | None, book: RuleBook | None) -> str:
    protection = (exam_billing or {}).get("protection") or []
    if not protection:
        return ""
    c = _with_summary(protection[0], book)
    return "**Exam bills:** you should not get a bill for a forensic exam.\n" + cite_block(c)


def covered_section(data: dict[str, Any], book: RuleBook | None) -> str:
    items: list[str] = []
    if book is not None:
        for _expense, label, _first, limit in book.covered_list():
            items.append(f"{label} ({limit})" if limit else label)
    else:
        items = [expense_label(c.get("expense")) for c in data.get("covered") or []]
    if not items:
        return ""
    return "**Covered costs:** " + ", ".join(items) + "."


def total_section(book: RuleBook | None) -> str:
    if book is None:
        return ""
    shown = total_caps(book.of("total_cap"))
    if not shown:
        return ""
    if len(shown) == 1 and not shown[0][1]:
        rule = shown[0][0]
        amount = money_short(rule["params"]["amount_cents"])
        return f"**Most you can ask for:** {amount} in total ({cite_link(cite(rule, book.sources))}). The program decides."
    cases = "; ".join(
        f"{money_short(r['params']['amount_cents'])} for {who} ({cite_link(cite(r, book.sources))})"
        if who
        else f"{money_short(r['params']['amount_cents'])} ({cite_link(cite(r, book.sources))})"
        for r, who in shown
    )
    return f"**Most you can ask for:** it depends on the case: {cases}. The program decides."


def sentences_section(data: dict[str, Any]) -> str:
    out = []
    for s in data.get("sentences") or []:
        if not isinstance(s, dict) or not s.get("text"):
            continue
        links = ", ".join(cite_link(c) for c in s.get("citations") or [] if isinstance(c, dict))
        out.append(f"- {clean(s['text'])}" + (f" ({links})" if links else ""))
    return "\n".join(out)


def render_check(
    data: dict[str, Any],
    book: RuleBook | None,
    *,
    st: str,
    name: str,
    incident_date: str | None,
    exam: bool | None,
    report: str,
    app_url: str = "",
) -> str:
    deadline = data.get("deadline") or {}
    late = deadline.get("status") == "late"
    if late and "deadline_from_discovery" in (deadline.get("flags") or []):
        # Counted from discovery, a late may not be late (docs/SPEC.md v1.3).
        opener = f"**{name}: the usual deadline has passed, but you may have more time. Ask the program.**"
    elif late:
        opener = f"**{name}: the usual deadline has passed, but ask the program about more time.**"
    else:
        opener = f"**You can likely apply in {name}.** The program decides."
    told = []
    if incident_date:
        told.append(f"date {long_date(incident_date)}")
    told.append({True: "had an exam", False: "no exam"}.get(exam, "exam not sure"))
    told.append({"yes": "reported", "no": "not reported yet"}.get(report, "report not sure"))
    parts = [opener, f"_Based on: {name}, {', '.join(told)}. These answers are not saved._"]
    sentences = sentences_section(data)
    if sentences:
        parts.append(sentences)
    if deadline:
        parts.append(deadline_section(deadline, book, have_date=bool(incident_date), name=name))
    if data.get("reporting"):
        parts.append(reporting_section(data["reporting"], data.get("reporting_if_exam"), exam=exam, report=report, book=book, name=name))
    total = total_section(book)
    for section in (exam_section(data.get("exam_billing"), book), covered_section(data, book), total):
        if section:
            parts.append(section)
    program = program_line(data.get("program") or (book.doc.get("program") if book else None), name)
    if program:
        parts.append(f"**Program:** {program}.")
    # Every amount someone can ask for carries "The program decides." Said once, next to the amount when there is one.
    tail = "Rules can have exceptions." if total else "Rules can have exceptions. The program decides."
    if app_url:
        tail += f" To find costs the program can repay, open Tend on your own device: {app_url}"
    parts.append(tail)
    return "\n\n".join(p for p in parts if p)


# ======================================================================== settings.py
# Settings shared by every Tend agent. Plain values only, so the Agentverse-hosted build can set them from constants.

import os
from dataclasses import dataclass

PUBLIC_SITE = "https://youreowed.tech"


def _flag(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    api_url: str = "http://127.0.0.1:8000"
    app_url: str = ""  # the Tend web app; share links open there (default: the API's own origin)
    port: int = 8001
    handle: str | None = None
    demo_persona: str = "rowan-mi"
    agent_key: str = ""
    timeout_s: float = 30.0
    share_hours: int = 72
    # Navigator -> sub-agent calls: seconds per attempt and how many attempts before the fallback message.
    law_timeout_s: float = 15.0
    bank_timeout_s: float = 25.0
    attempts: int = 2
    subagent_mailbox: bool = False  # also list the Law and Bank agents on Agentverse (connect each once)

    @property
    def share_origin(self) -> str:
        """Where an advocate opens a share link. The web app and the API share one origin in production."""
        return (self.app_url or self.api_url).rstrip("/")

    @property
    def app_origin(self) -> str:
        """The web app to point people at after a Check: TEND_PUBLIC_URL, or the API's origin unless it is local."""
        if self.app_url:
            return self.app_url.rstrip("/")
        local = any(host in self.api_url for host in ("127.0.0.1", "localhost"))
        return "" if local else self.api_url.rstrip("/")

    @classmethod
    def from_env(cls) -> "Settings":  # noqa: UP037 - quoted: the hosted build evaluates annotations eagerly
        env = os.environ
        return cls(
            api_url=env.get("TEND_API_URL", cls.api_url).rstrip("/"),
            app_url=env.get("TEND_PUBLIC_URL", "").rstrip("/"),
            port=int(env.get("AGENT_PORT", cls.port)),
            handle=env.get("AGENT_HANDLE") or None,
            demo_persona=env.get("TEND_DEMO_PERSONA", cls.demo_persona),
            agent_key=env.get("TEND_AGENT_KEY", ""),
            timeout_s=float(env.get("TEND_API_TIMEOUT", cls.timeout_s)),
            share_hours=int(env.get("TEND_SHARE_HOURS", cls.share_hours)),
            law_timeout_s=float(env.get("TEND_LAW_TIMEOUT", cls.law_timeout_s)),
            bank_timeout_s=float(env.get("TEND_BANK_TIMEOUT", cls.bank_timeout_s)),
            attempts=max(1, int(env.get("TEND_AGENT_ATTEMPTS", cls.attempts))),
            subagent_mailbox=_flag(env.get("TEND_SUBAGENT_MAILBOX")),
        )


# ======================================================================== cards.py
# ASI:One Interactive Cards as plain payloads (card_protocol_version 1).
#
# Built as dicts so the same code runs as an Agentverse-hosted agent, whatever uagents-core version is installed
# there. tests/test_cards.py validates every payload against the schemas in uagents_core.

from dataclasses import dataclass
from typing import Any



@dataclass(frozen=True)
class Card:
    kind: str  # detail | form | review
    payload: dict[str, Any]

    @property
    def title(self) -> str:
        return str(self.payload.get("title") or "")


def _cta(label: str, selection: dict[str, Any], primary: bool = False) -> dict[str, Any]:
    return {"label": label, "selection": selection, "primary": primary}


def _rows(rows: list[tuple[str, str]]) -> list[dict[str, str]]:
    return [{"label": label, "value": value} for label, value in rows]


def welcome_card() -> Card:
    return Card(
        "detail",
        {
            "title": "Tend Navigator",
            "summary_rows": _rows(
                [
                    ("Ask", "Questions about any state's program, answered with the law quoted"),
                    ("Check", "Deadline, police report rules, and what is covered (2 minutes)"),
                    ("Demo", "A fictional claim: a held bill line, a mock payment you approve, and a locked link"),
                    ("Privacy", "No account, no name, no story. I never ask what happened."),
                ]
            ),
            "ctas": [_cta("Run a Check", {"action": "check_form"}, True), _cta("See the demo claim", {"action": "demo"})],
        },
    )


def check_form(st: str | None = None) -> Card:
    states = sorted(STATES.items(), key=lambda kv: kv[1])
    if st in STATES:  # the state they named goes first, so it is one tap
        states.sort(key=lambda kv: kv[0] != st)

    def options(*pairs: tuple[str, str]) -> list[dict[str, str]]:
        return [{"value": v, "label": label} for v, label in pairs]

    return Card(
        "form",
        {
            "title": "Check (about 2 minutes, nothing saved)",
            "fields": [
                {"name": "st", "kind": "select", "label": "State", "required": True, "options": options(*states)},
                {
                    "name": "incident_date",
                    "kind": "text",
                    "label": "Date it happened (only the date)",
                    "required": False,
                    "placeholder": "YYYY-MM-DD, or leave blank",
                },
                {
                    "name": "forensic_exam",
                    "kind": "select",
                    "label": "Had a forensic exam?",
                    "required": False,
                    "options": options(("yes", "Yes"), ("no", "No"), ("not_sure", "Not sure")),
                },
                {
                    "name": "police_report",
                    "kind": "select",
                    "label": "Reported to police?",
                    "required": False,
                    "options": options(("yes", "Yes"), ("no", "No"), ("not_yet", "Not yet")),
                },
            ],
            "submit_cta": _cta("Run the Check", {"action": "check"}, True),
        },
    )


def count_costs_card(groups: list[dict[str, Any]], bill: dict[str, Any] | None, *, scan_id: str) -> Card:
    rows = [(expense_label(g["expense"]), f"{plural(g['count'], 'charge')}, {money(g['cents'])}") for g in groups]
    if bill:
        rows.append(("Hospital bill (itemized)", f"{plural(bill['lines'], 'line')}, {money(bill['total_cents'])}"))
    rows.append(("Data", "Fictional person on Capital One's Nessie mock bank"))
    return Card(
        "review",
        {
            "title": "Count these costs for the demo claim?",
            "summary_rows": _rows(rows),
            "approve_cta": _cta("Yes, count them", {"action": "count_costs", "scan_id": scan_id}, True),
            "reject_cta": _cta("Not now", {"action": "skip_costs", "scan_id": scan_id}),
        },
    )


def next_steps_card(payable_cents: int, *, paid: bool) -> Card:
    ctas = []
    if payable_cents and not paid:
        ctas.append(_cta(f"Pay the {money(payable_cents)} left on the bill", {"action": "pay"}, True))
    ctas.append(_cta("Make a locked link for an advocate", {"action": "share"}, not ctas))
    rows = [("Held by law", "The forensic exam line stays unpaid"), ("Data", "Fictional, on a mock bank")]
    return Card("detail", {"title": "What next?", "summary_rows": _rows(rows), "ctas": ctas})


def payment_card(p: dict[str, Any]) -> Card:
    rows = [
        ("Pay to", p["payee_label"]),
        ("Amount", money(p["amount_cents"])),
        ("From", p["from_label"]),
        ("Pays", p["lines_label"]),
    ]
    if p.get("held_cents"):
        rows.append(("Not paid", f"Forensic exam line, {money(p['held_cents'])} (held by law)"))
    rows += [
        ("Confirm code", p["code"]),
        ("Code ends", "in 10 minutes, works once"),
        ("Bank", p["bank_label"]),
    ]
    return Card(
        "review",
        {
            "title": f"Review: pay {money(p['amount_cents'])}",
            "summary_rows": _rows(rows),
            "approve_cta": _cta("Continue", {"action": "pay_approve", "action_id": p["action_id"]}, True),
            "reject_cta": _cta("Cancel", {"action": "pay_cancel", "action_id": p["action_id"]}),
        },
    )


def code_form(action_id: str, amount_cents: int) -> Card:
    """The person types the code themselves. The agent never fills it in."""
    return Card(
        "form",
        {
            "title": f"Type the code to pay {money(amount_cents)}",
            "fields": [
                {"name": "code", "kind": "text", "label": "6-digit code from the review card", "required": True, "placeholder": "123456"}
            ],
            "submit_cta": _cta(f"Pay {money(amount_cents)}", {"action": "pay_confirm", "action_id": action_id}, True),
        },
    )


def share_card(expires: str, still_needed: int) -> Card:
    rows = [
        ("Opens", "In the advocate's browser, with the key in the link"),
        ("Tend's server", "Keeps a locked copy it cannot read"),
        ("Link stops working", expires),
        ("Still needed", plural(still_needed, "document")),
        ("Left blank", "Name, signature, Social Security number, and anything about what happened"),
    ]
    return Card(
        "detail",
        {"title": "Locked link for an advocate", "summary_rows": _rows(rows), "ctas": [_cta("Run a Check", {"action": "check_form"})]},
    )


# ======================================================================== api.py
# Client for the Tend API. The agents never decide law or money themselves; they ask the API, which runs the
# law engine over the verified rules and holds the payment rules.
#
# Reads retry once when the server is waking up (a dropped connection, 502, 503, or 504). Writes never retry here:
# a payment proposal, a confirmation, or a share is sent once, and the Bank+Packet agent decides what a failure means.

import asyncio
import logging
import time
from typing import Any

import httpx

# httpx logs every request URL at INFO, and a Check's or a share's URL is nobody's business. Keep them out of logs.
for _name in ("httpx", "httpcore"):
    logging.getLogger(_name).setLevel(logging.WARNING)

DOC_TTL_S = 600.0
RETRY_STATUSES = {502, 503, 504}
_NOT_FOUND = {"Not Found", "Method Not Allowed"}


class ApiError(Exception):
    def __init__(self, status: int, message: str, *, route_missing: bool = False):
        super().__init__(message)
        self.status = status
        self.message = message
        self.route_missing = route_missing


def _detail(r: httpx.Response) -> str:
    try:
        body = r.json()
    except ValueError:
        return r.text[:200] or r.reason_phrase
    if isinstance(body, dict):
        detail = body.get("detail")
        if isinstance(detail, str):
            return detail
        if isinstance(detail, list):
            return "; ".join(str(d.get("msg", d)) if isinstance(d, dict) else str(d) for d in detail)[:300]
        err = body.get("error")
        if isinstance(err, dict) and err.get("message"):
            return str(err["message"])
    return r.reason_phrase


class TendApi:
    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 30.0,
        agent_key: str = "",
        transport: httpx.AsyncBaseTransport | None = None,
        now: Any = time.monotonic,
        retry_delay_s: float = 0.5,
    ):
        headers = {"User-Agent": "tend-navigator/0.2"}
        if agent_key:
            headers["X-Agent-Key"] = agent_key
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=timeout, headers=headers, transport=transport)
        self._now = now
        self._retry_delay_s = retry_delay_s
        self._docs: dict[str, tuple[float, Any]] = {}

    async def aclose(self) -> None:
        await self._client.aclose()

    # ------------------------------------------------------------ plumbing

    async def _once(self, method: str, path: str, **kw: Any) -> Any:
        try:
            r = await self._client.request(method, path, **kw)
        except httpx.TimeoutException as exc:
            raise ApiError(0, "Tend's server took too long to answer.") from exc
        except httpx.HTTPError as exc:
            raise ApiError(0, "Tend's server did not answer.") from exc
        if r.status_code >= 400:
            detail = _detail(r)
            raise ApiError(r.status_code, detail, route_missing=r.status_code in (404, 405) and detail in _NOT_FOUND)
        try:
            return r.json()
        except ValueError as exc:
            raise ApiError(r.status_code, "Tend's server sent a reply I could not read.") from exc

    async def _request(self, method: str, path: str, *, retry: bool = False, **kw: Any) -> Any:
        try:
            return await self._once(method, path, **kw)
        except ApiError as exc:
            if not retry or not (exc.status == 0 or exc.status in RETRY_STATUSES):
                raise
        await asyncio.sleep(self._retry_delay_s)
        return await self._once(method, path, **kw)

    async def _cached(self, key: str, loader: Any) -> Any:
        hit = self._docs.get(key)
        if hit and self._now() - hit[0] < DOC_TTL_S:
            return hit[1]
        value = await loader()
        self._docs[key] = (self._now(), value)
        return value

    # ------------------------------------------------------------ the public law corpus

    async def answer(self, question: str, st: str | None) -> dict[str, Any]:
        body: dict[str, Any] = {"question": question}
        if st:
            body["st"] = st
        return await self._request("POST", "/api/agent/answer", retry=True, json=body)

    async def check(self, st: str, incident_date: str | None, forensic_exam: bool | None, police_report: str) -> dict[str, Any]:
        body: dict[str, Any] = {"st": st, "police_report": police_report}
        if incident_date:
            body["incident_date"] = incident_date
        if forensic_exam is not None:
            body["forensic_exam"] = forensic_exam
        return await self._request("POST", "/api/agent/check", retry=True, json=body)

    async def jurisdiction(self, st: str) -> dict[str, Any]:
        return await self._cached(f"j:{st}", lambda: self._request("GET", f"/api/jurisdictions/{st}", retry=True))

    async def jurisdictions(self) -> list[dict[str, Any]]:
        data = await self._cached("j:*", lambda: self._request("GET", "/api/jurisdictions", retry=True))
        return list(data.get("jurisdictions", [])) if isinstance(data, dict) else []

    # ------------------------------------------------------------ the fictional demo claim

    async def scan(self, persona_id: str, st: str) -> dict[str, Any]:
        return await self._request("POST", "/api/scan", retry=True, json={"persona_id": persona_id, "st": st})

    async def audit_bill(self, bill_id: str, persona_id: str, scan_id: str) -> dict[str, Any]:
        body = {"bill_id": bill_id, "persona_id": persona_id, "scan_id": scan_id}
        return await self._request("POST", "/api/bill/audit", retry=True, json=body)

    async def claim(self, engine_input: dict[str, Any], scan_id: str) -> dict[str, Any]:
        return await self._request("POST", "/api/claim", retry=True, params={"scan_id": scan_id}, json=engine_input)

    # ------------------------------------------------------------ payments and shares (sent once)

    async def propose(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", "/api/actions/propose", json=body)

    async def confirm(self, action_id: str, confirm_code: str) -> dict[str, Any]:
        return await self._request("POST", "/api/actions/confirm", json={"action_id": action_id, "confirm_code": confirm_code})

    async def action(self, action_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/api/actions/{action_id}", retry=True)

    async def seal_share(self, ciphertext: str, iv: str, *, hours: int, once: bool = False) -> dict[str, Any]:
        body = {"ciphertext": ciphertext, "iv": iv, "alg": "AES-256-GCM", "expires_hours": hours, "once": once}
        return await self._request("POST", "/api/shares", json=body)


# ======================================================================== messages.py
# Typed messages between the three Tend agents.
#
# Navigator -> Law agent: cited answers, Checks, and what the corpus covers.
# Navigator -> Bank+Packet agent: the fictional demo claim, the payment, and the advocate's share link.
#
# Every request carries a request_id. A retry resends the same id, so a sub-agent answers it once and repeats that
# answer, and nothing runs twice. No message ever carries what happened, a name, or a survivor's own data: the
# demo is fictional and the law is public.

from uagents import Model


class DemoRef(Model):
    """The fictional demo claim as the Navigator keeps it between messages: ids and amounts, no merchant text."""

    persona_id: str
    st: str
    scan_id: str
    who: str
    account_id: str
    account_label: str
    incident_date: str | None = None
    bill_id: str | None = None
    provider: str | None = None
    pay_item_ids: list[str] = []
    bill_lines: int = 0
    bill_total_cents: int = 0
    payable_cents: int = 0
    held_cents: int = 0
    police_report: str | None = None


# ---------------------------------------------------------------- Law agent


class LawAnswerRequest(Model):
    request_id: str
    st: str
    question: str | None = None  # None when the person's words must stay with the Navigator
    topics: list[str] = []
    expense: str | None = None


class LawCheckRequest(Model):
    request_id: str
    st: str
    incident_date: str | None = None
    forensic_exam: bool | None = None  # None: not sure
    police_report: str = "unknown"  # yes | no | unknown


class LawCoverageRequest(Model):
    request_id: str


class LawReply(Model):
    request_id: str
    ok: bool = True
    text: str = ""
    known: bool = True  # False: not in the rules the agent has
    st: str | None = None
    count: int | None = None
    error: str | None = None  # api_down | api_error | bad_request
    status: int | None = None


# ---------------------------------------------------------------- Bank+Packet agent


class CostGroup(Model):
    expense: str
    count: int
    cents: int


class DemoStartRequest(Model):
    request_id: str
    st: str | None = None


class DemoStartReply(Model):
    request_id: str
    ok: bool = True
    text: str = ""
    demo: DemoRef | None = None
    groups: list[CostGroup] = []
    error: str | None = None
    status: int | None = None


class DemoCountRequest(Model):
    request_id: str
    demo: DemoRef


class DemoCountReply(Model):
    request_id: str
    ok: bool = True
    text: str = ""
    letter: str = ""  # to the billing office, quoting the law that holds the exam line
    allowed_cents: int = 0
    held_cents: int = 0
    deadline_date: str | None = None
    error: str | None = None
    status: int | None = None


class PayProposeRequest(Model):
    request_id: str
    demo: DemoRef


class PayProposeReply(Model):
    request_id: str
    ok: bool = True
    action_id: str | None = None
    amount_cents: int = 0
    confirm_code: str | None = None  # shown once to the person, never stored by any agent
    expires_at: str | None = None
    payee_label: str = ""
    from_label: str = ""
    lines_label: str = ""
    held_cents: int = 0
    dry_run: bool = True
    text: str = ""
    error: str | None = None
    status: int | None = None


class PayConfirmRequest(Model):
    request_id: str
    action_id: str
    confirm_code: str  # exactly what the person typed
    demo: DemoRef


class PayStatusRequest(Model):
    request_id: str
    action_id: str
    demo: DemoRef


class PayResultReply(Model):
    request_id: str
    ok: bool = True
    # done | unverified | maybe | unknown | in_progress | wrong_code | expired | locked | waiting | not_found | bank_error
    outcome: str = ""
    text: str = ""
    amount_cents: int = 0
    audit_id: str | None = None
    bank_record: str | None = None
    error: str | None = None
    status: int | None = None


class PacketShareRequest(Model):
    request_id: str
    demo: DemoRef
    paid_cents: int = 0
    hours: int = 72


class PacketShareReply(Model):
    request_id: str
    ok: bool = True
    url: str | None = None
    expires_at: str | None = None
    text: str = ""
    still_needed: int = 0
    error: str | None = None
    status: int | None = None


LAW_REQUESTS = (LawAnswerRequest, LawCheckRequest, LawCoverageRequest)
BANK_REQUESTS = (DemoStartRequest, DemoCountRequest, PayProposeRequest, PayConfirmRequest, PayStatusRequest, PacketShareRequest)
REPLY_FOR: dict[type[Model], type[Model]] = {
    LawAnswerRequest: LawReply,
    LawCheckRequest: LawReply,
    LawCoverageRequest: LawReply,
    DemoStartRequest: DemoStartReply,
    DemoCountRequest: DemoCountReply,
    PayProposeRequest: PayProposeReply,
    PayConfirmRequest: PayResultReply,
    PayStatusRequest: PayResultReply,
    PacketShareRequest: PacketShareReply,
}
REPLIES = (LawReply, DemoStartReply, DemoCountReply, PayProposeReply, PayResultReply, PacketShareReply)


# ======================================================================== desks.py
# How the Navigator reaches the Law and Bank+Packet agents.
#
# The Navigator calls two async functions, desks.law(request) and desks.bank(request), and gets a typed reply back.
# Locally they are separate uAgents and the calls travel as messages (link.py). In the Agentverse-hosted build the
# same desks run in the Navigator's own process (LocalDesks). Either way the conversation code is the same.

import asyncio
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Any

DESK_NAMES = {"law": "the Law agent", "bank": "the Bank and Packet agent"}


class DeskDown(Exception):
    """A sub-agent did not answer in time, after every attempt."""

    def __init__(self, desk: str):
        super().__init__(f"{desk} did not answer")
        self.desk = desk


def failure(exc: Any) -> dict[str, Any]:
    """Reply fields for an API error: api_down when the server did not answer, else api_error with its status."""
    status = int(getattr(exc, "status", 0) or 0)
    return {"error": "api_down" if status == 0 else "api_error", "status": status, "text": str(getattr(exc, "message", exc))}


class Idempotent:
    """Runs each request id once. A retry that arrives while the request runs waits for the same result, and one
    that arrives soon after gets the same reply again. Results are kept only for that retry window."""

    def __init__(self, ttl_s: float = 90.0, now: Callable[[], float] = time.monotonic, max_entries: int = 256):
        self._ttl = ttl_s
        self._now = now
        self._max = max_entries
        self._done: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._running: dict[str, asyncio.Task[Any]] = {}

    def _sweep(self) -> None:
        cutoff = self._now() - self._ttl
        while self._done and next(iter(self._done.values()))[0] < cutoff:
            self._done.popitem(last=False)

    def _finish(self, key: str, task: asyncio.Task[Any]) -> None:
        self._running.pop(key, None)
        if task.cancelled() or task.exception() is not None:
            return
        self._done[key] = (self._now(), task.result())
        while len(self._done) > self._max:
            self._done.popitem(last=False)

    async def run(self, key: str, factory: Callable[[], Awaitable[Any]]) -> Any:
        self._sweep()
        hit = self._done.get(key)
        if hit is not None:
            return hit[1]
        task = self._running.get(key)
        if task is None:
            task = asyncio.ensure_future(factory())
            self._running[key] = task
            task.add_done_callback(lambda t, k=key: self._finish(k, t))
        return await asyncio.shield(task)


class LocalDesks:
    """Both desks in this process: the Agentverse-hosted build, the console, and most tests."""

    def __init__(self, law: Any, bank: Any):
        self.law: Callable[[Any], Awaitable[Any]] = law.handle
        self.bank: Callable[[Any], Awaitable[Any]] = bank.handle


# ======================================================================== demo.py
# The fictional demo claim, in words: what the scan found, what the law counts, the held exam line, the payment.
#
# The Bank+Packet agent builds these from the API's answers. Only ids, amounts, and expense types travel back to the
# Navigator between messages; merchant names and bill text stay with the API.

from collections import defaultdict
from typing import Any


DEMO_PERSONAS = {"MI": "rowan-mi", "NY": "rowan-ny", "CA": "rowan-ca", "TX": "rowan-tx"}
FICTIONAL = "Fictional person and data on Capital One's Nessie mock bank. No real person, account, or hospital."
FICTIONAL_SHORT = "(Fictional demo data on a mock bank.)"
ENGINE_FIELDS = ("item_id", "date", "amount_cents", "expense", "confirmed", "insurance_paid_cents", "is_bill", "units", "unit", "tags")


def persona_for(st: str | None, default: str) -> tuple[str, str]:
    """(persona_id, state). Rowan exists in MI, NY, CA, and TX; any other state reuses the Michigan history
    under that state's law."""
    if st in DEMO_PERSONAS:
        return DEMO_PERSONAS[st], st
    if st:
        return default, st
    return default, default.rsplit("-", 1)[-1].upper()


def groups(scan: dict[str, Any]) -> list[dict[str, Any]]:
    by: dict[str, dict[str, Any]] = defaultdict(lambda: {"count": 0, "cents": 0})
    for item in scan.get("items") or []:
        if item.get("is_bill"):
            continue
        g = by[item.get("expense") or "unknown"]
        g["count"] += 1
        g["cents"] += int(item.get("amount_cents") or 0)
    return sorted(({"expense": e, **g} for e, g in by.items()), key=lambda g: -g["cents"])


def bill_summary(audit: dict[str, Any] | None) -> dict[str, Any] | None:
    if not audit:
        return None
    return {"lines": len(audit.get("lines") or []), "total_cents": int(audit.get("total_cents") or 0)}


def demo_ref(scan: dict[str, Any], audit: dict[str, Any] | None, persona_id: str) -> dict[str, Any]:
    """What the Navigator keeps between messages: ids and amounts only (messages.DemoRef)."""
    holds = {h["item_id"] for h in (audit or {}).get("holds") or []}
    pay_lines = [ln for ln in (audit or {}).get("lines") or [] if ln.get("item_id") not in holds]
    account = scan.get("account") or {}
    return {
        "persona_id": persona_id,
        "st": scan.get("st"),
        "scan_id": scan.get("scan_id"),
        "who": scan.get("display_name") or "the demo person",
        "account_id": account.get("id") or "",
        "account_label": f"{account.get('nickname') or 'Checking'} ending {account.get('mask') or '----'}",
        "incident_date": scan.get("incident_date"),
        "bill_id": (audit or {}).get("bill_id"),
        "provider": (audit or {}).get("provider"),
        "pay_item_ids": [ln["item_id"] for ln in pay_lines],
        "bill_lines": len((audit or {}).get("lines") or []),
        "bill_total_cents": int((audit or {}).get("total_cents") or 0),
        "payable_cents": int((audit or {}).get("payable_cents") or 0),
        "held_cents": int((audit or {}).get("held_cents") or 0),
        "police_report": ((scan.get("engine_input") or {}).get("context") or {}).get("police_report"),
    }


def confirmed_input(scan: dict[str, Any], audit: dict[str, Any] | None, *, keep_text: bool = False) -> dict[str, Any]:
    """The engine input after the person said yes to every cost. Bill lines come from the audited bill.

    Without keep_text, items carry only what the engine reads (no merchant or bill text), which is what goes to
    /api/claim. With keep_text, the descriptions stay, for the packet that is sealed before it leaves."""
    base = scan["engine_input"]
    items = [dict(i, confirmed=True) for i in base["items"] if not i.get("is_bill")]
    if audit and audit.get("engine_items"):
        items += [dict(i, confirmed=True) for i in audit["engine_items"]]
    else:
        items += [dict(i, confirmed=True) for i in base["items"] if i.get("is_bill")]
    keep = (*ENGINE_FIELDS, "description") if keep_text else ENGINE_FIELDS
    cleaned = []
    for i in items:
        item = {k: i[k] for k in keep if k in i}
        if keep_text and not isinstance(item.get("description"), str):
            item.pop("description", None)
        cleaned.append(item)
    return {**base, "items": cleaned}


def held_lines(audit: dict[str, Any] | None) -> list[dict[str, Any]]:
    """The bill lines the law engine held, with what the billing letter quotes: description, date, amount, rules."""
    if not audit:
        return []
    dates = {ln.get("item_id"): ln.get("date") for ln in audit.get("lines") or []}
    return [
        {
            "item_id": h.get("item_id"),
            "description": h.get("description") or "",
            "date": dates.get(h.get("item_id")),
            "amount_cents": int(h.get("amount_cents") or 0),
            "rule_ids": list(h.get("rule_ids") or []),
        }
        for h in audit.get("holds") or []
    ]


def render_scan(scan: dict[str, Any], audit: dict[str, Any] | None, name: str) -> str:
    who = scan.get("display_name") or "the demo person"
    head = (
        f"**Demo: {who}, {name}.** {FICTIONAL}\n"
        f"Tend read {plural(int(scan.get('read_count') or 0), 'bank record')} and found these possible costs since "
        f"{long_date(scan.get('incident_date'))}:"
    )
    rows = [f"- {expense_label(g['expense'])}: {plural(g['count'], 'charge')}, {money(g['cents'])}" for g in groups(scan)]
    bill = bill_summary(audit)
    if bill:
        rows.append(
            f"- Hospital bill (itemized): {plural(bill['lines'], 'line')}, {money(bill['total_cents'])}. The lines add up to the total."
        )
    return head + "\n\n" + "\n".join(rows)


def _cap_note(line: dict[str, Any], book: RuleBook) -> str:
    rule = book.by_id.get(line.get("cap_rule_id"))
    if not rule:
        return ""
    phrase = cap_phrase(rule)
    return f"limit {phrase.removeprefix('up to ')}" if phrase else "limited by law"


def render_claim(claim: dict[str, Any], book: RuleBook, demo: dict[str, Any], who: str) -> str:
    totals = claim.get("totals") or {}
    lines_by_expense: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for ln in claim.get("lines") or []:
        lines_by_expense[ln.get("expense") or "unknown"].append(ln)

    out = [f"**Amount {who} can ask for: {money(int(totals.get('allowed_cents') or 0))}. The program decides.**", f"_{FICTIONAL}_"]

    counted = []
    for expense, lines in sorted(lines_by_expense.items(), key=lambda kv: -sum(int(x.get("allowed_cents") or 0) for x in kv[1])):
        eligible = [x for x in lines if x.get("status") == "eligible"]
        if not eligible:
            continue
        allowed = sum(int(x.get("allowed_cents") or 0) for x in eligible)
        asked = sum(int(x.get("requested_cents") or 0) for x in eligible)
        notes = sorted({n for n in (_cap_note(x, book) for x in eligible) if n})
        rule_ids = [r for r in eligible[0].get("rule_ids") or [] if r in book.by_id]
        main = next((r for r in rule_ids if book.by_id[r].get("category") in ("covered_expense", "expense_cap")), None)
        link = f" ({cite_link(cite(book.by_id[main], book.sources))})" if main else ""
        amount = money(allowed) if allowed == asked else f"{money(allowed)} of {money(asked)}"
        extra = f"; {', '.join(notes)}" if notes else ""
        counted.append(f"- {expense_label(expense)}: {amount} ({plural(len(eligible), 'charge')}{extra}){link}")
    if counted:
        out.append("What counts:\n" + "\n".join(counted))

    left_out = []
    for expense, lines in lines_by_expense.items():
        for status in ("excluded", "unknown_rule", "out_of_window", "needs_confirmation"):
            these = [x for x in lines if x.get("status") == status]
            if not these:
                continue
            cents = sum(int(x.get("requested_cents") or 0) for x in these)
            label = f"{expense_label(expense)}, {money(cents)}"
            if status == "excluded":
                rid = next((r for r in these[0].get("rule_ids") or [] if r in book.by_id), None)
                why = f"not covered ({cite_link(cite(book.by_id[rid], book.sources))})" if rid else "not covered"
            elif status == "unknown_rule":
                why = "no verified rule covers this yet, so ask the program"
            elif status == "out_of_window":
                why = "outside the dates that count"
            else:
                why = "waiting for a yes"
            left_out.append(f"- {label}: {why}")
    if left_out:
        out.append("Not included:\n" + "\n".join(left_out))

    held = [x for x in claim.get("lines") or [] if x.get("status") == "held"]
    if held:
        cents = sum(int(x.get("requested_cents") or 0) for x in held)
        rid = next((r for r in held[0].get("rule_ids") or [] if (book.by_id.get(r) or {}).get("category") == "exam_no_bill"), None)
        block = cite_block(cite(book.by_id[rid], book.sources)) if rid else ""
        bill = f" of the {money(demo['bill_total_cents'])} hospital bill" if demo.get("bill_total_cents") else " on the hospital bill"
        out.append(
            f"**Don't pay this line:** the forensic exam, {money(cents)}{bill}. The law says the survivor should not be billed for it.\n{block}".strip()
        )

    checks = claim.get("checks") or {}
    facts = []
    deadline = checks.get("deadline") or {}
    rid = next((r for r in deadline.get("rule_ids") or [] if r in book.by_id), None)
    link = f" ({cite_link(cite(book.by_id[rid], book.sources))})" if rid else ""
    facts.append(deadline_sentence(deadline.get("status"), deadline.get("deadline_date"), link, deadline.get("flags"), book))
    reporting = (checks.get("reporting") or {}).get("status")
    if reporting == "satisfied":
        reported = demo.get("police_report") == "yes"
        facts.append("The police report meets that rule." if reported else "The forensic exam counts in place of a police report.")
    elif reporting == "required":
        facts.append("This state asks for a police report.")
    facts = [f for f in facts if f]
    if facts:
        out.append(" ".join(facts))
    return "\n\n".join(out)


def deadline_sentence(status: Any, date: Any, link: str = "", flags: Any = None, book: RuleBook | None = None) -> str:
    """The filing deadline in one sentence. A late date is never shown as "apply by"."""
    if not date or status not in ("ok", "late"):
        return ""
    if status == "late":
        text = f"The usual deadline was {long_date(date)}{link}. Some programs allow more time for a good reason, so it is worth calling."
    else:
        text = f"Apply by {long_date(date)}{link}."
    return text + deadline_notes(flags, book)


def payment_body(demo: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "pay_bill",
        "bill_id": demo["bill_id"],
        "item_ids": demo["pay_item_ids"],
        "amount_cents": demo["payable_cents"],
        "from_account_id": demo["account_id"],
        "payee": demo["provider"],
    }


def payment_view(proposal: dict[str, Any], demo: dict[str, Any]) -> dict[str, Any]:
    dry = bool(proposal.get("dry_run"))
    return {
        "action_id": proposal["action_id"],
        "amount_cents": int(proposal["amount_cents"]),
        "code": str(proposal.get("confirm_code") or ""),
        "payee_label": f"{proposal.get('payee') or demo.get('provider')} (fictional)",
        "from_label": f"{demo['account_label']} (Nessie mock bank)",
        "lines_label": f"{plural(len(proposal.get('item_ids') or demo['pay_item_ids']), 'line')} of the itemized bill",
        "held_cents": demo.get("held_cents") or 0,
        "bank_label": "Dry run: recorded and read back, not sent" if dry else "Nessie mock bank (a real API write)",
    }


def render_paid(result: dict[str, Any], demo: dict[str, Any], book: RuleBook | None) -> str:
    out = [f"**Done.** {result.get('message') or 'The payment went through.'}"]
    facts = []
    if result.get("nessie_id"):
        check = "matches what you approved" if result.get("read_back_matches") else "does NOT match what you approved, so check the account"
        facts.append(f"- Bank record: {result['nessie_id']}. Tend read it back and it {check}.")
    if result.get("audit_id"):
        facts.append(f"- Audit log: {result['audit_id']}, in a hash chain with no names in it.")
    if facts:
        out.append("\n".join(facts))
    if demo.get("held_cents"):
        rule = next(iter(book.of("exam_no_bill")), None) if book else None
        link = f" ({cite_link(cite(rule, book.sources))})" if rule and book else ""
        out.append(
            f"The forensic exam line, {money(demo['held_cents'])}, stays unpaid. The law says the hospital should not bill it{link}."
        )
    return "\n\n".join(out)


# ======================================================================== letter.py
# The letter to the billing office for a held exam line: the same letter the Tend app writes (web/lib/packet/
# letters.ts, billingHold), quoting the state's own words. Names, dates, and account numbers stay as [placeholders];
# Tend never knows them and never fills them in.

from typing import Any


SIGN_OFF = "Thank you,\n[Your name]\n[A safe way to reach you]"


def _quote(rule: dict[str, Any]) -> str:
    return f'"{str(rule.get("quote") or "").strip()}" ({rule.get("pinpoint") or rule.get("id")})'


def _charge(line: dict[str, Any]) -> str:
    what = str(line.get("description") or "").strip() or "Charge"
    when = f", {long_date(line['date'])}" if line.get("date") else ""
    return f"    {what}{when}: {money(int(line.get('amount_cents') or 0))}"


def billing_letter(book: RuleBook, held: list[dict[str, Any]]) -> str:
    """held: the bill lines the law engine held, each with description, date, amount_cents, and rule_ids."""
    cited = {r for line in held for r in line.get("rule_ids") or []}

    def pick(rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
        mine = [r for r in rules if r.get("id") in cited]
        return (mine or rules)[:1]

    why = pick(book.of("exam_no_bill"))
    payers = pick(book.of("exam_payment"))
    if not why and not (held and payers):
        return ""
    charges = "\n".join(_charge(line) for line in held) if held else "    [Exam charge, date of service]: [amount]"
    these = "these charges" if len(held) > 1 else "this charge"
    paragraphs = [
        "[Date]",
        "To: Billing office, [hospital or clinic name]\nAbout: Account [account number]",
        f"I am writing about {these} on my account for a sexual assault forensic exam:\n\n{charges}",
        f"{book.name} law says I should not be billed for this exam:\n\n" + "\n\n".join(_quote(r) for r in why)
        if why
        else f"{book.name} law says this about paying for the exam:\n\n" + "\n\n".join(_quote(r) for r in payers),
        "Please remove the exam charge from my account, stop any collection on it, and send me an updated statement."
        if why
        else "Please put this charge on hold while the exam is paid for the way the law describes, and send me an updated statement.",
        "The law names who pays for the exam instead:\n\n" + "\n\n".join(_quote(r) for r in payers) if why and payers else "",
        "If you have questions, please contact me in writing.",
        SIGN_OFF,
    ]
    return "\n\n".join(p for p in paragraphs if p) + "\n"


# ======================================================================== packet.py
# What the packet says beyond the numbers: the documents still needed and where to file, from verified rules only.
#
# A port of the Tend app's own lists (web/lib/packet/checklist.ts and filing.ts), with the same keyword tables, so the
# advocate's link and this chat name the same documents. Each item keeps its rule id and verbatim quote.

import re
from typing import Any


CARE = ["medical", "forensic_exam", "dental", "prescription", "counseling"]
DEATH = "for a claim after a death"
_I = re.I | re.A  # ASCII word boundaries, like the JavaScript original

SPECIAL: list[tuple[re.Pattern[str], dict[str, Any]]] = [
    (
        re.compile(r"\b(death|deceased|died|loss of support|survivor'?s benefits?|dependents?|child support|marriage certificate)\b", _I),
        {"kind": "skip", "why": DEATH},
    ),
    (
        re.compile(
            r"\b(guardianship|child victim|for a minor|applies for a minor|power of attorney|incapacitated|under (age )?1[89]|"
            r"parent or (legal )?guardian)\b",
            _I,
        ),
        {"kind": "skip", "why": "for someone filing on another person's behalf"},
    ),
    (re.compile(r"\b(letter of appearance|attorney represents|attorney must file)\b", _I), {"kind": "skip", "why": "only with a lawyer"}),
    (re.compile(r"\bemergency award\b", _I), {"kind": "skip", "why": "only when asking for an emergency award"}),
    (
        re.compile(
            r"\b(SANE|exam bill|forensic exam\w*|sexual assault (medical |forensic )*(exam|examination)|sexual assault billing form)\b", _I
        ),
        {"kind": "exam"},
    ),
]
LATE = re.compile(
    r"\b(fil(e|ed|ing)|appl(y|ying|ication))\b[^.;]*\b(late|delay(ed)?|more than)\b|"
    r"\b(late|delay(ed)?)\b[^.;]*\b(fil(e|ed|ing)|appl(y|ying|ication))\b",
    _I,
)
HINTS: list[tuple[re.Pattern[str], list[str]]] = [
    (re.compile(r"\b(funeral|burial|cemetery)\b", _I), ["funeral"]),
    (re.compile(r"\b(relocat\w*|moving|movers?|lease|lodging|utilit(y|ies))\b", _I), ["relocation", "temporary_housing"]),
    (re.compile(r"\b(security|locks?|alarms?|landlord'?s?)\b", _I), ["security"]),
    (re.compile(r"\b(clean-?up|crime scene)\b", _I), ["crime_scene_cleanup"]),
    (
        re.compile(r"\b(held as evidence|evidence receipt|clothing|bedding|replacement costs?)\b", _I),
        ["clothing_bedding", "property_replacement"],
    ),
    (re.compile(r"\b(mileage|travel|transportation)\b", _I), ["transportation"]),
    (
        re.compile(
            r"\b(wages?|earnings?|pay ?stubs?|employer|employment|work|disability|W-2|schedule c|income tax|sick|vacation|unemployment)\b",
            _I,
        ),
        ["lost_wages"],
    ),
    (re.compile(r"\b(prescriptions?|medications?|pharmacy|glasses|medical equipment)\b", _I), ["prescription", "medical"]),
    (re.compile(r"\b(dental|dentist|dentures?)\b", _I), ["dental"]),
    (re.compile(r"\b(counsel\w*|mental health|therap\w*|psycholog\w*)\b", _I), ["counseling"]),
    (re.compile(r"\b(child ?care|day ?care)\b", _I), ["childcare"]),
    (re.compile(r"\b(medical|hospital|HIPAA|health care|physician|doctor|treatment|clinic)\b", _I), CARE),
]
BY_TYPE: dict[str, dict[str, Any]] = {
    "photo_id": {"kind": "always"},
    "proof_of_residency": {"kind": "always"},
    "police_report": {"kind": "report"},
    "exam_record": {"kind": "exam"},
    "itemized_bill": {"kind": "always"},
    "receipts": {"kind": "always"},
    "wage_verification": {"kind": "expenses", "expenses": ["lost_wages"]},
    "medical_records": {"kind": "expenses", "expenses": CARE},
    "counseling_statement": {"kind": "expenses", "expenses": ["counseling"]},
    "insurance_statement": {"kind": "expenses", "expenses": CARE},
    "other": {"kind": "always"},
}
LABEL = {
    "photo_id": "A copy of your photo ID",
    "proof_of_residency": "Proof of where you live",
    "police_report": "The police report, or its number",
    "exam_record": "A record of your forensic exam",
    "itemized_bill": "Itemized bills",
    "receipts": "Receipts for costs you paid",
    "wage_verification": "Proof of the pay you missed",
    "medical_records": "Medical records",
    "counseling_statement": "A statement from your counselor",
    "insurance_statement": "Insurance statements (explanation of benefits)",
    "other": "A document the program asks for",
}
METHODS = ["online", "email", "mail", "fax", "in_person"]
METHOD_LABEL = {"online": "Online", "email": "Email", "mail": "Mail", "fax": "Fax", "in_person": "In person"}
LEAD = re.compile(r"^([^:]{2,60}):")
CLAUSE = re.compile(r"\b(?:only\s+)?(?:if|when|for)\s+([^.;:()]+)", _I)


def _param(rule: dict[str, Any], name: str) -> Any:
    return (rule.get("params") or {}).get(name)


def hinted(text: str) -> list[str]:
    t = re.sub(r"social security", "", text, flags=_I)  # a Social Security number is not home security
    out: list[str] = []
    for pattern, expenses in HINTS:
        if pattern.search(t):
            out += [e for e in expenses if e not in out]
    return out


def note_scope(note: str) -> list[str]:
    lead = LEAD.match(note)
    clauses = [lead.group(1) if lead else ""] + [m.group(1) for m in CLAUSE.finditer(note)]
    scoped: list[str] = []
    for c in clauses:
        scoped += [e for e in hinted(c) if e not in scoped]
    return scoped or hinted(note)


def doc_scope(rule: dict[str, Any]) -> dict[str, Any]:
    kind = str(_param(rule, "document") or "other")
    if kind in ("police_report", "exam_record", "photo_id", "proof_of_residency"):
        return BY_TYPE[kind]
    note = str(_param(rule, "note") or "").strip()
    about = note or str(rule.get("quote") or "")
    first = re.split(r"[;(]", about)[0]
    lead = LEAD.match(about)
    subject = lead.group(1) if lead else first
    for pattern, scope in SPECIAL:
        if not pattern.search(subject if scope["kind"] == "skip" else first):
            continue
        if scope["kind"] == "skip" and scope["why"] == DEATH and any(e != "funeral" for e in hinted(subject)):
            continue  # "for lost wages or loss of support" still serves lost wages
        return scope
    if LATE.search(about):
        return {"kind": "late"}
    if kind in ("wage_verification", "counseling_statement"):
        return BY_TYPE[kind]
    from_note = note_scope(note)
    from_pinpoint = hinted(str(rule.get("pinpoint") or ""))
    expenses = from_note or from_pinpoint
    if from_note and from_pinpoint:
        both = [e for e in from_note if e in from_pinpoint]
        if both:
            expenses = both
    if expenses:
        return {"kind": "expenses", "expenses": expenses}
    return BY_TYPE.get(kind, BY_TYPE["other"])


def claimed_expenses(output: dict[str, Any]) -> set[str]:
    return {ln.get("expense") for ln in output.get("lines") or [] if ln.get("status") in ("eligible", "needs_confirmation")}


def scope_applies(scope: dict[str, Any], engine_input: dict[str, Any], output: dict[str, Any]) -> bool:
    kind = scope["kind"]
    if kind == "always":
        return True
    if kind == "expenses":
        return bool(claimed_expenses(output) & set(scope["expenses"]))
    checks = output.get("checks") or {}
    ctx = engine_input.get("context") or {}
    if kind == "report":
        return ctx.get("police_report") == "yes" or (checks.get("reporting") or {}).get("status") in ("required", "unknown")
    if kind == "exam":
        return bool(ctx.get("forensic_exam")) or any(ln.get("status") == "held" for ln in output.get("lines") or [])
    if kind == "late":
        return (checks.get("deadline") or {}).get("status") == "late"
    return False


def _itemized_on_hand(scope: dict[str, Any], engine_input: dict[str, Any], output: dict[str, Any]) -> bool:
    """Itemized bills are in hand when every cost the document covers came from a bill read line by line."""
    items = {i["item_id"]: i for i in engine_input.get("items") or []}
    covered = [
        ln
        for ln in output.get("lines") or []
        if ln.get("status") in ("eligible", "needs_confirmation")
        and (scope["kind"] != "expenses" or ln.get("expense") in scope["expenses"])
    ]
    return bool(covered) and all(
        bool(items.get(ln["item_id"], {}).get("is_bill")) and not str(ln["item_id"]).startswith("nessie:") for ln in covered
    )


def _sentence(text: str) -> str:
    t = re.sub(r"\s+", " ", text.strip())
    return t[:1].upper() + t[1:]


def still_needed(book: RuleBook, engine_input: dict[str, Any], output: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for rule in book.of("required_document"):
        scope = doc_scope(rule)
        if not scope_applies(scope, engine_input, output):
            continue
        kind = str(_param(rule, "document") or "other")
        note = _param(rule, "note")
        out.append(
            {
                "document": _sentence(note if isinstance(note, str) and note.strip() else LABEL.get(kind, LABEL["other"])),
                "rule_id": rule.get("id"),
                "pinpoint": rule.get("pinpoint"),
                "quote": rule.get("quote"),
                "fragment_url": rule.get("fragment_url"),
                "have_it": kind == "itemized_bill" and _itemized_on_hand(scope, engine_input, output),
            }
        )
    return out


def filing_routes(book: RuleBook) -> list[dict[str, Any]]:
    seen: set[str] = set()
    routes = []
    for order, rule in enumerate(book.of("submission")):
        method, target = _param(rule, "method"), _param(rule, "target")
        if method not in METHODS or not isinstance(target, str) or not target.strip():
            continue
        key = f"{method}|{target.strip().lower()}"
        if key in seen:
            continue
        seen.add(key)
        routes.append({"method": method, "target": target.strip(), "rule": rule, "order": order})
    routes.sort(key=lambda r: (METHODS.index(r["method"]), r["order"]))
    return routes


# ======================================================================== share.py
# End-to-end encrypted share links in the exact format the Tend web app opens (web/lib/share).
#
# A fresh 256-bit key and a 12-byte IV seal {"format": "tend.share/1", "packet": SharedPacket} with AES-256-GCM
# (additional data "tend.share.v1", 128-bit tag). Tend's server gets the ciphertext and the IV only. The key goes in
# the link's fragment (/share#<id>.<key>), which browsers never send to a server. The agent keeps no copy of the key.

import base64
import json
import re
import secrets
from typing import Any

FORMAT = "tend.share/1"
AAD = b"tend.share.v1"
KEY_BYTES = 32
IV_BYTES = 12
TAG_BYTES = 16
VIEWER_PATH = "/share"
ID = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STATUSES = {"out_of_window", "held", "excluded", "unknown_rule", "needs_confirmation", "eligible"}


class ShareFormatError(ValueError):
    pass


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def from_b64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def aes_gcm_encrypt(key: bytes, iv: bytes, plaintext: bytes, aad: bytes) -> bytes:
    """Ciphertext followed by the 16-byte tag, as WebCrypto's AES-GCM produces and expects."""
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        from Crypto.Cipher import AES

        cipher = AES.new(key, AES.MODE_GCM, nonce=iv, mac_len=TAG_BYTES)
        cipher.update(aad)
        body, tag = cipher.encrypt_and_digest(plaintext)
        return body + tag
    return AESGCM(key).encrypt(iv, plaintext, aad)


def aes_gcm_decrypt(key: bytes, iv: bytes, sealed: bytes, aad: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        from Crypto.Cipher import AES

        cipher = AES.new(key, AES.MODE_GCM, nonce=iv, mac_len=TAG_BYTES)
        cipher.update(aad)
        return cipher.decrypt_and_verify(sealed[:-TAG_BYTES], sealed[-TAG_BYTES:])
    return AESGCM(key).decrypt(iv, sealed, aad)


def _cents(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 2**53 - 1


def _strings(v: Any) -> bool:
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def check_packet(p: Any) -> None:
    """The checks the web viewer runs before it shows a shared claim (web/lib/share isPacket). A packet that would
    fail there is refused here, before anything is sealed."""

    def need(ok: bool, what: str) -> None:
        if not ok:
            raise ShareFormatError(what)

    need(isinstance(p, dict), "packet")
    st = p.get("st")
    need(isinstance(st, str) and re.fullmatch(r"[A-Z]{2}", st) is not None, "st")
    need(isinstance(p.get("created_at"), str), "created_at")
    # The viewer refuses null where it expects a missing key, so optional fields are left out, never null.
    need("notes" not in p or (isinstance(p["notes"], str) and len(p["notes"]) <= 4000), "notes")
    inp, out = p.get("input"), p.get("output")
    need(isinstance(inp, dict) and isinstance(out, dict), "input and output")
    need(str(inp.get("jurisdiction", "")).upper() == st and str(out.get("jurisdiction", "")).upper() == st, "jurisdiction")
    ctx = inp.get("context") or {}
    need(isinstance(ctx.get("incident_date"), str) and DAY.match(ctx["incident_date"]) is not None, "incident_date")
    need(isinstance(ctx.get("as_of_date"), str) and DAY.match(ctx["as_of_date"]) is not None, "as_of_date")
    need(ctx.get("police_report") in ("yes", "no", "unknown") and isinstance(ctx.get("forensic_exam"), bool), "context")
    items = inp.get("items")
    need(isinstance(items, list), "items")
    for i in items:
        need(
            isinstance(i, dict)
            and isinstance(i.get("item_id"), str)
            and isinstance(i.get("date"), str)
            and DAY.match(i["date"]) is not None
            and _cents(i.get("amount_cents"))
            and isinstance(i.get("expense"), str)
            and ("description" not in i or isinstance(i["description"], str))
            and ("insurance_paid_cents" not in i or _cents(i["insurance_paid_cents"]))
            and ("units" not in i or _cents(i["units"])),
            "item",
        )
    ids = {i["item_id"] for i in items}
    lines = out.get("lines")
    need(isinstance(lines, list), "lines")
    for ln in lines:
        need(
            isinstance(ln, dict)
            and ln.get("item_id") in ids
            and isinstance(ln.get("expense"), str)
            and ln.get("status") in STATUSES
            and _cents(ln.get("requested_cents"))
            and _cents(ln.get("allowed_cents"))
            and _strings(ln.get("rule_ids"))
            and (ln.get("cap_rule_id") is None or isinstance(ln["cap_rule_id"], str))
            and _strings(ln.get("flags")),
            "line",
        )
    totals = out.get("totals") or {}
    need(all(_cents(totals.get(k)) for k in ("allowed_cents", "held_cents", "requested_cents")), "totals")
    checks = out.get("checks") or {}
    for name in ("deadline", "minimum_loss", "reporting"):
        c = checks.get(name)
        need(isinstance(c, dict) and isinstance(c.get("status"), str) and _strings(c.get("rule_ids")), f"checks.{name}")
    need(out.get("info_rule_ids") is None or _strings(out["info_rule_ids"]), "info_rule_ids")


def seal(packet: dict[str, Any], *, rand: Any = secrets.token_bytes) -> tuple[str, str, str]:
    """(ciphertext, iv, key), each base64url without padding. The caller sends the first two and puts the key
    only in the link."""
    check_packet(packet)
    key, iv = rand(KEY_BYTES), rand(IV_BYTES)
    plain = json.dumps({"format": FORMAT, "packet": packet}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return b64url(aes_gcm_encrypt(key, iv, plain, AAD)), b64url(iv), b64url(key)


def open_sealed(ciphertext: str, iv: str, key: str) -> dict[str, Any]:
    """The reverse of seal, as the advocate's browser does it. Used by tests and by the rehearsal's own check."""
    try:
        doc = json.loads(aes_gcm_decrypt(from_b64url(key), from_b64url(iv), from_b64url(ciphertext), AAD))
    except Exception as exc:  # a wrong key or changed data fails the tag check, whichever library is installed
        raise ShareFormatError("this link's key does not open this ciphertext") from exc
    if doc.get("format") != FORMAT:
        raise ShareFormatError("format")
    check_packet(doc.get("packet"))
    return doc["packet"]


def share_link(origin: str, share_id: str, key: str) -> str:
    if not ID.match(share_id) or len(key) != 43:
        raise ShareFormatError("link")
    return f"{origin.rstrip('/')}{VIEWER_PATH}#{share_id}.{key}"


# ======================================================================== law.py
# The Law agent's work: cited answers and Checks from the verified corpus, through the Tend API.
#
# Every sentence it sends back points at a rule with a verbatim quote and a link. When no verified rule supports an
# answer, it says the answer is not in the rules it has, and gives the program's contact instead of guessing.

from typing import Any


CANONICAL = {
    "deadline": "What is the deadline to apply for crime victim compensation in {name}?",
    "reporting": "Does {name} require a police report for crime victim compensation?",
    "exam": "Can a sexual assault survivor in {name} be billed for a forensic exam, and who pays for it?",
    "time": "How long does {name}'s program take to decide a claim?",
    "privacy": "What privacy protections does {name} offer crime victim compensation applicants?",
    "emergency": "Does {name} offer an emergency award?",
    "minimum": "Is there a minimum loss to apply in {name}?",
    "insurance": "How does insurance affect a crime victim compensation claim in {name}?",
    "residency": "Who can apply for crime victim compensation in {name}?",
    "documents": "What documents does {name}'s program ask for?",
    "apply": "How do I apply for crime victim compensation in {name}?",
    "max": "What is the most {name}'s crime victim compensation program pays?",
    "covered": "What costs does {name}'s crime victim compensation program cover?",
    "excluded": "What does {name}'s crime victim compensation program not cover?",
    "eligibility": "Can a sexual assault survivor apply for crime victim compensation in {name}?",
    "contact": "How do I contact {name}'s crime victim compensation program?",
}
CITATION_KEYS = ("citations", "rules", "sources", "cites", "evidence", "rule_ids")
REFUSED = {"unknown", "no_rule", "not_found", "dont_know", "unsupported", "none", "refused"}


def canonical_question(topics: list[str], expense: str | None, name: str) -> str:
    """A question rebuilt from the topic alone, for when the person's own words must not leave the Navigator."""
    if expense and expense != "forensic_exam" and (not topics or topics[0] in ("covered", "max", "excluded", "eligibility")):
        return f"Does {name}'s crime victim compensation program cover {expense_label(expense).lower()}, and is there a limit?"
    if expense == "forensic_exam":
        return CANONICAL["exam"].format(name=name)
    topic = topics[0] if topics else "covered"
    return CANONICAL.get(topic, CANONICAL["covered"]).format(name=name)


def _first_str(data: dict[str, Any], *keys: str) -> str:
    for k in keys:
        v = data.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _unwrap(data: dict[str, Any]) -> dict[str, Any]:
    """Accept {"answer": {...}} or {"result": {...}} as well as a flat reply."""
    for key in ("answer", "result", "data"):
        inner = data.get(key)
        if isinstance(inner, dict):
            return {**data, **inner, key: inner.get("text") or inner.get("answer") or ""}
    return data


def citation_ids(data: dict[str, Any]) -> list[str]:
    """Rule ids given as plain strings, which need the state's rules to become quotes and links."""
    data = _unwrap(data)
    for k in CITATION_KEYS:
        v = data.get(k)
        if isinstance(v, list) and v:
            return [c for c in v if isinstance(c, str)]
    return []


def _citations(data: dict[str, Any], book: RuleBook | None) -> list[dict[str, Any]]:
    for k in CITATION_KEYS:
        v = data.get(k)
        if isinstance(v, list) and v:
            out = []
            for c in v:
                if isinstance(c, dict):
                    out.append(c)
                elif isinstance(c, str) and book is not None and c in book.by_id:
                    out.append(cite(book.by_id[c], book.sources))
            return out
    return []


def _known(data: dict[str, Any], cites: list[dict[str, Any]]) -> bool:
    for key in ("answered", "known", "found", "supported"):
        if isinstance(data.get(key), bool):
            return data[key]
    if str(data.get("status") or data.get("reason") or "").lower() in REFUSED:
        return False
    return bool(cites)


def answered(data: dict[str, Any]) -> bool:
    data = _unwrap(data)
    return _known(data, _citations(data, None)) or bool(data.get("sentences"))


def render_api_answer(data: dict[str, Any], name: str, book: RuleBook | None = None) -> tuple[str, bool]:
    """(text, known) for a reply from /api/agent/answer. Rule ids given as strings become quotes and links. A refusal
    names the program from the state's verified rules (book) when it has them."""
    data = _unwrap(data)
    cites = _citations(data, book)
    sentences = [s for s in data.get("sentences") or [] if isinstance(s, dict)]
    if not _known(data, cites) and not sentences:
        text = f"{NOT_IN_RULES} I found no verified {name} rule that answers it, so I won't guess."
        program = program_line((book.doc.get("program") if book else None) or data.get("program") or data.get("contact"), name)
        return text + (f"\n\nThe program can answer it: {program}." if program else ""), False
    parts = [_first_str(data, "answer", "text", "summary")]
    for s in sentences:
        links = ", ".join(cite_link(c) for c in s.get("citations") or [] if isinstance(c, dict))
        parts.append(f"- {clean(s.get('text'))}" + (f" ({links})" if links else ""))
    if cites:
        quoted = [cite_block(c) for c in cites[:MAX_QUOTED]]
        more = [cite_link(c) for c in cites[MAX_QUOTED:]]
        parts.append("\n\n".join(quoted) + ("\n\nMore: " + ", ".join(more) if more else ""))
    return "\n\n".join(p for p in parts if p), True


def looks_like_check(data: Any) -> bool:
    return isinstance(data, dict) and any(k in data for k in ("deadline", "reporting", "sentences"))


class LawDesk:
    """What the Law agent does with each request. Stateless apart from the API client's 10-minute rule cache."""

    name = "law"

    def __init__(self, api: TendApi, settings: Settings):
        self.api = api
        self.settings = settings
        self._once = Idempotent()

    async def handle(self, req: Any) -> LawReply:
        return await self._once.run(req.request_id, lambda: self._handle(req))

    async def _handle(self, req: Any) -> LawReply:
        try:
            if isinstance(req, LawAnswerRequest):
                return await self._answer(req)
            if isinstance(req, LawCheckRequest):
                return await self._check(req)
            if isinstance(req, LawCoverageRequest):
                return await self._coverage(req)
            return LawReply(request_id=req.request_id, ok=False, error="bad_request", text="Unknown request.")
        except ApiError as exc:
            return LawReply(request_id=req.request_id, ok=False, **failure(exc))

    async def _book(self, st: str) -> RuleBook | None:
        try:
            return RuleBook(await self.api.jurisdiction(st))
        except ApiError:
            return None

    async def _answer(self, req: LawAnswerRequest) -> LawReply:
        name = state_name(req.st)
        text, known = "", True
        try:
            data = await self.api.answer(req.question or canonical_question(req.topics, req.expense, name), req.st)
            if isinstance(data, dict):
                # The rules are needed to quote rule ids given as plain strings, and to name the program in a refusal.
                book = await self._book(req.st) if citation_ids(data) or not answered(data) else None
                text, known = render_api_answer(data, name, book)
        except ApiError as exc:
            if exc.status == 0 and not exc.route_missing:
                raise
        if not text:  # the answer route is missing or failed: answer from the verified rules themselves
            found = answer_from_rules(await self.api.jurisdiction(req.st), req.question or "", topics=req.topics, expense=req.expense)
            text, known = found.text, found.known
        return LawReply(request_id=req.request_id, text=text, known=known, st=req.st)

    async def _check(self, req: LawCheckRequest) -> LawReply:
        data = await self.api.check(req.st, req.incident_date, req.forensic_exam, req.police_report)
        if not looks_like_check(data):
            raise ApiError(502, "Tend's server sent a Check I could not read.")
        book = await self._book(req.st)
        origin = self.settings.app_origin
        app = f"{origin}/{req.st.lower()}" if origin else ""
        text = render_check(
            data,
            book,
            st=req.st,
            name=state_name(req.st),
            incident_date=req.incident_date,
            exam=req.forensic_exam,
            report=req.police_report,
            app_url=app,
        )
        return LawReply(request_id=req.request_id, text=text, st=req.st)

    async def _coverage(self, req: LawCoverageRequest) -> LawReply:
        count = len(await self.api.jurisdictions())
        text = (
            f"I have verified rules for {count} jurisdictions: all 50 states and DC. Every rule is a verbatim quote "
            "from an official source, saved with its link. Ask about any of them."
        )
        return LawReply(request_id=req.request_id, text=text, count=count)


# ======================================================================== bank.py
# The Bank+Packet agent's work: the fictional demo claim, end to end, through the Tend API.
#
# 1. Scan the demo bank (Capital One's Nessie mock bank, a fictional persona) and read the itemized hospital bill.
# 2. Count the claim with the law engine, hold the forensic exam line the law says was never billable, and write the
#    letter to the billing office that quotes that law.
# 3. Propose paying the rest of the bill. The API issues a 6-digit code; nothing moves until the person types it back
#    and this agent sends exactly what they typed to the API, which checks it.
# 4. Seal the packet for an advocate: encrypted here with a fresh key, so Tend's server stores only ciphertext and
#    the key travels in the link alone.
#
# Each request is answered from fresh API reads, so the agent keeps no claim, bill, or merchant text between messages.

import datetime as dt
import secrets
from typing import Any


CONFIRM_OUTCOMES = {403: "wrong_code", 410: "expired", 423: "locked", 404: "not_found"}
STATUS_OUTCOMES = {
    "proposed": "waiting",
    "executing": "in_progress",
    "done": "done",
    "unverified": "unverified",
    "failed": "bank_error",
    "expired": "expired",
    "locked": "locked",
}
SHOWN_DOCUMENTS = 5


def _utc_now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


class BankDesk:
    name = "bank"

    def __init__(self, api: TendApi, settings: Settings, *, now: Any = _utc_now, rand: Any = secrets.token_bytes):
        self.api = api
        self.settings = settings
        self._now = now
        self._rand = rand
        self._once = Idempotent()

    async def handle(self, req: Any) -> Any:
        return await self._once.run(req.request_id, lambda: self._handle(req))

    async def _handle(self, req: Any) -> Any:
        routes = {
            DemoStartRequest: (self._start, DemoStartReply),
            DemoCountRequest: (self._count, DemoCountReply),
            PayProposeRequest: (self._propose, PayProposeReply),
            PayConfirmRequest: (self._confirm, PayResultReply),
            PayStatusRequest: (self._status, PayResultReply),
            PacketShareRequest: (self._share, PacketShareReply),
        }
        route = routes.get(type(req))
        if route is None:
            raise TypeError(f"the Bank agent does not take {type(req).__name__}")
        work, reply = route
        try:
            return await work(req)
        except ApiError as exc:
            return reply(request_id=req.request_id, ok=False, **failure(exc))

    # ------------------------------------------------------------ reading the demo

    async def _book(self, st: str) -> RuleBook:
        try:
            return RuleBook(await self.api.jurisdiction(st))
        except ApiError:
            return RuleBook({"jurisdiction": st, "name": state_name(st)})

    async def _scan_and_audit(self, persona_id: str, st: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
        scan = await self.api.scan(persona_id, st)
        bill_id = next((d.get("bill_id") for d in scan.get("documents") or [] if d.get("bill_id")), None)
        audit = None
        if bill_id:
            try:
                audit = await self.api.audit_bill(bill_id, persona_id, scan["scan_id"])
            except ApiError as exc:
                if exc.status == 0:
                    raise
        return scan, audit

    async def _start(self, req: DemoStartRequest) -> DemoStartReply:
        persona, st = persona_for(req.st, self.settings.demo_persona)
        scan, audit = await self._scan_and_audit(persona, st)
        return DemoStartReply(
            request_id=req.request_id,
            text=render_scan(scan, audit, state_name(st)),
            demo=DemoRef(**demo_ref(scan, audit, persona)),
            groups=[CostGroup(**g) for g in groups(scan)],
        )

    async def _count(self, req: DemoCountRequest) -> DemoCountReply:
        demo = req.demo
        scan, audit = await self._scan_and_audit(demo.persona_id, demo.st)
        claim = await self.api.claim(confirmed_input(scan, audit), scan["scan_id"])
        book = await self._book(demo.st)
        held = held_lines(audit)
        totals = claim.get("totals") or {}
        return DemoCountReply(
            request_id=req.request_id,
            text=render_claim(claim, book, demo.model_dump(), demo.who),
            letter=billing_letter(book, held) if held else "",
            allowed_cents=int(totals.get("allowed_cents") or 0),
            held_cents=int(totals.get("held_cents") or 0),
            deadline_date=((claim.get("checks") or {}).get("deadline") or {}).get("deadline_date"),
        )

    # ------------------------------------------------------------ paying the rest of the bill

    async def _propose(self, req: PayProposeRequest) -> PayProposeReply:
        demo = req.demo.model_dump()
        if not demo.get("payable_cents") or not demo.get("bill_id"):
            return PayProposeReply(
                request_id=req.request_id, ok=False, error="nothing_to_pay", text="There is nothing left to pay on the demo bill."
            )
        proposal = await self.api.propose(payment_body(demo))
        view = payment_view(proposal, demo)
        return PayProposeReply(
            request_id=req.request_id,
            action_id=view["action_id"],
            amount_cents=view["amount_cents"],
            confirm_code=view["code"],
            expires_at=proposal.get("expires_at"),
            payee_label=view["payee_label"],
            from_label=view["from_label"],
            lines_label=view["lines_label"],
            held_cents=view["held_cents"],
            dry_run=bool(proposal.get("dry_run")),
        )

    async def _confirm(self, req: PayConfirmRequest) -> PayResultReply:
        try:
            result = await self.api.confirm(req.action_id, req.confirm_code)
        except ApiError as exc:
            if exc.status == 409:  # already finished: say what happened, so a retried confirm never looks like a failure
                return await self._status(PayStatusRequest(request_id=req.request_id, action_id=req.action_id, demo=req.demo))
            if exc.status in CONFIRM_OUTCOMES:
                return PayResultReply(request_id=req.request_id, outcome=CONFIRM_OUTCOMES[exc.status], text=exc.message, status=exc.status)
            if exc.status == 502:  # the bank refused (nothing moved) or did not answer (it may have moved): ask the API which
                status = await self._status(PayStatusRequest(request_id=req.request_id, action_id=req.action_id, demo=req.demo))
                if status.outcome == "bank_error":
                    return PayResultReply(request_id=req.request_id, outcome="bank_error", text=exc.message, status=502)
                return status
            if exc.status == 0 or exc.status >= 500:
                # The code may have reached the API, or the API failed partway through: never call it failed.
                return PayResultReply(request_id=req.request_id, outcome="unknown", text=exc.message, status=exc.status)
            raise
        book = await self._book(req.demo.st)
        return PayResultReply(
            request_id=req.request_id,
            outcome="done" if result.get("read_back_matches") else "unverified",
            text=render_paid(result, req.demo.model_dump(), book),
            amount_cents=int(result.get("amount_cents") or 0),
            audit_id=result.get("audit_id"),
            bank_record=result.get("nessie_id"),
        )

    async def _status(self, req: PayStatusRequest) -> PayResultReply:
        action = await self.api.action(req.action_id)
        outcome = STATUS_OUTCOMES.get(str(action.get("status")), "waiting")
        amount = int(action.get("amount_cents") or 0)
        rows = action.get("audit") or []
        audit_id = f"aud_{int(rows[-1]['seq']):06d}" if rows and isinstance(rows[-1].get("seq"), int) else None
        text = ""
        if outcome == "unverified" and not action.get("withdrawal_id"):
            # The bank never answered, so there is no record to read back: the money may or may not have moved.
            outcome = "maybe"
        if outcome in ("done", "unverified"):
            payee = action.get("payee") or req.demo.provider or "the hospital"
            result = {
                "message": f"Paid {money(amount)} to {payee}."
                + (" Dry run: Tend recorded it and read it back, but did not send it to the bank." if action.get("dry_run") else ""),
                "nessie_id": action.get("withdrawal_id"),
                "read_back_matches": bool((action.get("readback") or {}).get("ok")),
                "audit_id": audit_id,
            }
            text = render_paid(result, req.demo.model_dump(), await self._book(req.demo.st))
        return PayResultReply(
            request_id=req.request_id,
            outcome=outcome,
            text=text,
            amount_cents=amount,
            audit_id=audit_id,
            bank_record=action.get("withdrawal_id"),
        )

    # ------------------------------------------------------------ the packet, sealed for an advocate

    async def _share(self, req: PacketShareRequest) -> PacketShareReply:
        demo = req.demo
        scan, audit = await self._scan_and_audit(demo.persona_id, demo.st)
        claim = await self.api.claim(confirmed_input(scan, audit), scan["scan_id"])
        book = await self._book(demo.st)
        full = confirmed_input(scan, audit, keep_text=True)  # the bill and merchant text travel only inside the ciphertext
        notes = f"Fictional demo claim for {demo.who} ({state_name(demo.st)}), shared from Tend Navigator in ASI:One. {FICTIONAL}"
        if req.paid_cents:
            notes += (
                f" The {money(req.paid_cents)} left on the hospital bill was paid from the mock bank after a typed confirm code."
                f" The {money(demo.held_cents)} exam line stays unpaid, held under the law."
            )
        packet = {
            "st": demo.st,
            "created_at": self._now().replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "input": full,
            "output": claim,
            "notes": notes,
        }
        ciphertext, iv, key = seal(packet, rand=self._rand)
        hours = max(1, min(168, int(req.hours or self.settings.share_hours)))
        sealed = await self.api.seal_share(ciphertext, iv, hours=hours)
        url = share_link(self.settings.share_origin, str(sealed["id"]), key)
        needed = still_needed(book, full, claim)
        text = render_share(url, sealed.get("expires_at"), needed, filing_routes(book), book, claim, demo.who)
        return PacketShareReply(
            request_id=req.request_id, url=url, expires_at=sealed.get("expires_at"), text=text, still_needed=len(needed)
        )


def render_share(
    url: str,
    expires_at: str | None,
    needed: list[dict[str, Any]],
    routes: list[dict[str, Any]],
    book: RuleBook,
    claim: dict[str, Any],
    who: str,
) -> str:
    until = f" It stops working {long_date(expires_at)}." if expires_at else ""
    out = [
        "**Here is a locked link for an advocate.** It opens the claim in their browser, with the key in the link. "
        f"Tend's server keeps only a copy it cannot read.{until}",
        url,
        "**In the packet:**\n"
        f"- {book.name}'s own application with safe fields only. Name, signature, Social Security number, and anything "
        "about what happened stay blank for the survivor to fill in.\n"
        "- The cited summary: every cost with its record and the exact words of the law.\n"
        "- The letter to the billing office about the exam line.",
    ]
    if needed:
        rows = []
        for item in needed[:SHOWN_DOCUMENTS]:
            link = (
                f" ({cite_link({'pinpoint': item.get('pinpoint'), 'fragment_url': item.get('fragment_url')})})"
                if item.get("pinpoint")
                else ""
            )
            have = " In hand: the hospital bill Tend read line by line." if item.get("have_it") else ""
            rows.append(f"- {item['document']}{link}{have}")
        more = len(needed) - SHOWN_DOCUMENTS
        tail = f"\n- And {plural(more, 'more item')} in the packet." if more > 0 else ""
        out.append(f"**Still needed** (from {book.name}'s rules):\n" + "\n".join(rows) + tail)
    if routes:
        lines = [f"- {METHOD_LABEL[r['method']]}: {r['target']} ({cite_link(cite(r['rule'], book.sources))})" for r in routes]
        out.append("**Where to file:**\n" + "\n".join(lines))
    allowed = int((claim.get("totals") or {}).get("allowed_cents") or 0)
    out.append(f"**Amount {who} can ask for: {money(allowed)}. The program decides.**")
    return "\n\n".join(out)


# ======================================================================== sessions.py
# Per-person conversation state: ids, amounts, a state code, and the topic of an open question. Never the text of
# a message, a confirm code, or anything about what happened. Each session ends after two quiet hours.
#
# MemorySessions is the local agent's (nothing on disk). StorageSessions is for the Agentverse-hosted build, where
# every message runs in a fresh process and only the agent's storage carries state from one message to the next.

import asyncio
import contextlib
import copy
import time
from collections.abc import Callable
from typing import Any

TTL_S = 7200.0


class MemorySessions:
    def __init__(self, ttl_s: float = TTL_S, now: Callable[[], float] = time.monotonic):
        self.ttl_s = ttl_s
        self.now = now
        self._data: dict[str, tuple[float, dict[str, Any]]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def lock(self, key: str) -> asyncio.Lock:
        if key not in self._locks:
            self._locks[key] = asyncio.Lock()
        return self._locks[key]

    def get(self, key: str) -> dict[str, Any]:
        hit = self._data.get(key)
        if hit is None or self.now() - hit[0] > self.ttl_s:
            self._data.pop(key, None)
            return {}
        return copy.deepcopy(hit[1])

    def put(self, key: str, state: dict[str, Any]) -> None:
        if state:
            self._data[key] = (self.now(), state)
        else:
            self._data.pop(key, None)
        for k in [k for k, (at, _) in self._data.items() if self.now() - at > self.ttl_s]:
            self._data.pop(k, None)
            self._locks.pop(k, None)

    def drop(self, key: str) -> None:
        self._data.pop(key, None)


class StorageSessions:
    """Sessions in a uAgents key-value store (ctx.storage). An index of keys lets every write sweep the expired ones."""

    PREFIX = "tend:s:"
    INDEX = "tend:sessions"

    def __init__(self, storage: Any, ttl_s: float = TTL_S, now: Callable[[], float] = time.time):
        self.storage = storage
        self.ttl_s = ttl_s
        self.now = now

    def lock(self, key: str) -> contextlib.AbstractAsyncContextManager[None]:
        return contextlib.nullcontext()  # type: ignore[return-value]  # one message per run when hosted

    def _index(self) -> dict[str, float]:
        raw = self.storage.get(self.INDEX)
        return {str(k): float(v) for k, v in raw.items()} if isinstance(raw, dict) else {}

    def get(self, key: str) -> dict[str, Any]:
        raw = self.storage.get(self.PREFIX + key)
        if not isinstance(raw, dict) or self.now() - float(raw.get("at") or 0) > self.ttl_s:
            return {}
        state = raw.get("state")
        return copy.deepcopy(state) if isinstance(state, dict) else {}

    def put(self, key: str, state: dict[str, Any]) -> None:
        index = self._index()
        now = self.now()
        if state:
            self.storage.set(self.PREFIX + key, {"at": now, "state": state})
            index[key] = now
        else:
            self._remove(key)
            index.pop(key, None)
        for k in [k for k, at in index.items() if now - at > self.ttl_s]:
            self._remove(k)
            index.pop(k, None)
        self.storage.set(self.INDEX, index)

    def drop(self, key: str) -> None:
        self.put(key, {})

    def _remove(self, key: str) -> None:
        remove = getattr(self.storage, "remove", None)
        if callable(remove):
            remove(self.PREFIX + key)
        else:
            self.storage.set(self.PREFIX + key, None)


# ======================================================================== navigator.py
# The conversation: one message in, replies out. The Navigator talks with the person and orchestrates; the Law
# agent and the Bank+Packet agent do the work (desks.py). No uAgents here, so every path is testable.
#
# Session state holds ids, amounts, and short-lived choices. Never the text of a message, and never a confirm code:
# the code is shown once on the review card and only the person can type it back.

import datetime as dt
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


WELCOME = (
    "Hi. I'm Tend Navigator. I help sexual assault survivors, and the advocates who support them, get the crime "
    "victim compensation their state already promises.\n\n"
    "I never ask for your name, what happened, or anything that identifies you. You don't need an account, and I "
    "don't keep messages.\n\n"
    "- **Ask** about any state's program. I quote the law and link it, or I tell you it's not in the rules I have.\n"
    "- **Check**: the state, the date it happened (only the date), and whether there was a forensic exam or a police "
    "report. You get the deadline, the police report rules, and what is covered.\n"
    "- **Demo**: a fictional claim from start to finish. Costs from a mock bank, a hospital bill line the law says "
    "should never have been billed, a payment you approve with a code, and a locked link for an advocate."
)
TEAM = (
    "Three agents work on this: I talk with you, the Law agent reads the verified rules, and the Bank and Packet agent "
    "runs the fictional claim."
)
FIRST_NOTE = "_I never ask for your name, what happened, or anything that identifies you._"
STORY_NOTE = (
    "You don't need to tell me what happened, where, or who, and I didn't pass that message on. "
    "I only need the state, and for a Check, the date."
)
ID_NOTE = (
    "You don't need to tell me your name, where you live, or how to reach you, and I didn't pass that message on. "
    "I only need the state, and for a Check, the date."
)
HOTLINE = "If you want to talk with someone now, the National Sexual Assault Hotline is free and open all day and night: 800-656-4673."
TROUBLE = (
    "I can't reach Tend's server right now, so I can't look that up. Nothing was saved and no money moved. Please try again in a minute."
)
CONFIRM_UNSURE = (
    "I sent your code, but the Bank and Packet agent didn't answer in time, so I can't tell yet whether the payment went "
    "through. The code works once, so nothing can be paid twice. Say **check the payment** in a minute."
)
SERVER_UNSURE = (
    "Your code went to Tend's server, but its answer didn't come back, so I can't tell yet whether the payment went "
    "through. The code works once, so nothing can be paid twice. Say **check the payment** in a minute."
)
IN_PROGRESS = "The payment is still going through. Say **check the payment** in a minute."
MAYBE_PAID = (
    "The bank didn't answer, so this payment may have gone through. In a real account, check it before paying again. "
    "I won't set up another payment for this bill in this chat."
)
STILL_UNSURE = (
    "I can't tell yet whether the last payment went through, so I won't start anything new or cancel it. "
    "Say **check the payment** first, so nothing is paid twice."
)
QUESTION_START = re.compile(r"^\s*(?:can|could|does|do|is|are|will|would|what|how|who|which|when|where|if)\b", re.I)
COVERAGE_Q = re.compile(r"\b(?:which|what) (?:states|jurisdictions)\b|\ball (?:the )?states\b|\b50 states\b", re.I)
_BILL_ONLY = re.compile(r"\b(?:bill|balance|rest|it|now|payment)\b", re.I)
THANKS = re.compile(r"^\s*(?:thanks|thank you|thx|ty)\b", re.I)


@dataclass
class Reply:
    text: str
    card: Card | None = None
    card_id: str | None = None
    end_session: bool = False


@dataclass
class Turn:
    replies: list[Reply]
    state: dict[str, Any]
    intent: str = "other"


class Failure(Exception):
    """A sub-agent answered, but the work failed (the API was down or refused)."""

    def __init__(self, reply: Any):
        super().__init__(reply.error or "failed")
        self.reply = reply


def _new_id() -> str:
    return uuid.uuid4().hex


class Navigator:
    def __init__(
        self,
        desks: Any,
        settings: Settings,
        today: Callable[[], dt.date] = dt.date.today,
        new_id: Callable[[], str] = _new_id,
        team: bool = False,
    ):
        self.desks = desks
        self.settings = settings
        self.today = today
        self.new_id = new_id
        self.team = team

    async def handle(self, state: dict[str, Any] | None, msg: Incoming, desks: Any = None) -> Turn:
        s = dict(state or {})
        first = not s.get("seen")
        s["seen"] = True
        talk = _Talk(self, s, desks or self.desks)
        try:
            replies, intent = await talk.route(msg)
        except DeskDown as exc:
            replies, intent = [Reply(down_text(exc.desk))], f"{exc.desk}_down"
        except Failure as exc:
            replies, intent = [Reply(trouble_text(exc.reply))], "api_error"
        if first and replies and intent != "welcome" and not replies[0].text.startswith((STORY_NOTE, ID_NOTE)):
            replies[0].text = f"{FIRST_NOTE}\n\n{replies[0].text}"
        return Turn(replies, s, intent)

    def welcome(self) -> Reply:
        return Reply(WELCOME + (f"\n\n{TEAM}" if self.team else ""), card=welcome_card(), card_id=str(uuid.uuid4()))


def down_text(desk: str) -> str:
    who = DESK_NAMES.get(desk, "a helper agent")
    if desk == "law":
        return f"{who[0].upper()}{who[1:]} isn't answering right now, so I can't look up the rules. Nothing was saved and no money moved. Please try again in a minute."
    return f"{who[0].upper()}{who[1:]} isn't answering right now, so I can't run that step of the demo. No money moved. Please try again in a minute."


def trouble_text(reply: Any) -> str:
    if reply.error == "api_down":
        return TROUBLE
    if reply.error == "nothing_to_pay":
        return reply.text
    detail = f" ({reply.status})" if reply.status else ""
    return f"Something went wrong on Tend's server{detail}: {reply.text} Nothing was saved and no money moved."


class _Talk:
    """One turn of one person's conversation: their session state and the desks for this turn."""

    def __init__(self, nav: Navigator, s: dict[str, Any], desks: Any):
        self.nav = nav
        self.s = s
        self.d = desks

    # ------------------------------------------------------------ calling the other agents

    async def law(self, req: Any) -> Any:
        reply = await self.d.law(req)
        if not reply.ok:
            raise Failure(reply)
        return reply

    async def bank(self, req: Any, *, allow: tuple[str, ...] = ()) -> Any:
        reply = await self.d.bank(req)
        if not reply.ok and reply.error not in allow:
            raise Failure(reply)
        return reply

    def demo_ref(self) -> DemoRef:
        return DemoRef(**self.s["demo"]["ref"])

    # ------------------------------------------------------------ routing

    async def route(self, msg: Incoming) -> tuple[list[Reply], str]:
        text = msg.text.strip()
        sel = msg.selection
        if sel is None:
            sel = selection_from_text(text)
            if sel is not None:
                text = ""
        if msg.cancelled:
            return self.cancel_all(), "cancel"
        if sel:
            return await self.on_selection(sel, text)
        if not text:
            return [self.nav.welcome()], "welcome"
        kind = story_kind(text)
        replies, intent = await self.route_text(text, kind is not None)
        # A plain question that names a partner ("Can my partner apply?") is guarded without a note.
        note = kind in ("act", "identity") or (kind == "context" and not QUESTION_START.match(text))
        if note and replies and not replies[0].text.startswith((STORY_NOTE, ID_NOTE)):
            lead = ID_NOTE if kind == "identity" else STORY_NOTE + (f" {HOTLINE}" if kind == "act" else "")
            replies[0].text = f"{lead}\n\n{replies[0].text}"
        return replies, intent

    async def route_text(self, text: str, story: bool) -> tuple[list[Reply], str]:
        """Typed text (or planner prose). When it tells a story, only fields and topics are used, never the text."""
        s = self.s
        pending = self.live_pending()
        if pending:
            code = find_confirm_code(text)
            if code:
                return await self.confirm(code), "pay_confirm"
            if wants_payment_status(text):
                return await self.payment_status(), "pay_status"
            if wants_cancel(text) or says_no(text):
                return self.cancel_payment(), "pay_cancel"
            if says_yes(text) or wants_pay(text):
                return [Reply(type_code_hint(pending))], "pay_remind"
        elif find_confirm_code(text):
            if s.pop("pending_expired", False):
                return [Reply("That code has expired, so nothing moved. Say **pay the bill** for a new code.")], "pay_stale"
            return [Reply("There is no payment waiting, so nothing moved. In the demo, say **pay the bill** for a new code.")], "pay_stale"

        demo = s.get("demo")
        stage = (demo or {}).get("stage")
        # Before the demo keyword, so "share the demo claim" or "pay the demo bill" does not start over.
        if demo and wants_share(text):
            return await self.share(), "share"
        if demo and wants_pay(text):
            return await self.propose(), "pay_propose"
        if wants_demo(text):
            return await self.start_demo(find_state(text)), "demo"
        if wants_payment_status(text):
            if demo and demo.get("paid_cents"):
                return [
                    Reply(f"The demo payment went through: {money(demo['paid_cents'])} to the hospital, from the mock bank.")
                ], "pay_status"
            return [Reply("There is no payment to check in this chat.")], "pay_none"
        if demo and stage == "scanned":
            if says_yes(text):
                return await self.count(), "count"
            if says_no(text) or wants_cancel(text):
                demo["stage"] = "skipped"
                return [Reply("OK. Nothing was counted. Say **demo** any time to start over.", end_session=True)], "skip"
        if not demo and wants_pay(text) and _BILL_ONLY.search(text):
            return [Reply("There is no bill to pay in this chat yet. Say **demo** to walk through the fictional claim first.")], "pay_none"
        if not demo and wants_share(text):
            return [
                Reply("There is no claim to share in this chat yet. Say **demo** to walk through the fictional claim first.")
            ], "share_none"
        if THANKS.search(text) and len(text) < 40:
            return [Reply("You're welcome. I'm here if you have another question.", end_session=True)], "thanks"
        if COVERAGE_Q.search(text):
            reply = await self.law(LawCoverageRequest(request_id=self.nav.new_id()))
            return [Reply(reply.text)], "coverage"

        st = find_state(text)
        today = self.nav.today()
        found = find_date(text, today)
        exam, report = find_exam(text), find_report(text)
        awaiting = s.pop("awaiting", None) or {}

        if awaiting.get("kind") == "check" and (st or awaiting.get("st")):
            fields = {
                "date": found.date.isoformat() if found and not found.future else awaiting.get("date"),
                "exam": exam or awaiting.get("exam"),
                "report": report or awaiting.get("report"),
            }
            return await self.check(st or awaiting["st"], fields, future=bool(found and found.future)), "check"

        topics, expense = find_topics(text), find_expense(text)
        if wants_check(text) or (asks_eligibility(text) and (found or exam or report)):
            fields = {"date": found.date.isoformat() if found and not found.future else None, "exam": exam, "report": report}
            if st:
                return await self.check(st, fields, future=bool(found and found.future)), "check"
            s["awaiting"] = {"kind": "check", **fields}
            return [
                Reply("Which state? Pick it on the card, or type the name.", card=check_form(), card_id=str(uuid.uuid4()))
            ], "check_form"

        if awaiting.get("kind") == "question" and st and not topics and not expense:
            topics, expense = awaiting.get("topics") or [], awaiting.get("expense")
            return await self.answer(st, None, topics, expense), "answer"

        if is_greeting(text) and not st and not topics and not expense:
            return [self.nav.welcome()], "welcome"

        st = st or s.get("st")
        if not st:
            if topics or expense or "?" in text or story:
                s["awaiting"] = {"kind": "question", "topics": topics, "expense": expense}
                return [Reply("Which state is this about? You can type a name like Ohio, or DC.")], "ask_state"
            return [self.nav.welcome()], "welcome"
        if story and not topics and not expense:
            return [Reply(f"What would you like to know about the {state_name(st)} program?")], "story"
        return await self.answer(st, None if story else text, topics, expense), "answer"

    async def on_selection(self, sel: dict[str, Any], text: str) -> tuple[list[Reply], str]:
        s = self.s
        action = str(sel.get("action") or "")
        pending = self.live_pending()
        if action == "check_form":
            s["awaiting"] = {"kind": "check"}
            card = check_form(s.get("st"))
            return [
                Reply('Fill in what you know. Every answer except the state can be "not sure".', card=card, card_id=str(uuid.uuid4()))
            ], "check_form"
        if action == "check":
            st = str(sel.get("st") or "").upper()
            if st not in STATES:
                s["awaiting"] = {"kind": "check"}
                return [Reply("Pick a state first.", card=check_form(), card_id=str(uuid.uuid4()))], "check_form"
            raw_date = str(sel.get("incident_date") or "").strip()
            date = parse_iso_date(raw_date)
            if raw_date and date is None:
                found = find_date(raw_date, self.nav.today())
                date = found.date if found else None
            future = bool(date and date > self.nav.today())
            fields = {
                "date": date.isoformat() if date and not future else None,
                "exam": sel.get("forensic_exam"),
                "report": sel.get("police_report"),
            }
            s.pop("awaiting", None)
            return await self.check(st, fields, future=future, unreadable_date=bool(raw_date and date is None)), "check"
        if action == "demo":
            return await self.start_demo(None), "demo"
        if action == "count_costs":
            demo = s.get("demo") or {}
            if demo.get("stage") == "scanned" and sel.get("scan_id") in (None, demo["ref"].get("scan_id")):
                return await self.count(), "count"
            return [Reply("That demo has ended. Say **demo** to start a new one.")], "stale"
        if action == "skip_costs":
            if s.get("demo"):
                s["demo"]["stage"] = "skipped"
            return [Reply("OK. Nothing was counted. Say **demo** any time to start over.", end_session=True)], "skip"
        if action == "pay":
            if s.get("demo"):
                return await self.propose(), "pay_propose"
            return [Reply("There is no bill to pay in this chat yet. Say **demo** to start.")], "pay_none"
        if action == "share":
            if s.get("demo"):
                return await self.share(), "share"
            return [Reply("There is no claim to share in this chat yet. Say **demo** to start.")], "share_none"
        if action in ("pay_approve", "pay_confirm", "pay_cancel"):
            if not pending or sel.get("action_id") not in (None, pending["action_id"]):
                return [Reply("That payment is no longer waiting. Nothing moved. Say **pay the bill** for a new code.")], "stale"
            if action == "pay_cancel":
                return self.cancel_payment(), "pay_cancel"
            code = find_confirm_code(str(sel.get("code") or "")) if sel.get("code") else None
            if action == "pay_confirm" and code:
                return await self.confirm(code), "pay_confirm"
            return [
                Reply(
                    "Type the 6-digit code from the review card, here or in this box. Only you can approve the payment.",
                    card=code_form(pending["action_id"], pending["amount_cents"]),
                    card_id=str(uuid.uuid4()),
                )
            ], "pay_code_form"
        if text:
            return await self.route(Incoming(text=text))
        return [self.nav.welcome()], "welcome"

    # ------------------------------------------------------------ the Law agent: cited answers and Checks

    async def answer(self, st: str, question: str | None, topics: list[str], expense: str | None) -> list[Reply]:
        """question is None when the person's words must not leave the Navigator: the Law agent then answers a
        question rebuilt from the topic alone."""
        self.s["st"] = st
        reply = await self.law(LawAnswerRequest(request_id=self.nav.new_id(), st=st, question=question, topics=topics, expense=expense))
        return [Reply(reply.text)]

    async def check(self, st: str, fields: dict[str, Any], *, future: bool = False, unreadable_date: bool = False) -> list[Reply]:
        self.s["st"] = st
        req = LawCheckRequest(
            request_id=self.nav.new_id(),
            st=st,
            incident_date=fields.get("date"),
            forensic_exam=exam_value(fields.get("exam")),
            police_report=report_value(fields.get("report")),
        )
        reply = await self.law(req)
        text = reply.text
        if future:
            text = "That date is in the future, so I left it out.\n\n" + text
        elif unreadable_date:
            text = "I couldn't read that date, so I left it out. Use a form like 2026-06-14.\n\n" + text
        if not self.s.get("demo"):
            text += "\n\nTo see how a claim comes together, say **show me the demo claim**. It uses a fictional person."
        return [Reply(text)]

    # ------------------------------------------------------------ the Bank and Packet agent: the fictional demo

    async def start_demo(self, st: str | None) -> list[Reply]:
        if self.unsure():
            return [Reply(STILL_UNSURE)]
        reply = await self.bank(DemoStartRequest(request_id=self.nav.new_id(), st=st))
        ref = reply.demo.model_dump()
        self.s["demo"] = {"ref": ref, "stage": "scanned"}
        self.s.pop("pending", None)
        bill = {"lines": ref["bill_lines"], "total_cents": ref["bill_total_cents"]} if ref.get("bill_lines") else None
        card = count_costs_card([g.model_dump() for g in reply.groups], bill, scan_id=ref["scan_id"])
        text = reply.text + "\n\nNothing counts until the survivor says yes. Count these for the demo claim? Say **yes** or **not now**."
        return [Reply(text, card=card, card_id=str(uuid.uuid4()))]

    async def count(self) -> list[Reply]:
        demo = self.s["demo"]
        reply = await self.bank(DemoCountRequest(request_id=self.nav.new_id(), demo=self.demo_ref()))
        demo["stage"] = "counted"
        ref = demo["ref"]
        replies = [Reply(reply.text)]
        nxt = self.next_step_text(ref, paid=False)
        if reply.letter:
            letter = (
                "**Letter to the billing office.** Copy it, fill in the [brackets], and send it. It asks billing to "
                f"remove the exam line and quotes the law:\n\n```\n{reply.letter.rstrip()}\n```"
            )
            replies.append(Reply(f"{letter}\n\n{nxt}", card=next_steps_card(ref["payable_cents"], paid=False), card_id=str(uuid.uuid4())))
        else:
            replies.append(Reply(nxt, card=next_steps_card(ref["payable_cents"], paid=False), card_id=str(uuid.uuid4())))
        return replies

    def next_step_text(self, ref: dict[str, Any], *, paid: bool) -> str:
        share = "say **share with an advocate** for a locked link to this claim."
        if ref.get("payable_cents") and not paid:
            return (
                f"The rest of the hospital bill is **{money(ref['payable_cents'])}**. Want to pay it from {ref['account_label']} "
                f"(mock bank)? Say **pay the bill**. Nothing moves until you type a code. Or {share}"
            )
        return f"Next, {share}"

    async def propose(self) -> list[Reply]:
        demo = self.s["demo"]
        if demo.get("stage") == "scanned":
            return [Reply("Count the costs first: say **yes** to count them for the demo claim.")]
        if demo.get("stage") == "skipped":
            return [Reply("The demo costs were not counted. Say **demo** to start again, then **yes** to count them.")]
        if demo.get("paid_cents"):
            return [Reply("The demo bill is already paid. Say **share with an advocate** for the locked link, or **demo** to start over.")]
        if self.unsure():
            return [Reply(STILL_UNSURE)]
        if demo.get("maybe_paid_cents"):
            return [Reply(MAYBE_PAID + " Say **share with an advocate** for the locked link.")]
        reply = await self.bank(PayProposeRequest(request_id=self.nav.new_id(), demo=self.demo_ref()), allow=("nothing_to_pay",))
        if not reply.ok:
            return [Reply(reply.text)]
        card_id = str(uuid.uuid4())
        self.s["pending"] = {
            "action_id": reply.action_id,
            "amount_cents": reply.amount_cents,
            "expires_at": reply.expires_at,
            "card_id": card_id,
        }
        view = {
            "action_id": reply.action_id,
            "amount_cents": reply.amount_cents,
            "code": reply.confirm_code or "",
            "payee_label": reply.payee_label,
            "from_label": reply.from_label,
            "lines_label": reply.lines_label,
            "held_cents": reply.held_cents,
            "bank_label": "Dry run: recorded and read back, not sent" if reply.dry_run else "Nessie mock bank (a real API write)",
        }
        narration = (
            f"Here is the payment to review. **Nothing moves until you type the code.** To pay {money(reply.amount_cents)}, "
            f"type **{reply.confirm_code}** here. To stop, say cancel. The code works once and ends in 10 minutes. {FICTIONAL_SHORT}"
        )
        return [Reply(narration, card=payment_card(view), card_id=card_id)]

    async def confirm(self, code: str) -> list[Reply]:
        pending = self.s["pending"]
        req = PayConfirmRequest(request_id=self.nav.new_id(), action_id=pending["action_id"], confirm_code=code, demo=self.demo_ref())
        try:
            reply = await self.bank(req)
        except DeskDown:
            pending["unsure"] = True  # the code may have gone through; only a status check can say
            return [Reply(CONFIRM_UNSURE)]
        return self.after_payment(reply)

    async def payment_status(self) -> list[Reply]:
        pending = self.live_pending()
        if not pending or not self.s.get("demo"):
            return [Reply("There is no payment to check in this chat.")]
        action_id = pending["action_id"]
        reply = await self.bank(PayStatusRequest(request_id=self.nav.new_id(), action_id=action_id, demo=self.demo_ref()))
        if reply.outcome == "waiting":
            # The API never took the code (it was lost on the way), so nothing moved and the code still works.
            pending["unsure"] = False
            return [Reply("Nothing has moved yet. " + type_code_hint(pending))]
        return self.after_payment(reply)

    def after_payment(self, reply: Any) -> list[Reply]:
        demo = self.s.get("demo") or {}
        if reply.outcome in ("done", "unverified"):
            self.s.pop("pending", None)
            demo["paid_cents"] = reply.amount_cents
            demo["stage"] = "paid" if demo.get("stage") != "shared" else "shared"
            text = f"{reply.text}\n\n{self.next_step_text(demo.get('ref') or {}, paid=True)}"
            card = next_steps_card(0, paid=True)
            return [Reply(text, card=card, card_id=str(uuid.uuid4()))]
        if reply.outcome == "wrong_code":
            return [Reply("That code does not match. Nothing moved. Check the code on the review card and type it again.")]
        if reply.outcome == "maybe":
            self.s.pop("pending", None)
            demo["maybe_paid_cents"] = reply.amount_cents
            return [Reply(f"{MAYBE_PAID}\n\n{self.next_step_text(demo.get('ref') or {}, paid=True)}")]
        if reply.outcome in ("unknown", "in_progress"):
            if self.s.get("pending"):
                self.s["pending"]["unsure"] = True
            return [Reply(SERVER_UNSURE if reply.outcome == "unknown" else IN_PROGRESS)]
        self.s.pop("pending", None)
        lead = {
            "expired": "That code expired. Nothing moved. Say **pay the bill** for a new code.",
            "locked": "Too many wrong codes, so this payment is locked. Nothing moved. Say **pay the bill** to start again.",
            "not_found": "That payment is no longer waiting. Nothing moved. Say **pay the bill** for a new code.",
        }.get(reply.outcome, reply.text or "The payment did not go through. Nothing moved.")
        return [Reply(lead)]

    async def share(self) -> list[Reply]:
        demo = self.s["demo"]
        if demo.get("stage") in ("scanned", "skipped"):
            return [Reply("Count the demo claim first, so the link has something to show. Say **yes** to count the costs.")]
        req = PacketShareRequest(
            request_id=self.nav.new_id(),
            demo=self.demo_ref(),
            paid_cents=int(demo.get("paid_cents") or 0),
            hours=self.nav.settings.share_hours,
        )
        reply = await self.bank(req)
        demo["stage"] = "shared"
        expires = long_date(reply.expires_at) if reply.expires_at else "when it expires"
        card = share_card(expires, reply.still_needed)
        return [Reply(reply.text, card=card, card_id=str(uuid.uuid4()), end_session=True)]

    # ------------------------------------------------------------ payments waiting for a code

    def unsure(self) -> bool:
        """True while a code went to the server and no answer said whether the payment went through."""
        return bool((self.s.get("pending") or {}).get("unsure"))

    def cancel_payment(self) -> list[Reply]:
        if self.unsure():  # the code already went out: saying "no money moved" could be false
            return [Reply(STILL_UNSURE)]
        self.s.pop("pending", None)
        return [Reply("Cancelled. No money moved. The code will not work from this chat.", end_session=True)]

    def cancel_all(self) -> list[Reply]:
        self.s.pop("awaiting", None)
        if self.unsure():
            return [Reply(STILL_UNSURE)]
        had_payment = self.s.pop("pending", None) is not None
        return [Reply("Cancelled. No money moved." if had_payment else "OK. Nothing was changed.", end_session=True)]

    def live_pending(self) -> dict[str, Any] | None:
        pending = self.s.get("pending")
        if not pending:
            return None
        expires = pending.get("expires_at")
        if isinstance(expires, str) and not pending.get("unsure"):
            try:
                at = dt.datetime.fromisoformat(expires.replace("Z", "+00:00"))
                if at <= dt.datetime.now(dt.UTC):
                    self.s.pop("pending", None)
                    self.s["pending_expired"] = True
                    return None
            except ValueError:
                pass
        return pending


def type_code_hint(pending: dict[str, Any]) -> str:
    if pending.get("unsure"):
        return STILL_UNSURE
    return (
        f"To pay {money(pending['amount_cents'])}, type the 6-digit code from the review card. "
        "That step makes sure a person approves every payment. Say cancel to stop."
    )


# ======================================================================== chat.py
# The Agent Chat Protocol in and out: text, card clicks, and session markers in; text, cards, and an end-of-session
# marker out. Shared by the local Navigator and the Agentverse-hosted build.
#
# Cards are read and written as plain MetadataContent (card_protocol_version 1), so this works with any uagents-core
# that has the chat protocol.

import json
import uuid
from typing import Any

from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    MetadataContent,
    StartSessionContent,
    TextContent,
)


MAX_TEXT = 2000
SORRY = "Something went wrong on my side. Nothing was saved and no money moved. Please try again."


def card_content(card: Card, card_id: str | None = None) -> MetadataContent:
    meta = {
        "card_protocol_version": "1",
        "requires_card_interaction": "true",
        "card_kind": card.kind,
        "card_payload": json.dumps(card.payload, separators=(",", ":"), ensure_ascii=False),
    }
    if card_id:
        meta["card_id"] = str(uuid.UUID(card_id))
    return MetadataContent(metadata=meta)


def card_response(meta: dict[str, str]) -> dict[str, Any] | None:
    """A card click or dismissal (a card_protocol_version 1 block without card_kind), else None."""
    if meta.get("card_protocol_version") != "1" or "card_kind" in meta:
        return None
    selection = None
    raw = meta.get("selection")
    if raw is not None:
        try:
            selection = json.loads(raw)
        except ValueError:
            return None
        if not isinstance(selection, dict):
            return None
    return {
        "selection": selection,
        "cancelled": meta.get("cancelled") == "true",
        "text": meta.get("text"),
        "card_id": meta.get("card_id"),
    }


def incoming_from(msg: ChatMessage) -> Incoming:
    """Text, a card click (MetadataContent, or JSON text from a direct @mention), and session markers."""
    texts: list[str] = []
    selection: dict[str, Any] | None = None
    cancelled = False
    card_id: str | None = None
    start = end = False
    for c in msg.content:
        if isinstance(c, TextContent):
            texts.append(c.text)
        elif isinstance(c, MetadataContent):
            resp = card_response(dict(c.metadata))
            if resp is None:
                continue
            if resp["selection"] is not None:
                selection = dict(resp["selection"])
            cancelled = cancelled or resp["cancelled"]
            card_id = resp["card_id"] or card_id
            if resp["text"] and resp["selection"] is None:
                texts.append(resp["text"])
        elif isinstance(c, StartSessionContent):
            start = True
        elif isinstance(c, EndSessionContent):
            end = True
    text = " ".join(t for t in texts if t).strip()[:MAX_TEXT]
    if selection is None:
        from_text = selection_from_text(text)
        if from_text is not None:
            selection, text = from_text, ""
    return Incoming(text=text, selection=selection, cancelled=cancelled, card_id=card_id, start=start, end=end)


def to_chat(reply: Reply) -> ChatMessage:
    content: list[Any] = [TextContent(text=reply.text)]
    if reply.card is not None:
        content.append(card_content(reply.card, reply.card_id))
    if reply.end_session:
        content.append(EndSessionContent())
    return ChatMessage(content=content)


async def handle_chat(ctx: Any, sender: str, msg: ChatMessage, navigator: Navigator, sessions: Any, desks: Any = None) -> None:
    await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=msg.msg_id))
    incoming = incoming_from(msg)
    if incoming.empty:
        if incoming.end:
            sessions.drop(sender)
        return
    async with sessions.lock(sender):
        try:
            turn = await navigator.handle(sessions.get(sender), incoming, desks)
            sessions.put(sender, turn.state)
            replies, intent = turn.replies, turn.intent
        except Exception as exc:  # never leak a traceback (or the message) to the chat
            ctx.logger.error(f"turn failed: {type(exc).__name__}")
            replies, intent = [Reply(SORRY)], "error"
    for reply in replies:
        await ctx.send(sender, to_chat(reply))
    # The kind of turn only. Message text never reaches the logs.
    ctx.logger.info(f"turn intent={intent} replies={len(replies)} cards={sum(r.card is not None for r in replies)}")


# ======================================================================== hosted.py
# The Navigator as an Agentverse-hosted agent: always on, no laptop needed.
#
# Agentverse runs one agent per hosted file, so the Law and Bank+Packet desks run inside the Navigator's process
# here (desks.LocalDesks) instead of as separate agents. The conversation, the API calls, and every safeguard are the
# same code. Each message runs fresh on Agentverse, so the short session state (ids and amounts, never message text
# or a code) lives in the agent's own storage for at most two hours.
#
# scripts/build_hosted.py bundles this module and the ones it uses into hosted/navigator_hosted.py.

from typing import Any

from uagents import Context, Protocol
from uagents_core.contrib.protocols.chat import ChatAcknowledgement, ChatMessage, chat_protocol_spec



def hosted_settings(api_url: str = PUBLIC_SITE, public_url: str = PUBLIC_SITE) -> Settings:
    return Settings(api_url=api_url.rstrip("/"), app_url=public_url.rstrip("/"), timeout_s=25.0)


def attach(agent: Any, settings: Settings) -> Protocol:
    """Give an agent (the one Agentverse provides, or any uAgent) the Agent Chat Protocol and the Navigator."""
    chat = Protocol(spec=chat_protocol_spec)

    @chat.on_message(ChatMessage)
    async def on_chat(ctx: Context, sender: str, msg: ChatMessage) -> None:
        api = TendApi(settings.api_url, timeout=settings.timeout_s, agent_key=settings.agent_key)
        try:
            navigator = Navigator(LocalDesks(LawDesk(api, settings), BankDesk(api, settings)), settings)
            await handle_chat(ctx, sender, msg, navigator, StorageSessions(ctx.storage))
        finally:
            await api.aclose()

    @chat.on_message(ChatAcknowledgement)
    async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement) -> None:
        return None

    agent.include(chat, publish_manifest=True)
    return chat


# ======================================================================== Agentverse entry point

from uagents import Agent  # noqa: E402 - Agentverse provides the hosted agent through this class

agent = Agent()
attach(agent, hosted_settings(TEND_API_URL, TEND_PUBLIC_URL))

if __name__ == "__main__":
    agent.run()
