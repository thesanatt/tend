"""Law versions on real Neon branches. Runs only with TEND_NEON_TEST=1 (and NEON_API_KEY for the branch test).

TEND_NEON_TEST=1 uv run pytest tests/test_neon_law.py

Production is only read, as tend_reader (and as tend_app for a claim, which writes nothing). The publish path and the
roles are proven on a throwaway branch made from the newest law branch for this run; Neon deletes it within an hour
even if the run dies, and the run deletes it when it ends. Nothing here is registered in production's index.
"""

from __future__ import annotations

import base64
import copy
import dataclasses
import datetime as dt
import hashlib
import json
import os
import secrets

import pytest
from fastapi.testclient import TestClient
from helpers import CHECKING, REPO, claim_body, client_for, from_b64url, make_services
from test_repository import neon_env

from tend_api.app import create_app
from tend_api.db import CorpusBundle, bundle_hashes, corpus_sha256, read_bundles
from tend_api.db.neon import NeonAPI, with_host
from tend_api.db.postgres import PostgresRepository
from tend_api.db.roles import APP, READER, privilege_matrix
from tend_api.db.sqlite import SQLiteRepository
from tend_api.law import LawService, neon_opener

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(os.environ.get("TEND_NEON_TEST") != "1", reason="set TEND_NEON_TEST=1 to run against Neon"),
]


@pytest.fixture(scope="module")
def env():
    values = neon_env()
    missing = [k for k in ("DATABASE_URL", "DATABASE_URL_READER", "DATABASE_URL_APP") if not values.get(k)]
    if missing:
        pytest.skip(f"missing in the .env file: {', '.join(missing)} (run scripts/neon/roles.py)")
    return values


@pytest.fixture(scope="module")
def production(env):
    repo = PostgresRepository(env["DATABASE_URL_APP"], migrate=False, reader_url=env["DATABASE_URL_READER"])
    law = LawService(repo, neon_opener(env["DATABASE_URL_READER"]))
    if not law.versions():
        pytest.skip("no law versions published yet (scripts/neon/law_versions.py publish)")
    yield law
    law.close()
    repo.close()


def test_the_published_chain(production):
    listing = production.listing("MI")
    versions = listing["versions"]
    assert len(versions) >= 2 and listing["current"] in {v["name"] for v in versions}
    assert [v["seq"] for v in versions] == list(range(1, len(versions) + 1))
    assert versions[0]["parent"] is None and all(v["parent"] == p["name"] for p, v in zip(versions, versions[1:], strict=False))
    assert all(v["branch_id"].startswith("br-") and v["file"]["rule_count"] > 0 for v in versions)


def test_a_diff_read_from_two_real_branches(production):
    versions = production.versions()
    first, last = versions[0], versions[-1]
    d = production.diff(first["name"], last["name"], "MI")
    assert d["read"] == "branches" and d["counts"]["added"] > 0
    files = production.files(first["name"])["MI"], production.files(last["name"])["MI"]
    assert files[1]["rule_count"] - files[0]["rule_count"] == d["counts"]["added"] - d["counts"]["removed"]
    for rule in d["added"]:
        assert rule["quote"] and rule["pinpoint"] and rule["source_sha256"] and rule["source_url"].startswith("https://")
        assert rule["fragment_url"] is None or rule["fragment_url"].startswith("https://")  # PDFs have no text fragment
    if first["name"] == "law-2026-10-03-52abf94" and last["name"] == "law-2026-10-03-c959cb6":
        assert d["counts"]["added"] == 35 and {"MI-ACP-1", "MI-RECCONF-1"} <= {r["rule_id"] for r in d["added"]}
    summary = production.diff(first["name"], last["name"])
    assert summary["changed_states"] >= 1 and summary["totals"]["added"] >= d["counts"]["added"]


def test_quote_search_on_neon(production):
    found = production.search("conceal addresses", "MI", 5)
    assert found["backend"] == "postgres" and found["version"] == production.current_name() and found["matched"] == "all"
    top = found["results"][0]
    assert top["rule_id"] == "MI-ACP-1" and any("conceal" in top["quote"][s:e].lower() for s, e in top["marks"])
    first = production.versions()[0]["name"]
    older = production.search("conceal addresses", "MI", 5, version=first)  # the program was added in a later version
    assert older["version"] == first and older["count"] == 0
    # Michigan's quotes never say "confidentiality" next to "address", so the search falls back to either word.
    loose = production.search("address confidentiality", "MI", 5)
    assert loose["matched"] == "any" and loose["count"] > 0


