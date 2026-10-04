"""End-to-end tests of Tend's demo path in Chromium (Playwright for Python).

The session builds the web app (production, the way Vercel serves it), starts the API on an
in-memory database with the bank in dry-run mode (no Neon, no Nessie writes, no cloud AI, no keys:
the repo .env is not read), starts `next start`, and drives a real browser. The offline test stops
both servers and turns the browser's network off, so nothing it does can reach a server.

    web/e2e/run.sh                  # build, start, run everything
    E2E_SKIP_BUILD=1 web/e2e/run.sh # reuse the last e2e build (it was made for the same API port)
    web/e2e/run.sh -k offline       # pytest options pass through
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import time
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import pytest
from playwright.sync_api import Browser, Playwright, sync_playwright

WEB = Path(__file__).resolve().parents[1]
ROOT = WEB.parent
API_PORT = int(os.environ.get("E2E_API_PORT", "8790"))
WEB_PORT = int(os.environ.get("E2E_WEB_PORT", "3790"))
API_URL = f"http://127.0.0.1:{API_PORT}"
BASE_URL = f"http://localhost:{WEB_PORT}"
LOG_DIR = Path(os.environ.get("E2E_LOG_DIR", "/tmp/tend-e2e"))

TIMINGS: list[tuple[str, str, float]] = []


def record(test: str, step: str, seconds: float) -> None:
    TIMINGS.append((test, step, seconds))


def _port_free(port: int) -> bool:
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def _wait(url: str, seconds: float, proc: subprocess.Popen | None = None) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if proc is not None and proc.poll() is not None:
            raise RuntimeError(f"{url}: the server exited (see {LOG_DIR})")
        try:
            with urllib.request.urlopen(url, timeout=2) as res:
                if res.status < 500:
                    return
        except Exception:
            time.sleep(0.4)
    raise RuntimeError(f"{url} did not answer in {seconds:.0f} s (see {LOG_DIR})")


class Stack:
    """The API and the web app as separate processes, so a test can take either away."""

    def __init__(self) -> None:
        self.api: subprocess.Popen | None = None
        self.web: subprocess.Popen | None = None
        LOG_DIR.mkdir(parents=True, exist_ok=True)

    def _spawn(self, name: str, cmd: list[str], cwd: Path, env: dict[str, str]) -> subprocess.Popen:
        log = open(LOG_DIR / f"{name}.log", "ab")  # noqa: SIM115 (kept open for the process)
        return subprocess.Popen(cmd, cwd=cwd, env={**os.environ, **env}, stdout=log, stderr=subprocess.STDOUT,
                                start_new_session=True)

    def start_api(self) -> None:
        if not _port_free(API_PORT):
            raise RuntimeError(f"Port {API_PORT} is taken; set E2E_API_PORT")
        env = {
            "TEND_ENV_FILE": "",  # no secrets: in-memory database, dry-run bank, no cloud AI
            "TEND_DB": ":memory:",
            "TEND_BANK": "dry_run",
            "TEND_CLOUD_AI": "0",
            "TEND_RELAY_LIVE": "0",
            "TEND_CORS_ORIGINS": BASE_URL,
        }
        self.api = self._spawn("api", ["uv", "run", "--project", str(ROOT / "api"), "uvicorn", "tend_api.main:app",
                                       "--host", "127.0.0.1", "--port", str(API_PORT)], ROOT / "api", env)
        _wait(f"{API_URL}/api/health", 180, self.api)

    def start_web(self) -> None:
        if not _port_free(WEB_PORT):
            raise RuntimeError(f"Port {WEB_PORT} is taken; set E2E_WEB_PORT")
        self.web = self._spawn("web", ["npx", "next", "start", "--port", str(WEB_PORT)], WEB,
                               {"TEND_API_URL": API_URL})
        _wait(f"{BASE_URL}/check", 120, self.web)

    @staticmethod
    def _stop(proc: subprocess.Popen | None) -> None:
        if proc is None or proc.poll() is not None:
            return
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)

    def stop_api(self) -> None:
        self._stop(self.api)
        self.api = None

    def stop_web(self) -> None:
        self._stop(self.web)
        self.web = None
        # The port must really be closed before a test says the network is gone.
        for _ in range(50):
            if _port_free(WEB_PORT):
                return
            time.sleep(0.1)

    def stop(self) -> None:
        self.stop_web()
        self.stop_api()


def _build() -> None:
    manifest = WEB / ".next" / "routes-manifest.json"
    if os.environ.get("E2E_SKIP_BUILD") == "1" and manifest.exists():
        rewrites = json.loads(manifest.read_text()).get("rewrites", {})
        if API_URL in json.dumps(rewrites):
            return
        print(f"E2E_SKIP_BUILD ignored: the last build does not point at {API_URL}")
    if not (WEB / "node_modules").exists():
        subprocess.run(["npm", "ci", "--no-audit", "--no-fund"], cwd=WEB, check=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOG_DIR / "build.log", "wb") as log:
        subprocess.run(["npx", "next", "build"], cwd=WEB, env={**os.environ, "TEND_API_URL": API_URL},
                       stdout=log, stderr=subprocess.STDOUT, check=True)


@pytest.fixture(scope="session")
def stack() -> Iterator[Stack]:
    started = time.monotonic()
    _build()
    record("setup", "build the web app", time.monotonic() - started)
    s = Stack()
    t = time.monotonic()
    s.start_api()
    record("setup", "start the API", time.monotonic() - t)
    t = time.monotonic()
    s.start_web()
    record("setup", "start the web app", time.monotonic() - t)
    try:
        yield s
    finally:
        s.stop()


@pytest.fixture(scope="session")
def playwright() -> Iterator[Playwright]:
    with sync_playwright() as p:
        yield p


@pytest.fixture(scope="session")
def browser(playwright: Playwright) -> Iterator[Browser]:
    channel = os.environ.get("E2E_CHANNEL")  # "chrome" drives the installed Google Chrome instead
    try:
        b = playwright.chromium.launch(channel=channel) if channel else playwright.chromium.launch()
    except Exception:
        if channel or not shutil.which("google-chrome") and not Path("/Applications/Google Chrome.app").exists():
            raise
        b = playwright.chromium.launch(channel="chrome")
    yield b
    b.close()


def pytest_terminal_summary(terminalreporter, exitstatus, config):  # noqa: ARG001
    if not TIMINGS:
        return
    terminalreporter.section("demo path timings")
    width = max(len(step) for _, step, _ in TIMINGS)
    for test, step, seconds in TIMINGS:
        terminalreporter.write_line(f"{test:<16} {step:<{width}}  {seconds * 1000:8.0f} ms")
