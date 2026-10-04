"""Law versions, the diff between two of them, quote search, and the least-privilege roles, offline.

The Neon branches are stood in for by SQLite repositories that hold each version's corpus, opened by the same
LawService the API uses. tests/test_neon_law.py runs the same paths against real Neon branches.
"""

from __future__ import annotations

import copy
import hashlib
import io
import json
import sys

import pytest
from helpers import FIXTURES, REPO, claim_body, client_for

from tend_api.config import Settings
from tend_api.db import CorpusBundle, bundle_hashes, corpus_sha256, read_bundles
from tend_api.db.base import fts5_query, marks
from tend_api.db.neon import with_host
from tend_api.db.roles import APP, EXPECT, READER, grant_statements, role_url
from tend_api.db.sqlite import SQLiteRepository
from tend_api.law import LawService, diff_jurisdiction, diff_state, disk_hashes

A, B = "law-2026-10-03-aaaaaaa", "law-2026-10-04-bbbbbbb"


def bundle(st: str, doc: dict) -> CorpusBundle:
    raw = json.dumps(doc, indent=1).encode()
    return CorpusBundle(st, doc, hashlib.sha256(raw).hexdigest())


def newer_mi() -> dict:
    """The MI fixture one version later: a rule added, one removed, a quote, a summary, and an engine reading changed,
    a source saved again, a source added, and the program's phone changed."""
    doc = copy.deepcopy(json.loads((FIXTURES / "rules" / "MI.json").read_text()))
    rules = {r["id"]: r for r in doc["rules"]}
    exam_source = rules["MI-EXAM-1"]["source_id"]
    doc["rules"] = [r for r in doc["rules"] if r["id"] != "MI-CAP-7"]
    rules["MI-EXAM-2"]["quote"] = rules["MI-EXAM-2"]["quote"] + " (amended)"
    rules["MI-CAP-1"]["summary"] = "A new plain summary."
    rules["MI-COV-2"]["params"] = {**(rules["MI-COV-2"].get("params") or {}), "note": "changed"}
    for s in doc["sources"]:
        if s["id"] == exam_source:
            s["sha256"] = "f" * 64
    doc["sources"].append({**doc["sources"][0], "id": "MI-S99", "title": "Address Confidentiality Program", "sha256": "e" * 64})
    doc["rules"].append(
        {
            "id": "MI-ACP-1",
            "category": "address_confidentiality",
            "params": {},
            "summary": "Michigan has an address confidentiality program.",
            "quote": "The program was created to conceal the addresses of victims of sexual assault.",
            "source_id": "MI-S99",
            "pinpoint": "ACP page",
            "fragment_url": "https://example.gov/acp#:~:text=The%20program%20was%20created",
        }
    )
    doc["program"] = {**doc["program"], "phone": "800-000-0000"}
    return doc


def version(name: str, seq: int, bundles: list[CorpusBundle], parent: str | None = None) -> tuple[dict, list[dict]]:
    counts = {"jurisdictions": len(bundles), "rules": sum(len(b.verified["rules"]) for b in bundles)}
    row = {
        "name": name,
        "seq": seq,
        "git_sha": (name[-7:] * 6)[:40],
        "committed_at": f"2026-10-0{2 + seq}T19:00:00Z",
        "subject": f"corpus {seq}",
        "parent": parent,
        "branch_id": f"br-test-{seq}",
        "endpoint_host": f"ep-test-{seq}.example.neon.tech",
        "corpus_sha256": corpus_sha256(bundle_hashes(bundles)),
        "sources": sum(len(b.verified["sources"]) for b in bundles),
        "load_ms": 10,
        **counts,
    }
    files = [
        {"st": b.st, "verified_sha256": b.verified_sha256, "ir_sha256": b.ir_sha256, "rule_count": len(b.verified["rules"])}
        for b in bundles
    ]
    return row, files


