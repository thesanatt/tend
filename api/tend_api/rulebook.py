"""The public law corpus as the API serves it: full-text search, and cited answers that refuse.

Answers are assembled, not written: each point is a verified rule's own plain summary next to its
verbatim quote, pinpoint, and a link that opens the source at that quote. When no rule supports an
answer, the answer says so and points to the program instead of guessing.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable
from typing import Any

from .db import Repository, read_bundles
from .engine import LawIR
from .errors import TendError
from .rules import RulesStore
from .search import Query, citation, parse_query, rank, supported

NOTE = "From {name}'s verified rules. Rules can have exceptions. The program decides."
DC_NAMES = ("district of columbia", "washington dc", "washington d c", "d c")


class RulebookError(TendError):
    pass


ImageFn = Callable[[str], list[dict[str, Any]]]


class Rulebook:
    def __init__(self, repo: Repository, rules: RulesStore, ir: LawIR, images: ImageFn | None = None):
        self.repo = repo
        self.rules = rules
        self.ir = ir
        self.images = images
        self._names: list[tuple[str, str]] | None = None

    # keeping the database in step with rules/verified and rules/ir

    def file_hashes(self) -> dict[str, dict[str, str | None]]:
        out = {}
        for st in self.rules.codes():
            ir_path = self.ir.path(st)
            out[st] = {
                "verified_sha256": self.rules.file_sha256(st),
                "ir_sha256": hashlib.sha256(ir_path.read_bytes()).hexdigest() if ir_path else None,
            }
        return out

    def stale(self) -> list[str]:
        loaded = self.repo.corpus_hashes()
        return sorted(st for st, h in self.file_hashes().items() if loaded.get(st) != h)

    def load(self, states: list[str] | None = None, force: bool = False) -> dict[str, Any]:
        bundles = read_bundles(self.rules.rules_dir, self.ir.ir_dir, states, self.images)
        return self.repo.load_corpus(bundles, force=force)

    def ensure_loaded(self) -> dict[str, Any] | None:
        """Load whatever changed on disk. Cheap when nothing did: one query and the file hashes."""
        stale = self.stale()
        return self.load(stale) if stale else None

    def status(self) -> dict[str, Any]:
        counts = self.repo.corpus_counts()
        return {"backend": self.repo.backend, **counts, "stale": self.stale() if counts["jurisdictions"] else self.rules.codes()}

    # search

    def _require(self, st: str) -> dict[str, Any]:
        row = self.repo.jurisdiction(st)
        if row is None:
            if self.rules.get(st) is None:
                raise RulebookError(f"No verified rules for {st}.", 404)
            raise RulebookError("The rules corpus is not loaded into the database yet. Run: uv run python -m tend_api.loader", 503)
        return row

    def _query(self, text: str, st: str | None) -> Query:
        drop: set[str] = set()
        if st:
            name = (self.repo.jurisdiction(st) or {}).get("name") or ""
            drop = set(re.findall(r"[a-z]+", name.lower()))
        return parse_query(text, drop)

    def search(self, q: str, st: str | None, limit: int = 20) -> dict[str, Any]:
        if st:
            self._require(st)
        query = self._query(q, st)
        hits = self.repo.search_rules(query.terms, st, max(limit, 30))
        intent = self.repo.rules_where(st, query.categories, query.expenses) if st else []
        ranked = [r for r in rank(query, hits, intent) if r["fts"] > 0 or r["intent"] > 0.5][:limit]
        return {
            "q": q,
            "st": st,
            "backend": self.repo.backend,
            "count": len(ranked),
            "intents": {"categories": sorted(query.categories), "expenses": sorted(query.expenses), "tags": sorted(query.tags)},
            "results": [{**citation(r), "st": r["st"], "score": r["rank"]} for r in ranked],
        }

    # answers

    def state_names(self) -> list[tuple[str, str]]:
        if self._names is None:
            names = [(str((self.rules.get(st) or {}).get("name") or "").lower(), st) for st in self.rules.codes()]
            names += [(n, "DC") for n in DC_NAMES if "DC" in self.rules.codes()]
            self._names = sorted((n for n in names if n[0]), key=lambda n: -len(n[0]))
        return self._names

    def detect_state(self, text: str) -> str | None:
        low = " " + re.sub(r"[^a-z]+", " ", text.lower()) + " "
        for name, st in self.state_names():
            if f" {name} " in low:
                return st
        return None

    def _contact(self, st: str, program: dict[str, Any]) -> dict[str, Any]:
        source = self.repo.source(st, program.get("phone_source_id") or "") if program.get("phone_source_id") else None
        return {
            "phone": program.get("phone"),
            "website": program.get("website"),
            "apply_url": program.get("apply_url"),
            "source": {k: source.get(k) for k in ("id", "title", "url", "sha256")} if source else None,
        }

    def answer(self, question: str, st: str | None = None) -> dict[str, Any]:
        st = st or self.detect_state(question)
        if st is None:
            return {
                "answered": False,
                "reason": "no_state",
                "question": question,
                "message": "Which state? Tend answers from one state's verified rules at a time.",
            }
        row = self._require(st)
        name, program = row["name"], row.get("program") or {}
        contact = self._contact(st, program)
        query = self._query(question, st)
        hits = self.repo.search_rules(query.terms, st, 30)
        intent = self.repo.rules_where(st, query.categories, query.expenses)
        picked = supported(query, rank(query, hits, intent))
        base = {"st": st, "name": name, "question": question, "backend": self.repo.backend, "contact": contact}
        if not picked and query.contact and contact["phone"]:
            return {
                **base,
                "answered": True,
                "answer": f"You can call {name}'s program at {contact['phone']}.",
                "points": [],
                "note": NOTE.format(name=name),
            }
        if not picked:
            call = f" The program can answer it: {contact['phone']}." if contact["phone"] else ""
            return {
                **base,
                "answered": False,
                "reason": "no_rule",
                "message": f"I could not find a verified {name} rule about that, so I will not guess.{call}",
            }
        points = [{"text": r.get("summary") or "", **citation(r)} for r in picked]
        return {
            **base,
            "answered": True,
            "answer": points[0]["text"],
            "points": points,
            "intents": {"categories": sorted(query.categories), "expenses": sorted(query.expenses), "tags": sorted(query.tags)},
            "note": NOTE.format(name=name),
        }
