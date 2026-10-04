"""Law versions and the law's own words, served from Neon.

A law version is the whole verified corpus at one git commit, published by scripts/neon/law_versions.py as
its own Neon branch (law-<date>-<short sha>). The production database keeps the index of those branches
(law_versions, law_version_files). A version's rules are read from its own branch, by host, as the
SELECT-only role, and kept in memory once read, because a published version never changes. Before a
branch is trusted, it must name the version and hold exactly that version's files.

Comparing two versions of one state reads both branches only when the state's files differ; the index
answers "unchanged" by itself. Every rule in a diff carries its verbatim quote and a link that opens the
source at that quote.
"""

from __future__ import annotations

import hashlib
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from typing import Any

from .db import Repository, corpus_sha256
from .errors import TendError
from .money import canonical_json

BranchOpener = Callable[[dict[str, Any]], Repository]
FileHashes = Callable[[str], dict[str, str | None] | None]

# What changed about a rule, in three plain groups, plus its saved source copy.
KINDS: dict[str, tuple[str, ...]] = {
    "text": ("quote", "pinpoint", "source_id", "fragment_url"),  # the law's words and where they are
    "meaning": ("category", "expense", "params", "summary"),  # how Tend reads the rule
    "engine": ("ir", "ir_kind", "skipped_reason"),  # what the law engine does with it
}
PUBLIC_RULE = (
    "category",
    "expense",
    "summary",
    "quote",
    "pinpoint",
    "fragment_url",
    "source_id",
    "source_title",
    "source_url",
    "source_sha256",
    "ir_kind",
    "skipped_reason",
)
REGISTRY_TTL_S = 60.0


class LawError(TendError):
    pass


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, (dict, list)) or isinstance(b, (dict, list)):
        return canonical_json(a) == canonical_json(b)
    return a == b


def public_rule(r: dict[str, Any]) -> dict[str, Any]:
    return {"rule_id": r["id"], "st": r["st"], **{k: r.get(k) for k in PUBLIC_RULE}}


def _source(s: dict[str, Any]) -> dict[str, Any]:
    return {"source_id": s["id"], "title": s.get("title"), "url": s.get("url"), "kind": s.get("kind"), "sha256": s.get("sha256")}


def diff_state(
    before: list[dict[str, Any]], after: list[dict[str, Any]], before_sources: list[dict[str, Any]], after_sources: list[dict[str, Any]]
) -> dict[str, Any]:
    """Rules added, removed, and changed between two versions of one state's corpus, with their quotes."""
    old = {r["id"]: r for r in before}
    new_ids = {r["id"] for r in after}
    added = [public_rule(r) for r in after if r["id"] not in old]
    removed = [public_rule(r) for r in before if r["id"] not in new_ids]
    changed = []
    for r in after:
        prev = old.get(r["id"])
        if prev is None:
            continue
        fields = [f for group in KINDS.values() for f in group if not _same(prev.get(f), r.get(f))]
        kinds = [k for k, group in KINDS.items() if any(f in fields for f in group)]
        if prev.get("source_id") == r.get("source_id") and prev.get("source_sha256") != r.get("source_sha256"):
            fields.append("source_sha256")
            kinds.append("source_copy")
        if fields:
            changed.append(
                {
                    "rule_id": r["id"],
                    "kinds": kinds,
                    "fields": fields,
                    "before": {f: prev.get(f) for f in fields},
                    "after": {f: r.get(f) for f in fields},
                    "rule": public_rule(r),
                }
            )
    src_old = {s["id"]: s for s in before_sources}
    src_new = {s["id"] for s in after_sources}
    sources = {
        "added": [_source(s) for s in after_sources if s["id"] not in src_old],
        "removed": [_source(s) for s in before_sources if s["id"] not in src_new],
        "changed": [
            {**_source(s), "sha256_before": src_old[s["id"]].get("sha256"), "url_before": src_old[s["id"]].get("url")}
            for s in after_sources
            if s["id"] in src_old and (src_old[s["id"]].get("sha256") != s.get("sha256") or src_old[s["id"]].get("url") != s.get("url"))
        ],
    }
    counts = {
        "added": len(added),
        "removed": len(removed),
        "changed": len(changed),
        "sources_added": len(sources["added"]),
        "sources_removed": len(sources["removed"]),
        "sources_changed": len(sources["changed"]),
    }
    return {"counts": counts, "added": added, "removed": removed, "changed": changed, "sources": sources}