@pytest.fixture
def world(services):
    """Production (the services' own SQLite database, holding version A's corpus), two branches, and the index."""
    a_bundles = read_bundles(FIXTURES / "rules", None)
    wi = next(b for b in a_bundles if b.st == "WI")
    b_bundles = [bundle("MI", newer_mi()), wi]
    branches, published = {}, []
    for name, seq, bundles, parent in ((A, 1, a_bundles, None), (B, 2, b_bundles, A)):
        repo = SQLiteRepository(":memory:")
        repo.load_corpus(bundles)
        published.append(version(name, seq, bundles, parent))
        for row, files in published:  # a child branch inherits its parents' rows, then names itself
            repo.register_law_version(row, files)
        services.repo.register_law_version(*published[-1])
        branches[name] = repo
    opened = []

    def opener(v):
        opened.append(v["name"])
        return branches[v["name"]]

    services.law = LawService(services.repo, opener, disk_hashes(services.rules, services.ir))
    yield {"services": services, "branches": branches, "opened": opened}
    for repo in branches.values():
        repo.close()


@pytest.fixture
def law_client(world):
    with client_for(world["services"]) as c:
        yield c


# pure parts


def test_web_search_syntax_becomes_a_safe_fts5_query():
    assert fts5_query("counseling sessions", "quote") == '(quote : "counseling" AND quote : "sessions")'
    assert fts5_query('"health care provider" bill', "quote") == '(quote : "health care provider" AND quote : "bill")'
    assert fts5_query("phone or purse", "quote") == '(quote : "phone") OR (quote : "purse")'
    assert fts5_query("exam -bill", "quote") == '((quote : "exam")) NOT (quote : "bill")'
    assert fts5_query('*** "" or -', "quote") is None
    # FTS5 operators and column filters typed by someone are only words here; punctuation inside a word makes a phrase.
    assert fts5_query('NEAR(a) col:x "unclosed', "quote") == '(quote : "NEAR a" AND quote : "col x" AND quote : "unclosed")'


def test_marks_count_utf16_and_refuse_a_changed_text():
    assert marks("The exam bill", "The \x02exam\x03 \x02bill\x03") == [[4, 8], [9, 13]]
    assert marks("\U0001f331 grows", "\U0001f331 \x02grows\x03") == [[3, 8]]  # the plant emoji is two UTF-16 units
    assert marks("The exam bill", "The \x02exam\x03 bills") == []
    assert marks("abc", "\x02abc") == []


def test_the_corpus_hash_names_the_files_not_their_order():
    hashes = {"MI": {"verified_sha256": "a" * 64, "ir_sha256": None}, "WI": {"verified_sha256": "b" * 64, "ir_sha256": "c" * 64}}
    same = dict(reversed(list(hashes.items())))
    assert corpus_sha256(hashes) == corpus_sha256(same)
    moved = {**hashes, "WI": {"verified_sha256": "b" * 64, "ir_sha256": "d" * 64}}
    assert corpus_sha256(moved) != corpus_sha256(hashes)


def test_a_diff_names_each_kind_of_change():
    a = SQLiteRepository(":memory:")
    b = SQLiteRepository(":memory:")
    a.load_corpus([read_bundles(FIXTURES / "rules", None, ["MI"])[0]])
    b.load_corpus([bundle("MI", newer_mi())])
    d = diff_state(a.corpus_rules("MI"), b.corpus_rules("MI"), a.corpus_sources("MI"), b.corpus_sources("MI"))
    assert [r["rule_id"] for r in d["added"]] == ["MI-ACP-1"] and d["added"][0]["quote"].startswith("The program was created")
    assert [r["rule_id"] for r in d["removed"]] == ["MI-CAP-7"]
    kinds = {c["rule_id"]: c["kinds"] for c in d["changed"]}
    assert kinds["MI-CAP-1"] == ["meaning"] and "meaning" in kinds["MI-COV-2"]
    assert kinds["MI-EXAM-1"] == ["source_copy"]  # its source was saved again with a new sha256
    assert kinds["MI-EXAM-2"] == ["text", "source_copy"]  # a new quote, from that same re-saved source
    exam2 = next(c for c in d["changed"] if c["rule_id"] == "MI-EXAM-2")
    assert exam2["after"]["quote"] == exam2["before"]["quote"] + " (amended)" and exam2["rule"]["fragment_url"]
    assert [s["source_id"] for s in d["sources"]["added"]] == ["MI-S99"]
    assert d["sources"]["changed"][0]["sha256"] == "f" * 64 and d["sources"]["changed"][0]["sha256_before"] != "f" * 64
    assert d["counts"]["added"] == 1 and d["counts"]["removed"] == 1 and d["counts"]["sources_changed"] == 1
    assert diff_state(a.corpus_rules("MI"), a.corpus_rules("MI"), a.corpus_sources("MI"), a.corpus_sources("MI"))["changed"] == []
    state = diff_jurisdiction(a.jurisdiction("MI"), b.jurisdiction("MI"))
    assert {"field": "program.phone", "before": "877-251-7373", "after": "800-000-0000"} in state
    a.close()
    b.close()