def test_the_api_on_production_reads_only(env, settings, clock):
    live = dataclasses.replace(
        settings,
        rules_dir=REPO / "rules" / "verified",
        ir_dir=REPO / "rules" / "ir",
        refengine_dir=REPO / "refengine",
        database_url=env["DATABASE_URL_APP"],
        reader_url=env["DATABASE_URL_READER"],
        migrate_url=None,
        migrate=False,
        autoload_corpus=False,
    )
    services = make_services(live, clock, reference_evaluate=None)
    try:
        client = client_for(services)  # no lifespan: the sweeper never runs against production from a test
        versions = client.get("/api/law/versions").json()
        assert versions["backend"] == "postgres" and versions["count"] >= 2
        diff = client.get("/api/law/diff", params={"st": "MI"}).json()
        assert diff["to"]["name"] == versions["versions"][-1]["name"]
        search = client.get("/api/law/search", params={"q": '"forensic examination"', "st": "MI"}).json()
        assert search["count"] > 0 and all(r["fragment_url"] for r in search["results"])
        claim = client.post("/api/claim", params={"engine": "reference"}, json=claim_body())
        assert claim.status_code == 200, claim.text
        assert claim.json()["law_version"]["name"] == versions["current"] == claim.headers["x-tend-law-version"]
    finally:
        services.law.close()
        services.repo.close()


@pytest.fixture(scope="module")
def throwaway(env, production):
    if not env.get("NEON_API_KEY") or not env.get("NEON_PROJECT_ID"):
        pytest.skip("NEON_API_KEY and NEON_PROJECT_ID are needed for a throwaway branch")
    neon = NeonAPI(env["NEON_API_KEY"], env["NEON_PROJECT_ID"])
    newest = production.versions()[-1]
    branch = neon.create_branch(f"test-law-{secrets.token_hex(3)}", newest["branch_id"], expires_in=dt.timedelta(hours=1))
    try:
        yield {"branch": branch, "newest": newest}
    finally:
        neon.delete_branch(branch.id)
        neon.close()


def test_roles_carry_over_to_a_new_branch_with_their_limits(env, throwaway):
    host = throwaway["branch"].host
    rows = privilege_matrix({READER: with_host(env["DATABASE_URL_READER"], host), APP: with_host(env["DATABASE_URL_APP"], host)})
    wrong = [(r["role"], r["check"], r["error"]) for r in rows if r["allowed"] != r["expected"]]
    assert wrong == [] and len(rows) == 28


def test_publishing_a_version_into_a_branch(env, production, throwaway):
    branch, newest = throwaway["branch"], throwaway["newest"]
    bundles = read_bundles(REPO / "rules" / "verified", REPO / "rules" / "ir")
    if corpus_sha256(bundle_hashes(bundles)) != newest["corpus_sha256"]:
        pytest.skip("rules/ on disk differ from the newest published version; publish first")
    mi = next(b for b in bundles if b.st == "MI")
    doc = copy.deepcopy(mi.verified)
    added = {**doc["rules"][0], "id": "MI-TEST-1", "quote": "Tend's branch test adds this sentence about a lighthouse keeper."}
    doc["rules"].append(added)
    raw = json.dumps(doc).encode()
    changed = [CorpusBundle("MI", doc, hashlib.sha256(raw).hexdigest(), mi.ir, mi.ir_sha256) if b.st == "MI" else b for b in bundles]

    repo = PostgresRepository(branch.owner_uri or with_host(env["DATABASE_URL"], branch.host), migrate=False)
    try:
        result = repo.load_corpus(changed)
        assert result["loaded"] == ["MI"] and len(result["unchanged"]) == len(bundles) - 1  # copy-on-write: one state rewritten
        digest = corpus_sha256(bundle_hashes(changed))
        assert corpus_sha256(repo.corpus_hashes()) == digest
        name = f"law-2026-10-04-{secrets.token_hex(4)[:7]}"
        row = {
            **{k: newest[k] for k in ("jurisdictions", "sources")},
            "name": name,
            "seq": newest["seq"] + 1,
            "git_sha": secrets.token_hex(20),
            "committed_at": "2026-10-04T12:00:00Z",
            "subject": "test version",
            "parent": newest["name"],
            "branch_id": branch.id,
            "endpoint_host": branch.host,
            "corpus_sha256": digest,
            "rules": newest["rules"] + 1,
            "load_ms": 1,
        }
        files = [
            {"st": b.st, "verified_sha256": b.verified_sha256, "ir_sha256": b.ir_sha256, "rule_count": len(b.verified["rules"])}
            for b in changed
        ]
        assert repo.register_law_version(row, files) is True  # in the throwaway branch only
    finally:
        repo.close()

    index = SQLiteRepository(":memory:")  # this run's own index, so production's never sees the test version
    index.register_law_version({**newest, "parent": None}, list(production.files(newest["name"]).values()))
    index.register_law_version(row, files)
    law = LawService(index, neon_opener(env["DATABASE_URL_READER"]))
    try:
        d = law.diff(newest["name"], name, "MI")
        assert d["read"] == "branches" and [r["rule_id"] for r in d["added"]] == ["MI-TEST-1"]
        assert d["removed"] == [] and d["changed"] == [] and d["added"][0]["quote"] == added["quote"]
        found = law.search("lighthouse keeper", "MI", 5, version=name)
        assert [r["rule_id"] for r in found["results"]] == ["MI-TEST-1"] and found["results"][0]["marks"]
        assert law.search("lighthouse keeper", "MI", 5, version=newest["name"])["count"] == 0
    finally:
        law.close()
        index.close()


