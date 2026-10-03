from __future__ import annotations

import json
import re
import threading
from pathlib import Path
from typing import Any

from .money import sha256_hex

_STATE = re.compile(r"^[A-Z]{2}$")


class RulesStore:
    """Read-only view of rules/verified/<ST>.json, reloaded when a file changes on disk."""

    def __init__(self, rules_dir: Path):
        self.rules_dir = rules_dir
        self._cache: dict[str, tuple[float, dict[str, Any], str]] = {}
        self._lock = threading.Lock()

    def codes(self) -> list[str]:
        if not self.rules_dir.is_dir():
            return []
        return sorted(p.stem for p in self.rules_dir.glob("*.json") if _STATE.match(p.stem))

    def path(self, st: str) -> Path:
        return self.rules_dir / f"{st}.json"

    def get(self, st: str) -> dict[str, Any] | None:
        st = st.upper()
        if not _STATE.match(st):
            return None
        path = self.path(st)
        try:
            mtime = path.stat().st_mtime
        except FileNotFoundError:
            return None
        with self._lock:
            cached = self._cache.get(st)
            if cached and cached[0] == mtime:
                return cached[1]
            raw = path.read_bytes()
            doc = json.loads(raw)
            self._cache[st] = (mtime, doc, sha256_hex(raw))
            return doc

    def file_sha256(self, st: str) -> str | None:
        if self.get(st) is None:
            return None
        return self._cache[st.upper()][2]

    def rules_by_id(self, st: str) -> dict[str, dict[str, Any]]:
        doc = self.get(st) or {}
        return {r["id"]: r for r in doc.get("rules", [])}

    def sources_by_id(self, st: str) -> dict[str, dict[str, Any]]:
        doc = self.get(st) or {}
        return {s["id"]: s for s in doc.get("sources", [])}

    def summary(self, st: str) -> dict[str, Any] | None:
        doc = self.get(st)
        if doc is None:
            return None
        program = doc.get("program", {})
        categories = sorted({r.get("category") for r in doc.get("rules", []) if r.get("category")})
        return {
            "jurisdiction": doc.get("jurisdiction", st),
            "name": doc.get("name"),
            "program_name": program.get("program_name"),
            "agency": program.get("agency"),
            "phone": program.get("phone"),
            "rule_count": len(doc.get("rules", [])),
            "source_count": len(doc.get("sources", [])),
            "categories": categories,
            "confidence": doc.get("confidence"),
        }


def rule_expense(rule: dict[str, Any]) -> str | None:
    return rule.get("expense") or (rule.get("params") or {}).get("expense")


def citation(rule: dict[str, Any], sources: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """The proof for one rule: what the packet, share view, and audit show next to a dollar."""
    source = sources.get(rule.get("source_id", ""), {})
    return {
        "rule_id": rule["id"],
        "category": rule.get("category"),
        "pinpoint": rule.get("pinpoint"),
        "summary": rule.get("summary"),
        "quote": rule.get("quote"),
        "fragment_url": rule.get("fragment_url"),
        "source_id": rule.get("source_id"),
        "source_title": source.get("title"),
        "source_url": source.get("url"),
        "source_sha256": source.get("sha256"),
        "retrieved_at": source.get("retrieved_at"),
    }