# the API


def test_versions_are_listed_oldest_first_with_the_current_one(law_client):
    data = law_client.get("/api/law/versions", params={"st": "mi"}).json()
    assert [v["name"] for v in data["versions"]] == [A, B] and data["count"] == 2
    assert data["current"] == A  # production holds the fixture corpus, which is version A
    assert [v["current"] for v in data["versions"]] == [True, False]
    first = data["versions"][0]
    assert first["branch_id"] == "br-test-1" and first["short_sha"] == "aaaaaaa" and "endpoint_host" not in first
    assert first["file"]["rule_count"] == 48 and data["versions"][1]["file"]["rule_count"] == 48


def test_a_state_diff_reads_both_branches(law_client, world):
    d = law_client.get("/api/law/diff", params={"st": "MI"}).json()  # defaults: the newest against the one before
    assert d["from"]["name"] == A and d["to"]["name"] == B and d["read"] == "branches" and d["files_changed"] is True
    fixture = json.loads((FIXTURES / "rules" / "MI.json").read_text())
    exam_source = next(r["source_id"] for r in fixture["rules"] if r["id"] == "MI-EXAM-1")
    resaved = {r["id"] for r in fixture["rules"] if r["source_id"] == exam_source}  # every rule quoting the re-saved source
    assert {c["rule_id"] for c in d["changed"]} == resaved | {"MI-EXAM-2", "MI-CAP-1", "MI-COV-2"}
    assert d["counts"] == {
        "added": 1,
        "removed": 1,
        "changed": len(resaved | {"MI-EXAM-2", "MI-CAP-1", "MI-COV-2"}),
        "sources_added": 1,
        "sources_removed": 0,
        "sources_changed": 1,
    }
    assert d["added"][0]["rule_id"] == "MI-ACP-1" and d["added"][0]["fragment_url"].startswith("https://")
    assert {"field": "program.phone", "before": "877-251-7373", "after": "800-000-0000"} in d["state"]
    assert sorted(world["opened"]) == [A, B]
    again = law_client.get("/api/law/diff", params={"from": A, "to": B, "st": "MI"}).json()
    assert again["counts"] == d["counts"] and sorted(world["opened"]) == [A, B]  # opened once, read from memory after


def test_an_unchanged_state_is_answered_from_the_index(law_client, world):
    d = law_client.get("/api/law/diff", params={"from": B, "to": A, "st": "WI"}).json()
    assert d["unchanged"] is True and d["read"] == "index" and d["added"] == [] and world["opened"] == []


def test_all_states_at_once(law_client):
    d = law_client.get("/api/law/diff").json()
    rows = {r["st"]: r for r in d["states"]}
    assert d["st"] is None and d["changed_states"] == 1 and d["totals"]["added"] == 1
    assert rows["MI"]["unchanged"] is False and rows["WI"] == {**rows["WI"], "unchanged": True, "files_changed": False}


def test_diff_errors(law_client, world):
    assert law_client.get("/api/law/diff", params={"from": "law-2026-10-09-0000000"}).status_code == 404
    assert law_client.get("/api/law/diff", params={"from": "not-a-version"}).status_code == 422
    assert law_client.get("/api/law/diff", params={"from": A, "to": A}).status_code == 422
    assert law_client.get("/api/law/diff", params={"to": A}).status_code == 422  # nothing before the first version
    assert law_client.get("/api/law/diff", params={"st": "TX"}).status_code == 404


