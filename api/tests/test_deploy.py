"""A public deployment (docs/DEPLOY.md): no file paths in health or errors, and /audit shows only the chain head."""

from __future__ import annotations

import dataclasses
import importlib.util
import json
import logging
import os
import re
import sys
import tomllib
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from helpers import CHECKING, make_services

from tend_api.app import create_app
from tend_api.config import API_DIR, REPO_ROOT, Settings
from tend_api.errors import TendError
from tend_api.redact import PublicErrors, redact_paths, redact_secrets, secret_values


@pytest.fixture
def deployed(settings: Settings) -> Settings:
    return dataclasses.replace(settings, deployed=True)


def deployed_client(settings: Settings, clock) -> TestClient:
    return TestClient(create_app(services=make_services(settings, clock)))


def test_repository_paths_become_relative_and_routes_stay():
    text = f"The native engine is not built ({REPO_ROOT}/engine/build/libtend.so is missing)."
    assert redact_paths(text) == "The native engine is not built (engine/build/libtend.so is missing)."
    kept = [
        "https://api.nessieisreal.com/accounts/abc/purchases?key=x",
        "/law/MI#MI-EXAM-1",
        "/api/shares/abc123",
        "MCL 18.355a(2) and/or 10/03/2026",
        "Run: python3 rules/tools/normalize.py MI",
    ]
    for text in kept:
        assert redact_paths(text) == text


def test_other_absolute_paths_lose_their_location():
    assert redact_paths("Could not load /var/task/engine/build/libtend.so: no such file") == "Could not load libtend.so: no such file"
    assert redact_paths({"why": ["see /tmp/tend/laws/MI.tlaw"]}, roots=[Path("/tmp/tend")]) == {"why": ["see laws/MI.tlaw"]}
    # A root ends at a slash: /tmp/tend never eats into /tmp/tendency.
    assert redact_paths("/tmp/tendency/x.json", roots=[Path("/tmp/tend")]) == "x.json"
    assert redact_paths(42) == 42


