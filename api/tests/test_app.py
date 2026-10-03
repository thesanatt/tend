"""The app shell: routes, headers, CORS, health, settings, and the access log."""

from __future__ import annotations

import logging
import os
from pathlib import Path

import pytest

from tend_api.app import QuietPaths
from tend_api.config import DEFAULT_SQLITE, Settings, database_from_env, load_env_file


def test_routes_are_the_local_first_set(client):
    paths = set(client.get("/api/openapi.json").json()["paths"])
    for path in (
        "/api/health",
        "/api/audit",
        "/api/jurisdictions",
        "/api/jurisdictions/{st}",
        "/api/jurisdictions/{st}/asm",
        "/api/jurisdictions/{st}/images",
        "/api/rules/search",
        "/api/claim",
        "/api/scan",
        "/api/bill/audit",
        "/api/bank/{persona}/transactions",
        "/api/bank/{persona}/bills/{bill_id}/document",
        "/api/actions/propose",
        "/api/actions/confirm",
        "/api/actions/{action_id}",
        "/api/shares",
        "/api/shares/{share_id}",
        "/api/ai/classify",
        "/api/ai/bill",
        "/api/agent/answer",
        "/api/agent/check",
        "/api/agent/pay",
        "/api/agent/confirm",
        "/api/packet",
    ):
        assert path in paths, path
    # Routes that read stored claims or plaintext shares are gone with the storage behind them.
    for gone in (
        "/api/share",
        "/api/share/{token}",
        "/api/claims/{claim_id}",
        "/api/packet/{claim_id}.pdf",
        "/api/agent/link",
        "/api/agent/redeem",
        "/api/agent/claim",
    ):
        assert gone not in paths, gone


