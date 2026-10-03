from __future__ import annotations

import dataclasses
import datetime as dt
import shutil
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from helpers import FIXTURES, FakeClock, law_image, make_services

from tend_api.app import create_app
from tend_api.config import API_DIR, Settings

OFFLINE_ENV = (
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "NESSIE_API_KEY",
    "NESSIE_BASE_URL",
    "DATABASE_URL",
    "DATABASE_URL_POOLED",
    "TEND_DB",
    "TEND_DB_SCHEMA",
    "TEND_BANK",
    "TEND_RELAY_LIVE",
    "TEND_SECRET",
    "TEND_ENV_FILE",
)


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "live: talks to a real service (Neon); skipped unless its flag is set")


@pytest.fixture(autouse=True)
def offline(request, monkeypatch):
    """Unit tests never reach Nessie or Gemini, and never see the keys exported in the shell."""
    for key in OFFLINE_ENV:
        monkeypatch.delenv(key, raising=False)
    if request.node.get_closest_marker("live"):
        return

    def refuse(self, req):
        raise AssertionError(f"a unit test tried to reach the network: {req.url}")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", refuse)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock(dt.datetime(2026, 10, 3, 18, 0, tzinfo=dt.UTC))


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        rules_dir=FIXTURES / "rules",
        seed_dir=FIXTURES / "seed",
        engine_lib=tmp_path / "engine" / "libtend.dylib",
        law_dirs=(tmp_path / "laws",),
        tendc=tmp_path / "engine" / "tendc",
        refengine_dir=tmp_path / "no-refengine",
        forms_dir=API_DIR / "forms",
        cache_dir=tmp_path / "cache",
        database_url=str(tmp_path / "tend.sqlite3"),
        bank_mode="dry_run",
        secret_hex="ab" * 32,
    )


@pytest.fixture
def services(settings: Settings, clock: FakeClock):
    return make_services(settings, clock)


@pytest.fixture
def client(services):
    with TestClient(create_app(services=services)) as c:
        yield c


@pytest.fixture(scope="session")
def fake_libtend(tmp_path_factory: pytest.TempPathFactory) -> Path:
    cc = shutil.which("cc") or shutil.which("clang") or shutil.which("gcc")
    if cc is None:
        pytest.skip("no C compiler to build the fake engine library")
    out = tmp_path_factory.mktemp("native") / ("libtend.dylib" if sys.platform == "darwin" else "libtend.so")
    subprocess.run([cc, "-shared", "-fPIC", "-O1", "-o", str(out), str(FIXTURES / "native" / "fake_tend.c")], check=True)
    return out


@pytest.fixture
def native_settings(settings: Settings, fake_libtend: Path) -> Settings:
    laws = settings.law_dirs[0]
    laws.mkdir(parents=True, exist_ok=True)
    (laws / "MI.tlaw").write_bytes(law_image())
    return dataclasses.replace(settings, engine_lib=fake_libtend)