STATE_FIELDS = ("name", "confidence", "ir_version", "skipped_count")


def diff_jurisdiction(before: dict[str, Any] | None, after: dict[str, Any] | None) -> list[dict[str, Any]]:
    """What changed about the state's program itself (its phone, website, form, statute) and how the engine reads the
    file (IR version, rules set aside), field by field."""
    if not before or not after:
        return []
    out = [{"field": f, "before": before.get(f), "after": after.get(f)} for f in STATE_FIELDS if not _same(before.get(f), after.get(f))]
    pa, pb = before.get("program") or {}, after.get("program") or {}
    out += [{"field": f"program.{k}", "before": pa.get(k), "after": pb.get(k)} for k in sorted(set(pa) | set(pb)) if not _same(pa.get(k), pb.get(k))]
    return out


def version_ref(v: dict[str, Any] | None) -> dict[str, Any] | None:
    """A version as the public sees it. The compute's host stays private; the branch id is shown."""
    if v is None:
        return None
    return {
        "name": v["name"],
        "seq": v["seq"],
        "git_sha": v["git_sha"],
        "short_sha": v["git_sha"][:7],
        "committed_at": v["committed_at"],
        "subject": v["subject"],
        "parent": v.get("parent"),
        "branch_id": v["branch_id"],
        "jurisdictions": v["jurisdictions"],
        "rules": v["rules"],
        "sources": v["sources"],
    }


def disk_hashes(rules: Any, ir: Any) -> FileHashes:
    """The sha256 of a state's verified file and IR as this server has them on disk (what /claim evaluates)."""

    def hashes(st: str) -> dict[str, str | None] | None:
        verified = rules.file_sha256(st)
        if verified is None:
            return None
        path = ir.path(st) if ir is not None else None
        return {"verified_sha256": verified, "ir_sha256": hashlib.sha256(path.read_bytes()).hexdigest() if path else None}

    return hashes


def neon_opener(base_url: str, pool_size: int = 2) -> BranchOpener:
    """Opens a published branch as the role in base_url (the SELECT-only reader in production), by the branch's host.
    Branches made after the roles were created carry the same roles and passwords."""
    from .db.neon import with_host
    from .db.postgres import PostgresRepository

    def open_branch(version: dict[str, Any]) -> Repository:
        return PostgresRepository(with_host(base_url, version["endpoint_host"]), migrate=False, pool_size=pool_size)

    return open_branch


