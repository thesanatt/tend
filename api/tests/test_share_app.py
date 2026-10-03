from __future__ import annotations

import hashlib
import os
import sqlite3
from pathlib import Path

import pytest
from helpers import confirm_all, scan_rowan

from tend_api.config import Settings, load_env_file


def make_claim(client) -> str:
    scan = scan_rowan(client)
    return client.post("/api/claim", params={"scan_id": scan["scan_id"]}, json=confirm_all(scan["engine_input"])).json()["claim_id"]


def test_share_link_is_read_only_and_cited(client):
    claim_id = make_claim(client)
    link = client.post("/api/share", json={"claim_id": claim_id}).json()
    assert link["read_only"] is True
    assert link["path"] == f"/share/{link['token']}"
    assert link["expires_at"] == "2026-10-06T18:00:00.000000Z"  # 72 hours by default
    view = client.get(link["api_path"])
    assert view.status_code == 200
    assert view.headers["referrer-policy"] == "no-referrer"
    data = view.json()
    assert data["read_only"] is True and data["claim_id"] == claim_id
    assert all("citations" in line for line in data["lines"])
    assert data["needed"]
    pdf = client.get(f"{link['api_path']}/packet.pdf")
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")


def test_share_link_has_no_write_routes(client):
    link = client.post("/api/share", json={"claim_id": make_claim(client)}).json()
    assert client.post(link["api_path"], json={}).status_code == 405
    assert client.put(link["api_path"], json={}).status_code == 405


def test_only_the_token_hash_is_stored(services, client):
    link = client.post("/api/share", json={"claim_id": make_claim(client)}).json()
    conn = sqlite3.connect(services.settings.db_path)
    stored = [row[0] for row in conn.execute("SELECT token_hash FROM shares")]
    conn.close()
    assert stored == [hashlib.sha256(link["token"].encode()).hexdigest()]


def test_share_link_expires(client, clock):
    link = client.post("/api/share", json={"claim_id": make_claim(client), "ttl_hours": 1}).json()
    assert client.get(link["api_path"]).status_code == 200
    clock.advance(hours=1)
    r = client.get(link["api_path"])
    assert r.status_code == 410
    assert "expired" in r.json()["detail"]


def test_share_link_can_be_turned_off(client):
    link = client.post("/api/share", json={"claim_id": make_claim(client)}).json()
    assert client.delete(link["api_path"]).status_code == 204
    assert client.get(link["api_path"]).status_code == 410
    assert client.delete(link["api_path"]).status_code == 404


def test_share_errors(client):
    assert client.get("/api/share/" + "x" * 32).status_code == 404
    assert client.get("/api/share/short").status_code == 422
    assert client.post("/api/share", json={"claim_id": "clm_missing"}).status_code == 404
    assert client.post("/api/share", json={"claim_id": make_claim(client), "ttl_hours": 500}).status_code == 422


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


def test_health_reports_engines_and_bank(client):
    health = client.get("/api/health").json()
    assert health["ok"] is True
    assert health["bank"] == "dry_run"
    assert health["jurisdictions"] == ["MI", "WI"]
    assert health["engines"]["native"]["available"] is False
    assert health["engines"]["reference"]["available"] is True


def test_settings_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv("TEND_RULES_DIR", str(tmp_path / "rules"))
    monkeypatch.setenv("TEND_BANK", "nessie")
    monkeypatch.setenv("TEND_CORS_ORIGINS", "https://tend.example, http://localhost:3000")
    monkeypatch.setenv("TEND_LIVE_SCAN", "1")
    settings = Settings.from_env()
    assert settings.rules_dir == tmp_path / "rules"
    assert settings.bank_mode == "nessie" and settings.live_scan is True
    assert settings.cors_origins == ("https://tend.example", "http://localhost:3000")
    monkeypatch.setenv("TEND_BANK", "yolo")
    with pytest.raises(ValueError):
        Settings.from_env()


def test_env_file_loads_without_overriding(monkeypatch, tmp_path):
    env = tmp_path / ".env"
    env.write_text("TEND_TEST_ONLY=from-file\nTEND_TEST_SET=from-file\n")
    monkeypatch.setenv("TEND_ENV_FILE", str(env))
    monkeypatch.setenv("TEND_TEST_SET", "already-set")
    monkeypatch.delenv("TEND_TEST_ONLY", raising=False)
    assert load_env_file() == Path(env)
    assert os.environ["TEND_TEST_ONLY"] == "from-file"
    assert os.environ["TEND_TEST_SET"] == "already-set"
    monkeypatch.delenv("TEND_TEST_ONLY")
    monkeypatch.setenv("TEND_ENV_FILE", "")
    assert load_env_file() is None