def test_cors_exposes_the_engine_header(client):
    r = client.options(
        "/api/claim",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "http://localhost:3000"
    get = client.get("/api/health", headers={"Origin": "http://localhost:3000"})
    assert "X-Tend-Engine" in get.headers["access-control-expose-headers"]
    other = client.get("/api/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in other.headers


def test_every_response_is_private(client):
    r = client.get("/api/jurisdictions")
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["referrer-policy"] == "no-referrer"
    assert r.headers["x-content-type-options"] == "nosniff"


def test_oversized_requests_are_refused_before_reading(client):
    r = client.post("/api/shares", content=b"{}", headers={"content-type": "application/json", "content-length": str(17 * 1024 * 1024)})
    assert r.status_code == 413


def test_a_chunked_body_over_the_limit_is_refused(client):
    # No Content-Length: the body arrives chunked, so only counting the bytes can stop it.
    def chunks():
        for _ in range(17):
            yield b" " * (1024 * 1024)

    r = client.post("/api/shares", content=chunks(), headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.json()["detail"] == "That request is too large."
    assert r.headers["cache-control"] == "no-store"
    small = client.post(
        "/api/agent/answer",
        content=iter([b'{"question": "How long do I have', b' to apply?", "st": "MI"}']),
        headers={"content-type": "application/json"},
    )
    assert small.status_code == 200 and small.json()["answered"] is True


def test_health_reports_database_corpus_engines_and_bank(client):
    health = client.get("/api/health").json()
    assert health["ok"] is True
    assert health["bank"] == "dry_run" and health["relay"] == "snapshot"
    assert health["database"]["backend"] == "sqlite" and health["database"]["ok"] is True
    assert health["corpus"]["jurisdictions"] == 2 and health["corpus"]["rules"] == 84 and health["corpus"]["stale"] == []
    assert health["jurisdictions"] == ["MI", "WI"]
    assert health["engines"]["native"]["available"] is False
    assert health["engines"]["reference"]["available"] is True
    assert health["cloud_ai"]["available"] is False


def test_access_log_drops_private_paths():
    quiet = QuietPaths()

    def record(path: str) -> logging.LogRecord:
        return logging.LogRecord(
            "uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d', ("1.2.3.4", "GET", path, "1.1", 200), None
        )

    assert quiet.filter(record("/api/jurisdictions")) is True
    for path in (
        "/api/shares/abcdefghijklmnopqrstuv",
        "/api/bank/rowan-mi/transactions?from=2026-06-01",
        "/api/ai/classify",
        "/api/claim",
        "/api/agent/answer",
        "/api/rules/search?q=can+my+boss+find+out&st=MI",  # a search is typed in someone's own words
    ):
        assert quiet.filter(record(path)) is False, path


def test_access_log_keeps_no_address_and_no_query():
    quiet = QuietPaths()
    rec = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        "",
        0,
        '%s - "%s %s HTTP/%s" %d',
        ("203.0.113.9:51234", "GET", "/api/jurisdictions/MI?x=1", "1.1", 200),
        None,
    )
    assert quiet.filter(rec) is True
    line = rec.getMessage()
    assert line == '- - "GET /api/jurisdictions/MI HTTP/1.1" 200'
    assert "203.0.113.9" not in line and "x=1" not in line


def test_settings_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv("TEND_RULES_DIR", str(tmp_path / "rules"))
    monkeypatch.setenv("TEND_BANK", "nessie")
    monkeypatch.setenv("TEND_CORS_ORIGINS", "https://tend.example, http://localhost:3000")
    monkeypatch.setenv("TEND_LIVE_SCAN", "1")
    settings = Settings.from_env()
    assert settings.rules_dir == tmp_path / "rules"
    assert settings.bank_mode == "nessie" and settings.live_scan is True and settings.relay_live is False
    assert settings.cors_origins == ("https://tend.example", "http://localhost:3000")
    assert settings.database_url == str(DEFAULT_SQLITE) and settings.gemini_api_key == ""
    monkeypatch.setenv("NESSIE_API_KEY", "k")
    monkeypatch.setenv("GEMINI_API_KEY", "g")
    assert Settings.from_env().relay_live is True and Settings.from_env().gemini_api_key == "g"
    monkeypatch.setenv("TEND_CLOUD_AI", "0")
    assert Settings.from_env().gemini_api_key == ""
    monkeypatch.setenv("TEND_BANK", "yolo")
    with pytest.raises(ValueError):
        Settings.from_env()


def test_database_choice(monkeypatch):
    assert database_from_env() == (str(DEFAULT_SQLITE), None)
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@ep-x.neon.tech/db")
    monkeypatch.setenv("DATABASE_URL_POOLED", "postgresql://u:p@ep-x-pooler.neon.tech/db")
    # Neon by default once it is configured: requests use the pooler, migrations the direct endpoint.
    assert database_from_env() == ("postgresql://u:p@ep-x-pooler.neon.tech/db", "postgresql://u:p@ep-x.neon.tech/db")
    monkeypatch.setenv("TEND_DB", ":memory:")
    assert database_from_env() == (":memory:", None)
    monkeypatch.setenv("TEND_DB", "neon")
    monkeypatch.delenv("DATABASE_URL")
    monkeypatch.delenv("DATABASE_URL_POOLED")
    with pytest.raises(ValueError):
        database_from_env()


def test_env_file_wins_over_the_shell(monkeypatch, tmp_path):
    # The shell exported a stale GEMINI_API_KEY once; the project's .env must win.
    env = tmp_path / ".env"
    env.write_text("TEND_TEST_ONLY=from-file\nTEND_TEST_SET=from-file\n")
    monkeypatch.setenv("TEND_ENV_FILE", str(env))
    monkeypatch.setenv("TEND_TEST_SET", "stale-shell-value")
    monkeypatch.delenv("TEND_TEST_ONLY", raising=False)
    assert load_env_file() == Path(env)
    assert os.environ["TEND_TEST_ONLY"] == "from-file"
    assert os.environ["TEND_TEST_SET"] == "from-file"
    monkeypatch.delenv("TEND_TEST_ONLY")
    monkeypatch.delenv("TEND_TEST_SET")
    monkeypatch.setenv("TEND_ENV_FILE", "")
    assert load_env_file() is None