def test_shares_and_payments_work_as_the_least_privilege_roles(env, settings, clock):
    """A sealed share and the money path through the whole API as tend_app (writes) and tend_reader (corpus reads), in
    a throwaway schema that the owner migrates, grants, loads, and drops after."""
    schema = f"tend_test_{secrets.token_hex(4)}"
    owner = PostgresRepository(env["DATABASE_URL"], schema=schema)  # the owner migrates; the grants follow
    live = dataclasses.replace(
        settings,
        rules_dir=REPO / "rules" / "verified",
        ir_dir=REPO / "rules" / "ir",
        database_url=env["DATABASE_URL_APP"],
        reader_url=env["DATABASE_URL_READER"],
        migrate_url=env["DATABASE_URL"],
        db_schema=schema,
        autoload_corpus=False,
    )
    services = None
    try:
        assert owner.load_corpus(read_bundles(REPO / "rules" / "verified", REPO / "rules" / "ir", ["MI"]))["loaded"] == ["MI"]
        services = make_services(live, clock, reference_evaluate=None)
        assert services.repo.split_roles is True and services.repo.migrate() == []  # nothing left for the app role to do
        client = TestClient(create_app(services=services))
        found = client.get("/api/rules/search", params={"q": "therapy sessions", "st": "MI"}).json()  # tend_reader
        assert found["backend"] == "postgres" and found["results"]
        assert client.get("/api/law/search", params={"q": "forensic", "st": "MI"}).json()["count"] > 0

        raw = os.urandom(512)
        ciphertext = base64.urlsafe_b64encode(raw).decode().rstrip("=")
        share = client.post("/api/shares", json={"ciphertext": ciphertext, "iv": base64.b64encode(os.urandom(12)).decode(), "once": True})
        assert share.status_code == 201, share.text
        assert from_b64url(client.get(share.json()["api_path"]).json()["ciphertext"]) == raw
        assert client.get(share.json()["api_path"]).status_code == 410

        proposal = client.post(
            "/api/actions/propose", json={"from": CHECKING, "payee": "Riverbend General Hospital", "amount_cents": 11800}
        )
        assert proposal.status_code == 200, proposal.text
        body = proposal.json()
        done = client.post("/api/actions/confirm", json={"action_id": body["action_id"], "confirm_code": body["confirm_code"]}).json()
        assert done["status"] == "done" and done["audit"]["seq"] == 2
        log = client.get("/api/audit").json()
        assert log["chain"]["ok"] is True and log["chain"]["rows"] == 2 and "Riverbend" not in str(log)
        with pytest.raises(Exception, match="permission denied"):  # the app role cannot rewrite the log, trigger or not
            with services.repo._tx() as c:
                c.execute("UPDATE audit_log SET event = event")
    finally:
        if services is not None:
            services.law.close()
            services.repo.close()
        owner.drop_schema()
        owner.close()