def test_a_branch_that_does_not_hold_its_version_is_not_used(world):
    services = world["services"]
    wrong = LawService(services.repo, lambda v: world["branches"][A])  # every version opens branch A
    with client_for(services) as c:
        services.law = wrong
        r = c.get("/api/law/diff", params={"st": "MI"})
    assert r.status_code == 502 and "does not hold" in r.json()["detail"]


def test_without_neon_the_index_still_answers(world):
    services = world["services"]
    services.law = LawService(services.repo, None)
    with client_for(services) as c:
        assert c.get("/api/law/versions").json()["count"] == 2
        assert c.get("/api/law/diff", params={"st": "WI"}).json()["unchanged"] is True
        assert c.get("/api/law/diff", params={"st": "MI"}).status_code == 503
        assert c.get("/api/law/search", params={"q": "counseling", "version": A}).status_code == 503
        services.law = None
        assert c.get("/api/law/versions").status_code == 503


def test_quote_search_returns_quotes_and_links_only(law_client):
    data = law_client.get("/api/law/search", params={"q": "counseling", "st": "mi"}).json()
    assert data["st"] == "MI" and data["backend"] == "sqlite" and data["version"] == A and data["count"] > 0
    for r in data["results"]:
        assert set(r) == {"st", "rule_id", "quote", "pinpoint", "source_id", "fragment_url", "rank", "marks"}
        assert r["marks"] and all("counsel" in r["quote"][s:e].lower() for s, e in r["marks"])
    assert [r["rank"] for r in data["results"]] == sorted((r["rank"] for r in data["results"]), reverse=True)
    phrase = law_client.get("/api/law/search", params={"q": '"forensic examination"'}).json()
    assert phrase["count"] > 0 and all("forensic examination" in r["quote"].lower() for r in phrase["results"])
    assert law_client.get("/api/law/search", params={"q": "x"}).status_code == 422
    assert law_client.get("/api/law/search", params={"q": "zzqq xxyy"}).json()["count"] == 0


def test_quote_search_in_a_published_version(law_client):
    newer = law_client.get("/api/law/search", params={"q": "conceal addresses", "version": B}).json()
    assert newer["version"] == B and [r["rule_id"] for r in newer["results"]] == ["MI-ACP-1"]
    older = law_client.get("/api/law/search", params={"q": "conceal addresses", "version": A}).json()
    assert older["count"] == 0


def test_the_claim_and_the_packet_name_their_law_version(law_client):
    r = law_client.post("/api/claim", json=claim_body())
    assert r.status_code == 200, r.text
    assert r.json()["law_version"]["name"] == A and r.headers["x-tend-law-version"] == A
    assert r.json()["law_version"]["branch_id"] == "br-test-1" and "endpoint_host" not in r.json()["law_version"]
    pdf = law_client.post("/api/packet", json=claim_body())
    assert pdf.status_code == 200 and pdf.headers["x-tend-law-version"] == A
    from pypdf import PdfReader

    text = " ".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf.content)).pages)
    assert "Which law this used" in text and A in " ".join(text.split())


def test_a_claim_on_unpublished_rules_says_so(client):
    r = client.post("/api/claim", json=claim_body())
    assert r.status_code == 200 and r.json()["law_version"] is None and "x-tend-law-version" not in r.headers


def test_the_newest_version_with_the_same_files_is_named(world):
    services = world["services"]
    c_bundles = read_bundles(FIXTURES / "rules", None)  # the same files as A, published again later
    row, files = version("law-2026-10-05-ccccccc", 3, c_bundles, B)
    row["git_sha"] = "c" * 40
    services.repo.register_law_version(row, files)
    services.law.refresh()
    assert services.law.version_for("MI")["name"] == "law-2026-10-05-ccccccc"
    with pytest.raises(ValueError, match="different corpus"):
        services.repo.register_law_version({**row, "corpus_sha256": "0" * 64}, files)
    assert services.repo.register_law_version(row, files) is False