class LawService:
    def __init__(self, repo: Repository, opener: BranchOpener | None = None, files: FileHashes | None = None, cache_size: int = 256):
        self.repo = repo
        self.opener = opener
        self.file_hashes = files
        self.cache_size = cache_size
        self._lock = threading.RLock()
        self._index: tuple[float, list[dict[str, Any]], dict[str, dict[str, dict[str, Any]]]] | None = None
        self._current: tuple[float, str | None] | None = None
        self._branches: dict[str, Repository] = {}
        self._checked: set[str] = set()
        self._rows: dict[tuple[str, str], dict[str, Any] | None] = {}
        self._cache: OrderedDict[tuple[str, str | None], tuple[list[dict[str, Any]], list[dict[str, Any]]]] = OrderedDict()

    def close(self) -> None:
        with self._lock:
            for repo in self._branches.values():
                repo.close()
            self._branches.clear()

    def refresh(self) -> None:
        with self._lock:
            self._index = None
            self._current = None

    # the index of published versions (in the production database)

    def _registry(self) -> tuple[list[dict[str, Any]], dict[str, dict[str, dict[str, Any]]]]:
        with self._lock:
            if self._index is not None and time.monotonic() - self._index[0] < REGISTRY_TTL_S:
                return self._index[1], self._index[2]
        versions = self.repo.law_versions()
        files: dict[str, dict[str, dict[str, Any]]] = {}
        for f in self.repo.law_version_files():
            files.setdefault(f["version"], {})[f["st"]] = f
        with self._lock:
            self._index = (time.monotonic(), versions, files)
        return versions, files

    def versions(self) -> list[dict[str, Any]]:
        return self._registry()[0]

    def version(self, name: str) -> dict[str, Any]:
        found = next((v for v in self.versions() if v["name"] == name), None)
        if found is None:
            raise LawError(f"No law version named {name}.", 404)
        return found

    def files(self, name: str) -> dict[str, dict[str, Any]]:
        return self._registry()[1].get(name, {})

    def current_name(self) -> str | None:
        """The version whose corpus is the one loaded in this server's database, or None when none matches."""
        with self._lock:
            if self._current is not None and time.monotonic() - self._current[0] < REGISTRY_TTL_S:
                return self._current[1]
        hashes = self.repo.corpus_hashes()
        digest = corpus_sha256(hashes) if hashes else None
        match = [v["name"] for v in self.versions() if v["corpus_sha256"] == digest]
        name = match[-1] if match else None
        with self._lock:
            self._current = (time.monotonic(), name)
        return name

    def version_for(self, st: str, hashes: dict[str, str | None] | None = None) -> dict[str, Any] | None:
        """The newest published version holding exactly these files for st (by default, the files this server
        evaluates claims with). None when no published version has them."""
        st = st.upper()
        if hashes is None:
            hashes = self.file_hashes(st) if self.file_hashes else None
        if not hashes:
            return None
        try:
            versions, files = self._registry()
        except Exception:  # a claim must not fail because the index cannot be read
            return None
        for v in reversed(versions):
            f = files.get(v["name"], {}).get(st)
            if f and f["verified_sha256"] == hashes.get("verified_sha256") and f["ir_sha256"] == hashes.get("ir_sha256"):
                return v
        return None

    def listing(self, st: str | None = None) -> dict[str, Any]:
        versions, files = self._registry()
        current = self.current_name() if versions else None
        out = []
        for v in versions:
            item = {**version_ref(v), "current": v["name"] == current, "published_at": v.get("published_at"), "load_ms": v.get("load_ms")}
            if st:
                f = files.get(v["name"], {}).get(st)
                item["file"] = (
                    {"verified_sha256": f["verified_sha256"], "ir_sha256": f["ir_sha256"], "rule_count": f["rule_count"]} if f else None
                )
            out.append(item)
        return {"versions": out, "count": len(out), "current": current, "st": st, "backend": self.repo.backend}

    # reading a published branch

    def _branch(self, version: dict[str, Any]) -> Repository:
        name = version["name"]
        with self._lock:
            repo = self._branches.get(name)
            if repo is None:
                if self.opener is None:
                    raise LawError("Law versions are kept in Neon branches, and this server is not connected to Neon.", 503)
                repo = self.opener(version)
                self._branches[name] = repo
            checked = name in self._checked
        if not checked:
            try:
                own = {v["name"]: v for v in repo.law_versions()}
                held = corpus_sha256(repo.corpus_hashes())
            except Exception as exc:
                raise LawError(f"Could not read {name} from its branch just now. Try again in a moment.", 502) from exc
            mine = own.get(name)
            if mine is None or mine["corpus_sha256"] != version["corpus_sha256"] or held != version["corpus_sha256"]:
                raise LawError(f"The branch for {name} does not hold that version, so it was not used.", 502)
            with self._lock:
                self._checked.add(name)
        return repo

    def _read(self, version: dict[str, Any], st: str | None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        key, whole = (version["name"], st), (version["name"], None)
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
            if st and whole in self._cache:  # a state's slice of an all-states read already in memory
                self._cache.move_to_end(whole)
                rules, sources = self._cache[whole]
                return [r for r in rules if r["st"] == st], [s for s in sources if s["st"] == st]
        repo = self._branch(version)
        try:
            value = (repo.corpus_rules(st), repo.corpus_sources(st))
        except Exception as exc:
            raise LawError(f"Could not read {version['name']} from its branch just now. Try again in a moment.", 502) from exc
        with self._lock:
            self._cache[key] = value
            while len(self._cache) > self.cache_size:
                self._cache.popitem(last=False)
        return value

    def _state_row(self, version: dict[str, Any], st: str) -> dict[str, Any] | None:
        key = (version["name"], st)
        with self._lock:
            if key in self._rows:
                return self._rows[key]
        try:
            row = self._branch(version).jurisdiction(st)
        except LawError:
            raise
        except Exception as exc:
            raise LawError(f"Could not read {version['name']} from its branch just now. Try again in a moment.", 502) from exc
        with self._lock:
            self._rows[key] = row
        return row

    # the two questions: what changed, and where does the law say this

    def _pair(self, from_name: str | None, to_name: str | None) -> tuple[dict[str, Any], dict[str, Any]]:
        versions = self.versions()
        if not versions:
            raise LawError("No law versions have been published yet.", 404)
        to = self.version(to_name) if to_name else versions[-1]
        if from_name:
            frm = self.version(from_name)
        else:
            earlier = [v for v in versions if v["seq"] < to["seq"]]
            if not earlier:
                raise LawError(f"{to['name']} is the first version, so there is nothing before it to compare.", 422)
            frm = earlier[-1]
        if frm["name"] == to["name"]:
            raise LawError("Pick two different versions to compare.", 422)
        return frm, to

    def diff(self, from_name: str | None, to_name: str | None, st: str | None = None) -> dict[str, Any]:
        started = time.monotonic()
        frm, to = self._pair(from_name, to_name)
        files_a, files_b = self.files(frm["name"]), self.files(to["name"])
        base: dict[str, Any] = {"from": version_ref(frm), "to": version_ref(to), "backend": self.repo.backend}

        def same(s: str) -> bool:
            a, b = files_a.get(s), files_b.get(s)
            return bool(a and b and a["verified_sha256"] == b["verified_sha256"] and a["ir_sha256"] == b["ir_sha256"])

        if st:
            st = st.upper()
            a, b = files_a.get(st), files_b.get(st)
            if a is None and b is None:
                raise LawError(f"Neither version has rules for {st}.", 404)
            if same(st):
                result = {**diff_state([], [], [], []), "state": []}
                read = "index"
            else:
                rules_a, sources_a = self._read(frm, st) if a else ([], [])
                rules_b, sources_b = self._read(to, st) if b else ([], [])
                result = diff_state(rules_a, rules_b, sources_a, sources_b)
                result["state"] = diff_jurisdiction(self._state_row(frm, st) if a else None, self._state_row(to, st) if b else None)
                read = "branches"
            files = {
                side: ({"verified_sha256": f["verified_sha256"], "ir_sha256": f["ir_sha256"], "rule_count": f["rule_count"]} if f else None)
                for side, f in (("from", a), ("to", b))
            }
            unchanged = not any(result["counts"].values()) and not result["state"]
            return {
                **base,
                "st": st,
                "unchanged": unchanged,
                "files_changed": read == "branches",
                "read": read,
                "files": files,
                **result,
                "ms": _ms(started),
            }

        states = sorted(set(files_a) | set(files_b))
        moved = [s for s in states if not same(s)]
        by_state: dict[str, tuple[list[dict[str, Any]], ...]] = {}
        if moved:
            rules_a, sources_a = self._read(frm, None)
            rules_b, sources_b = self._read(to, None)
            for s in moved:
                by_state[s] = (
                    [r for r in rules_a if r["st"] == s],
                    [r for r in rules_b if r["st"] == s],
                    [x for x in sources_a if x["st"] == s],
                    [x for x in sources_b if x["st"] == s],
                )
        rows = []
        totals = dict.fromkeys(("added", "removed", "changed", "sources_added", "sources_removed", "sources_changed"), 0)
        for s in states:
            counts = diff_state(*by_state[s])["counts"] if s in by_state else dict.fromkeys(totals, 0)
            for k, n in counts.items():
                totals[k] += n
            rows.append({"st": s, "unchanged": not any(counts.values()), "files_changed": s in by_state, **counts})
        return {
            **base,
            "st": None,
            "read": "branches" if moved else "index",
            "states": rows,
            "changed_states": sum(1 for r in rows if not r["unchanged"]),
            "totals": totals,
            "ms": _ms(started),
        }

    def search(self, q: str, st: str | None, limit: int = 20, version: str | None = None) -> dict[str, Any]:
        """The law's own words: full-text search over the verbatim quotes, in the current corpus or in a published
        version's branch. Results carry the quote, its rule id, and the link to that sentence in the source."""
        if version:
            v = self.version(version)
            repo = self._branch(v)
            searched = v["name"]
        else:
            repo = self.repo
            try:
                searched = self.current_name()
            except Exception:
                searched = None
        try:
            rows = repo.law_search(q, st.upper() if st else None, limit)
        except LawError:
            raise
        except Exception as exc:
            if version:
                raise LawError(f"Could not search {version} just now. Try again in a moment.", 502) from exc
            raise
        return {"q": q, "st": st.upper() if st else None, "version": searched, "backend": repo.backend, "count": len(rows), "results": rows}


def _ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)