def test_settings_turn_deployed_on_under_vercel(monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.delenv("TEND_DEPLOYED", raising=False)
    assert Settings.from_env().deployed is True
    monkeypatch.setenv("TEND_DEPLOYED", "0")
    assert Settings.from_env().deployed is False
    monkeypatch.delenv("VERCEL")
    monkeypatch.delenv("TEND_DEPLOYED")
    assert Settings.from_env().deployed is False
    assert Settings.from_env().audit_rows is False


def test_local_health_keeps_the_details(client, settings):
    body = client.get("/api/health").json()
    assert "where" in body["database"]
    assert str(settings.engine_lib) in body["engines"]["native"]["reason"]


def test_deployed_health_names_no_paths(deployed, clock, tmp_path):
    with deployed_client(deployed, clock) as c:
        body = c.get("/api/health").json()
    text = json.dumps(body)
    assert str(tmp_path) not in text and str(tmp_path.resolve()) not in text
    assert str(REPO_ROOT) not in text
    assert "where" not in body["database"]
    native = body["engines"]["native"]
    assert native["available"] is False and "library" not in native
    assert "libtend.dylib is missing" in native["reason"]  # still says what is wrong, just not where


def test_deployed_engine_errors_name_no_paths(client, deployed, clock, tmp_path):
    local = client.get("/api/jurisdictions/MI/asm")
    assert local.status_code == 503 and str(tmp_path) in local.json()["detail"]
    with deployed_client(deployed, clock) as c:
        r = c.get("/api/jurisdictions/MI/asm")
    assert r.status_code == 503
    assert str(tmp_path) not in r.text and str(tmp_path.resolve()) not in r.text
    assert "libtend.dylib is missing" in r.json()["detail"]
    assert int(r.headers["content-length"]) == len(r.content)


def test_public_errors_cleans_every_json_error_and_nothing_else():
    app = FastAPI()
    seed = REPO_ROOT / "seed"

    @app.exception_handler(TendError)
    async def tend_error(_, exc: TendError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    @app.get("/refused")
    def refused() -> None:
        raise TendError(f"No itemized bill found for 'rowan-mi' under {seed}.", 404)

    @app.get("/fine")
    def fine() -> dict[str, str]:
        return {"path": str(seed)}  # successful bodies are the route's business

    app.add_middleware(PublicErrors, roots=(seed,))
    with TestClient(app) as c:
        assert c.get("/refused").json() == {"detail": "No itemized bill found for 'rowan-mi' under seed."}
        assert c.get("/fine").json() == {"path": str(seed)}


def test_public_errors_never_repeat_a_credential(monkeypatch, settings):
    """A library error can quote the request URL back (Nessie's key rides in ?key=) or a value it was given."""
    monkeypatch.setenv("NESSIE_API_KEY", "nessie-key-0123456789")
    deployed = dataclasses.replace(settings, gemini_api_key="gemini-key-abcdefgh", secret_hex="ab" * 32)
    secrets = secret_values(deployed)
    assert {"nessie-key-0123456789", "gemini-key-abcdefgh", "ab" * 32} <= set(secrets)
    assert ":memory:" not in secrets and "" not in secrets

    url = "https://api.nessieisreal.com/accounts/abc/withdrawals?key=0f9e8d7c6b5a&x=1"
    assert redact_secrets(f"Client error for url '{url}'") == (
        "Client error for url 'https://api.nessieisreal.com/accounts/abc/withdrawals?key=[hidden]&x=1'"
    )
    assert redact_secrets(["model said gemini-key-abcdefgh"], secrets) == ["model said [hidden]"]
    assert redact_secrets("MCL 18.355a(2) keeps the $325.00 line held") == "MCL 18.355a(2) keeps the $325.00 line held"

    app = FastAPI()

    @app.get("/leaky")
    def leaky() -> None:
        raise TendError(f"Nessie refused: GET {url} with nessie-key-0123456789", 502)

    @app.exception_handler(TendError)
    async def tend_error(_, exc: TendError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    app.add_middleware(PublicErrors, secrets=secrets)
    with TestClient(app) as c:
        r = c.get("/leaky")
    assert r.status_code == 502
    assert "0f9e8d7c6b5a" not in r.text and "nessie-key-0123456789" not in r.text
    assert r.json()["detail"].startswith("Nessie refused: GET https://api.nessieisreal.com/accounts/abc/withdrawals?key=[hidden]")
    assert int(r.headers["content-length"]) == len(r.content)


def pay(c: TestClient) -> None:
    proposal = c.post(
        "/api/actions/propose", json={"from": CHECKING, "payee": "Riverbend General Hospital (fictional)", "amount_cents": 11800}
    )
    assert proposal.status_code == 200, proposal.text
    done = c.post("/api/actions/confirm", json={"action_id": proposal.json()["action_id"], "confirm_code": proposal.json()["confirm_code"]})
    assert done.status_code == 200, done.text


def test_deployed_audit_shows_the_chain_head_and_counts_only(deployed, clock):
    with deployed_client(deployed, clock) as c:
        pay(c)
        body = c.get("/api/audit").json()
    assert set(body) == {"chain", "counts"}
    assert body["chain"]["ok"] is True and body["chain"]["rows"] == 2 and len(body["chain"]["head"]) == 64
    assert body["counts"] == {"confirmed": 1, "executed": 1}
    text = json.dumps(body)
    assert "11800" not in text and "2026-" not in text and "act_" not in text


def test_demo_flag_lists_the_audit_rows(deployed, clock):
    with deployed_client(dataclasses.replace(deployed, audit_rows=True), clock) as c:
        pay(c)
        body = c.get("/api/audit").json()
    assert [row["event"] for row in body["rows"]] == ["confirmed", "executed"]
    assert body["chain"]["head"] == body["rows"][-1]["hash"]


def test_vercel_entry_serves_the_app_deployed(monkeypatch):
    """api/index.py is what Vercel imports. It must expose a FastAPI `app`, deployed, reading laws from web/."""
    keys = ("TEND_DEPLOYED", "TEND_ENV_FILE", "TEND_CACHE_DIR", "TEND_LAW_DIR")
    for key in keys:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("TEND_DB", ":memory:")
    monkeypatch.setenv("TEND_RULES_DIR", str(Path(__file__).parent / "fixtures" / "rules"))
    monkeypatch.delitem(sys.modules, "tend_api.main", raising=False)
    quiet = ("httpx", "httpcore", "google_genai")
    levels = {name: logging.getLogger(name).level for name in quiet}
    spec = importlib.util.spec_from_file_location("vercel_index", API_DIR / "index.py")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
        settings = module.app.state.services.settings
        assert isinstance(module.app, FastAPI)
        assert settings.deployed is True
        assert settings.cache_dir == Path("/tmp/tend")
        laws = REPO_ROOT / "web" / "public" / "engine" / "laws"
        if laws.is_dir():
            assert settings.law_dirs == (laws,)
        # Vercel keeps INFO logs; the bank relay's outgoing requests must not be among them.
        assert all(logging.getLogger(name).level == logging.WARNING for name in quiet)
        with TestClient(module.app) as c:
            assert c.get("/api/health").status_code == 200
    finally:
        for key in keys:
            os.environ.pop(key, None)
        for name, level in levels.items():
            logging.getLogger(name).setLevel(level)
        if hasattr(module, "app"):
            module.app.state.services.repo.close()
        sys.modules.pop("tend_api.main", None)  # the next import builds its own app


def test_vercel_requirements_match_the_api_lock():
    """Vercel installs the API from requirements.txt at the repository root. It must pin what api/uv.lock pins.
    Regenerate: uv export --project api --frozen --no-dev --no-hashes --no-emit-project --format requirements-txt -o requirements.txt"""
    lock = tomllib.loads((API_DIR / "uv.lock").read_text())
    locked = {p["name"]: p["version"] for p in lock["package"] if "version" in p}
    pins: dict[str, str] = {}
    for line in (REPO_ROOT / "requirements.txt").read_text().splitlines():
        spec = line.split(";", 1)[0].strip()
        if spec and not spec.startswith("#"):
            name, _, version = spec.partition("==")
            pins[name.strip().lower()] = version.strip()
    stale = {name: (version, locked.get(name)) for name, version in pins.items() if locked.get(name) != version}
    assert pins and not stale, f"requirements.txt is out of date with api/uv.lock: {stale}"
    deps = tomllib.loads((API_DIR / "pyproject.toml").read_text())["project"]["dependencies"]
    direct = {re.split(r"[\[<>=!~ ]", dep, maxsplit=1)[0].lower() for dep in deps}
    assert direct <= set(pins), f"requirements.txt is missing {sorted(direct - set(pins))}"


def test_vercel_uploads_only_what_the_api_reads():
    """The root .vercelignore is an allowlist: never .env, never rules/sources, never the web app's code."""
    rules = (REPO_ROOT / ".vercelignore").read_text().splitlines()
    allowed = {r[1:] for r in rules if r.startswith("!")}
    assert "/*" in rules and "**/.env*" in rules
    assert {"/api", "/rules", "/seed", "/refengine", "/requirements.txt", "/vercel.json"} <= allowed
    assert {"api/tests", "api/.venv", "api/.data", "rules/*"} <= set(rules)  # local data and the snapshots stay home
    assert not any(a.startswith(("rules/sources", "/rules/sources", "web/app", "web/components", "web/lib")) for a in allowed)
    config = json.loads((REPO_ROOT / "vercel.json").read_text())
    assert config["framework"] == "fastapi" and "api/index.py" in config["functions"]
