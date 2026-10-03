"""The whole API on Neon, end to end. Runs only with TEND_NEON_TEST=1, in a throwaway schema it drops after.

TEND_NEON_TEST=1 uv run pytest tests/test_neon_live.py tests/test_repository.py -k "neon or live"
"""

from __future__ import annotations

import base64
import dataclasses
import os
import secrets

import pytest
from fastapi.testclient import TestClient
from helpers import CHECKING, REPO, make_services
from test_repository import neon_env

from tend_api.app import create_app

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(os.environ.get("TEND_NEON_TEST") != "1", reason="set TEND_NEON_TEST=1 to run against Neon"),
]


@pytest.fixture
def neon(settings, clock):
    env = neon_env()
    url = env.get("DATABASE_URL_POOLED") or env.get("DATABASE_URL")
    if not url:
        pytest.skip("no DATABASE_URL in the .env file")
    live = dataclasses.replace(
        settings,
        rules_dir=REPO / "rules" / "verified",
        ir_dir=REPO / "rules" / "ir",
        database_url=url,
        migrate_url=env.get("DATABASE_URL"),
        db_schema=f"tend_test_{secrets.token_hex(4)}",
        autoload_corpus=False,
    )
    services = make_services(live, clock, reference_evaluate=None)
    try:
        yield services
    finally:
        services.repo.drop_schema()
        services.repo.close()


def test_the_loaded_corpus_on_neon():
    """Read-only, on the real public schema: what `python -m tend_api.loader` put there matches rules/ on disk."""
    from tend_api.db.postgres import PostgresRepository
    from tend_api.rules import RulesStore

    env = neon_env()
    url = env.get("DATABASE_URL_POOLED") or env.get("DATABASE_URL")
    if not url:
        pytest.skip("no DATABASE_URL in the .env file")
    repo = PostgresRepository(url, migrate=False)
    try:
        rules = RulesStore(REPO / "rules" / "verified")
        counts = repo.corpus_counts()
        if counts["jurisdictions"] == 0:
            pytest.skip("the corpus has not been loaded into Neon yet")
        assert counts["jurisdictions"] == len(rules.codes()) and counts["categories"] == 19
        assert counts["rules"] == sum(len(rules.get(st)["rules"]) for st in rules.codes())
        assert {st: h["verified_sha256"] for st, h in repo.corpus_hashes().items()} == {st: rules.file_sha256(st) for st in rules.codes()}
        hits = repo.search_rules(["counsel"], "MI", 5)  # one round trip on the public schema
        assert hits and all(h["st"] == "MI" and h["score"] > 0 for h in hits)
    finally:
        repo.close()


def test_the_api_on_neon(neon):
    loaded = neon.rulebook.load(["MI", "NY"])
    assert loaded["loaded"] == ["MI", "NY"] and loaded["counts"]["rules"] == 83 + 59
    client = TestClient(create_app(services=neon))

    health = client.get("/api/health").json()
    assert health["database"]["backend"] == "postgres" and health["database"]["server_version"].startswith(("17", "18"))
    assert health["corpus"]["jurisdictions"] == 2

    # Postgres full-text search, weighted by heading, summary, quote, and pinpoint.
    found = client.get("/api/rules/search", params={"q": "therapy sessions", "st": "MI"}).json()
    assert found["backend"] == "postgres" and found["results"][0]["expense"] == "counseling"
    answer = client.post("/api/agent/answer", json={"question": "Can the hospital bill me for the rape kit?", "st": "MI"}).json()
    assert answer["answered"] is True and "MI-EXAM-1" in {p["rule_id"] for p in answer["points"]}
    refused = client.post("/api/agent/answer", json={"question": "Can I get money for my dog's vet bills?", "st": "NY"}).json()
    assert refused["answered"] is False

    # A sealed share: only ciphertext reaches Neon, and an open-once share loses it on the first read.
    ciphertext = base64.b64encode(os.urandom(1024)).decode()
    share = client.post("/api/shares", json={"ciphertext": ciphertext, "iv": base64.b64encode(os.urandom(12)).decode(), "once": True})
    assert share.status_code == 201, share.text
    assert client.get(share.json()["api_path"]).json()["ciphertext"] == ciphertext
    assert client.get(share.json()["api_path"]).status_code == 410

    # A payment: the code, the dry-run withdrawal and read-back, and two audit rows the trigger checked.
    proposal = client.post(
        "/api/actions/propose", json={"from": CHECKING, "payee": "Riverbend General Hospital", "amount_cents": 11800}
    ).json()
    done = client.post("/api/actions/confirm", json={"action_id": proposal["action_id"], "confirm_code": proposal["confirm_code"]}).json()
    assert done["status"] == "done" and done["audit"]["seq"] == 2
    log = client.get("/api/audit").json()
    assert log["chain"]["ok"] is True and log["chain"]["rows"] == 2 and "Riverbend" not in str(log)
    assert neon.repo.get_action(proposal["action_id"])["payee"] is None