def test_a_slow_or_down_version_index_never_holds_up_a_claim(world, monkeypatch):
    import threading
    import time as _time

    import tend_api.law as law

    services = world["services"]
    monkeypatch.setattr(law, "CLAIM_WAIT_S", 0.2)
    gate = threading.Event()
    real = services.repo.law_versions
    calls = []

    def slow():
        calls.append(1)
        gate.wait(5)
        return real()

    monkeypatch.setattr(services.repo, "law_versions", slow)
    services.law.refresh()
    started = _time.monotonic()
    assert services.law.version_for("MI") is None  # gave up waiting; the read keeps going
    assert _time.monotonic() - started < 1.5
    started = _time.monotonic()
    assert services.law.version_for("MI") is None  # the next claim does not wait for the same read again
    assert _time.monotonic() - started < 0.1
    gate.set()
    for _ in range(50):  # the background read fills the cache for the next claim
        if services.law.version_for("MI") is not None:
            break
        _time.sleep(0.05)
    assert services.law.version_for("MI")["name"] == A and len(calls) == 1

    def down():
        calls.append(1)
        raise RuntimeError("neon unreachable")

    monkeypatch.setattr(services.repo, "law_versions", down)
    services.law.refresh()
    calls.clear()
    assert services.law.version_for("MI") is None
    assert services.law.version_for("MI") is None
    assert len(calls) == 1  # after a failure the lookup waits CLAIM_RETRY_S before trying again


def test_a_database_that_does_not_answer_is_a_plain_503(law_client, world, monkeypatch, caplog):
    import psycopg

    def down(*_a, **_k):
        raise psycopg.OperationalError("couldn't get a connection after 30.00 sec")

    services = world["services"]
    monkeypatch.setattr(services.repo, "law_versions", down)
    monkeypatch.setattr(services.repo, "law_search", down)
    services.law.refresh()
    for path in ("/api/law/versions", "/api/law/diff?st=MI", "/api/law/search?q=secret+words&st=MI"):
        r = law_client.get(path)
        assert r.status_code == 503, (path, r.text)
        assert r.json()["detail"] == "The law versions could not be read just now. Try again in a moment."
    assert "secret words" not in caplog.text and "secret+words" not in caplog.text


def test_a_packet_never_prints_the_rules_hash_as_a_law_image(client):
    from pypdf import PdfReader

    pdf = client.post("/api/packet", json=claim_body())
    assert pdf.status_code == 200, pdf.text
    text = " ".join(" ".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf.content)).pages).split())
    assert "Checked against the verified rules with the hashes below." in text
    assert "not a published law version" not in text

    from tend_api.packet import _law_used, _styles

    def paragraph(view):
        return " ".join(p.getPlainText() for p in _law_used(view, _styles()))

    same = paragraph({"rules_sha256": "a" * 64, "law_image_sha256": "a" * 64, "law_version": None})
    assert "Law image" not in same and same.count("a" * 64) == 1  # the reference engine's label is the rules hash
    both = paragraph({"rules_sha256": "a" * 64, "law_image_sha256": "b" * 64, "law_version": None})
    assert f"Law image SHA-256 {'b' * 64}." in both


# roles, URLs, and settings


def test_grants_give_each_role_only_its_part():
    tables = {"categories", "jurisdictions", "sources", "rules", "law_images", "law_versions", "law_version_files"}
    tables |= {"schema_migrations", "sealed_shares", "pending_actions", "audit_log", "meta"}
    text = [s.as_string(None) for s in grant_statements("public", "neondb_owner", tables)]
    reader_grants = [t for t in text if t.startswith("GRANT") and '"tend_reader"' in t]
    assert all("sealed_shares" not in t and "audit_log" not in t and "pending_actions" not in t for t in reader_grants)
    assert any(t.startswith('GRANT SELECT, INSERT ON "public"."audit_log", "public"."meta" TO "tend_app"') for t in text)
    assert any(t.startswith("REVOKE UPDATE, DELETE, TRUNCATE") and "audit_log" in t for t in text)
    assert any(t.startswith('REVOKE ALL ON "public"."sealed_shares"') and t.endswith('FROM "tend_reader"') for t in text)
    assert any("ALTER DEFAULT PRIVILEGES" in t and '"tend_app"' in t for t in text)
    corpus_only = [s.as_string(None) for s in grant_statements("public", "neondb_owner", {"rules", "sources"})]
    assert not any("sealed_shares" in t or "audit_log" in t for t in corpus_only)
    assert EXPECT[READER]["read the rules"] and not EXPECT[READER]["read the audit log"]
    assert EXPECT[APP]["append to the audit log"] and not EXPECT[APP]["rewrite the audit log"]


