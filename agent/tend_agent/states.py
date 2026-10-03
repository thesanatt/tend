"""The 51 jurisdictions Tend covers, and finding one in a sentence."""

from __future__ import annotations

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
_CONTEXT = re.compile(r"\b(?:in|for|state|st|of|check|about)\s*$", re.I)

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
            if code in _AMBIGUOUS and not _CONTEXT.search(text[: m.start()]):
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
