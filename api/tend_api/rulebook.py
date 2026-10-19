"""The public law corpus as the API serves it: full-text search, and the database kept in step with
rules/verified and rules/ir.

Each search result is a verified rule's own plain summary next to its verbatim quote, pinpoint, and a
link that opens the source at that quote.
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
from .search import Query, citation, parse_query, rank


class RulebookError(TendError):
    pass


ImageFn = Callable[[str], list[dict[str, Any]]]


class Rulebook:
    def __init__(self, repo: Repository, rules: RulesStore, ir: LawIR, images: ImageFn | None = None):
        self.repo = repo
        self.rules = rules
        self.ir = ir
        self.images = images
        # Jurisdiction rows change only when the corpus is loaded, so they are kept in memory until then.
        self._rows: dict[str, dict[str, Any] | None] = {}

    def jurisdiction(self, st: str) -> dict[str, Any] | None:
        if st not in self._rows:
            row = self.repo.jurisdiction(st)
            if row is None:
                return None  # not cached: the loader may fill it in a moment
            self._rows[st] = row
        return self._rows[st]

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
        result = self.repo.load_corpus(bundles, force=force)
        self._rows.clear()
        return result

    def ensure_loaded(self) -> dict[str, Any] | None:
        """Load whatever changed on disk. Cheap when nothing did: one query and the file hashes."""
        stale = self.stale()
        return self.load(stale) if stale else None

    def status(self) -> dict[str, Any]:
        counts = self.repo.corpus_counts()
        return {"backend": self.repo.backend, **counts, "stale": self.stale() if counts["jurisdictions"] else self.rules.codes()}

    # search

    def _require(self, st: str) -> dict[str, Any]:
        row = self.jurisdiction(st)
        if row is None:
            if self.rules.get(st) is None:
                raise RulebookError(f"No verified rules for {st}.", 404)
            raise RulebookError("The rules corpus is not loaded into the database yet. Run: uv run python -m tend_api.loader", 503)
        return row

    def _query(self, text: str, st: str | None) -> Query:
        drop: set[str] = set()
        if st:
            name = (self.jurisdiction(st) or {}).get("name") or ""
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