def test_branch_and_role_urls():
    pooled = "postgresql://neondb_owner:p%40ss@ep-sample-host-a1b2c3d4-pooler.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require"
    direct = pooled.replace("-pooler", "")
    host = "ep-other-host-e5f6g7h8.c-6.us-east-2.aws.neon.tech"
    assert with_host(pooled, host) == pooled.replace("ep-sample-host-a1b2c3d4-pooler", "ep-other-host-e5f6g7h8-pooler")
    assert with_host(direct, host) == direct.replace("ep-sample-host-a1b2c3d4", "ep-other-host-e5f6g7h8")
    reader = role_url(pooled, "tend_reader", "a/b+c")
    assert reader.startswith("postgresql://tend_reader:a%2Fb%2Bc@ep-sample-host-a1b2c3d4-pooler.") and reader.endswith("?sslmode=require")


def test_settings_prefer_the_app_role_and_keep_the_owner_for_migrations(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://owner:x@ep-a.neon.tech/db")
    monkeypatch.setenv("DATABASE_URL_POOLED", "postgresql://owner:x@ep-a-pooler.neon.tech/db")
    monkeypatch.setenv("DATABASE_URL_APP", "postgresql://tend_app:y@ep-a-pooler.neon.tech/db")
    monkeypatch.setenv("DATABASE_URL_READER", "postgresql://tend_reader:z@ep-a-pooler.neon.tech/db")
    monkeypatch.setenv("TEND_MIGRATE", "0")
    s = Settings.from_env()
    assert s.database_url.startswith("postgresql://tend_app:") and s.migrate_url.startswith("postgresql://owner:")
    assert s.reader_url.startswith("postgresql://tend_reader:") and s.migrate is False
    monkeypatch.setenv("TEND_DB", ":memory:")
    assert Settings.from_env().reader_url is None


def test_the_quiet_log_covers_quote_search():
    from tend_api.app import QUIET_PREFIXES

    assert any("/api/law/search?q=can+they+find+my+address".startswith(p) for p in QUIET_PREFIXES)
    assert not any("/api/law/diff".startswith(p) for p in QUIET_PREFIXES)


# the publishing script's view of git history (needs the repo's history, not just a checkout)

needs_history = pytest.mark.skipif(not (REPO / ".git").exists(), reason="no git history here")


@needs_history
def test_versions_come_from_real_corpus_commits():
    sys.path.insert(0, str(REPO / "scripts" / "neon"))
    try:
        import neonenv
    finally:
        sys.path.pop(0)
    info = neonenv.commit_info("52abf94")
    assert info["name"] == "law-2026-10-03-52abf94" and len(info["git_sha"]) == 40
    commits = neonenv.corpus_commits()
    assert commits.index(neonenv.commit_info("c8304df")["git_sha"]) > commits.index(info["git_sha"])
    bundles = neonenv.bundles_at(info["git_sha"])
    assert len(bundles) == 51 and sum(len(b.verified["rules"]) for b in bundles) == 1818
    assert {b.ir.get("ir_version") for b in bundles if b.ir} == {1}
    mi = next(b for b in bundles if b.st == "MI")
    blob = neonenv.git("show", f"{info['git_sha']}:rules/verified/MI.json").encode()
    assert mi.verified_sha256 == hashlib.sha256(blob).hexdigest()
