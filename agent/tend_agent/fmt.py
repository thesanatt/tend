"""Plain words for money, expenses, dates, and law citations. Integer cents only."""

from __future__ import annotations

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
