"""Push Tend's settings and secrets to its two Vercel projects without printing a value (docs/DEPLOY.md).

usage, from the repository root once `vercel link` has linked it to tend-api and web/ to tend-web:
  uv run --project api python scripts/vercel/env.py api preview
  uv run --project api python scripts/vercel/env.py api production
  uv run --project api python scripts/vercel/env.py web preview --api-url https://tend-api-<id>-thesanatts-projects.vercel.app
  uv run --project api python scripts/vercel/env.py web production --api-url https://tend-api-thesanatts-projects.vercel.app

Keys come from the .env file (TEND_ENV_FILE, or the nearest .env above the repository). TEND_SECRET is made
fresh only when that environment has none, so pending confirm codes survive a rerun. The API's protection
bypass secret is created on tend-api the first time and reused after that; tend-web gets it as
TEND_API_BYPASS, which web/vercel.json sends with every /api request it proxies to the protected API.
"""

from __future__ import annotations

import argparse
import json
import secrets
import string
import subprocess
import sys
from pathlib import Path

from dotenv import dotenv_values

REPO = Path(__file__).resolve().parents[2]
SCOPE = "thesanatts-projects"
API_PROJECT = "tend-api"
FROM_ENV_FILE = ("DATABASE_URL_POOLED", "DATABASE_URL", "NESSIE_API_KEY", "NESSIE_BASE_URL", "GEMINI_API_KEY")
SETTINGS = {
    # Production writes payments to Nessie and is served at youreowed.tech.
    "production": {
        "TEND_BANK": "nessie",
        "TEND_PUBLIC_URL": "https://youreowed.tech",
        "TEND_CORS_ORIGINS": "https://youreowed.tech,https://www.youreowed.tech",
    },
    # Previews never move mock money and keep their own tables, so a test payment never lands in
    # production's append-only audit chain. Load the corpus once: uv run python -m tend_api.loader --schema vercel_preview
    "preview": {"TEND_BANK": "dry_run", "TEND_DB_SCHEMA": "vercel_preview"},
}
_secret_values: list[str] = []  # anything printed from the CLI has these taken out first


def vercel(args: list[str], cwd: Path) -> str:
    proc = subprocess.run(["vercel", *args, "--scope", SCOPE], cwd=cwd, capture_output=True, text=True)
    if proc.returncode != 0:
        out = (proc.stderr or proc.stdout).strip()
        for value in _secret_values:
            out = out.replace(value, "[hidden]")
        sys.exit(f"vercel {args[0]} {args[1] if len(args) > 1 else ''} failed:\n{out[-1500:]}")
    return proc.stdout


def names(cwd: Path, target: str) -> set[str]:
    text = vercel(["env", "ls", target, "--format", "json"], cwd)
    body = json.loads(text[text.index("{") :]) if "{" in text else {}
    return {e["key"] for e in body.get("envs", []) if target in (e.get("target") or [])}


def put(cwd: Path, name: str, target: str, value: str, *, sensitive: bool) -> None:
    if sensitive:
        _secret_values.append(value)
    flags = [] if sensitive else ["--no-sensitive"]
    branch = [""] if target == "preview" else []  # "" is every Preview branch; the CLI asks otherwise
    vercel(["env", "add", name, target, *branch, "--value", value, "--yes", "--force", *flags], cwd)
    print(f"  {name:<20} {target:<10} {'set (sensitive)' if sensitive else 'set'}")


def env_file() -> dict[str, str]:
    from os import environ

    explicit = environ.get("TEND_ENV_FILE")
    path = Path(explicit) if explicit else next((d / ".env" for d in (REPO, *REPO.parents) if (d / ".env").is_file()), None)
    if path is None or not path.is_file():
        sys.exit("No .env file found; set TEND_ENV_FILE")
    values = {k: v for k, v in dotenv_values(path).items() if v}
    missing = [k for k in FROM_ENV_FILE if k not in values]
    if missing:
        sys.exit(f"{path} is missing {', '.join(missing)}")
    return values


def api_bypass() -> str:
    """The automation bypass secret on tend-api: the existing one, or a new one."""
    text = vercel(["project", "protection", API_PROJECT, "--format", "json"], REPO)
    body = json.loads(text[text.index("{") :])
    for secret, meta in (body.get("protectionBypass") or {}).items():
        if (meta or {}).get("scope") == "automation-bypass":
            _secret_values.append(secret)
            return secret
    secret = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(32))
    _secret_values.append(secret)
    vercel(["project", "protection", "enable", API_PROJECT, "--protection-bypass", "--protection-bypass-secret", secret], REPO)
    print(f"  created a protection bypass secret on {API_PROJECT}")
    return secret


def push_api(target: str) -> None:
    values = env_file()
    print(f"{API_PROJECT} ({target}):")
    for name in FROM_ENV_FILE:
        put(REPO, name, target, values[name], sensitive=True)
    if "TEND_SECRET" not in names(REPO, target):
        put(REPO, "TEND_SECRET", target, secrets.token_hex(32), sensitive=True)
    else:
        print(f"  {'TEND_SECRET':<20} {target:<10} kept")
    for name, value in SETTINGS[target].items():
        put(REPO, name, target, value, sensitive=False)


def push_web(target: str, api_url: str) -> None:
    if not api_url.startswith("https://"):
        sys.exit("--api-url must be the https:// address of a tend-api deployment")
    print(f"tend-web ({target}):")
    put(REPO / "web", "TEND_API_URL", target, api_url.rstrip("/"), sensitive=False)
    put(REPO / "web", "TEND_API_BYPASS", target, api_bypass(), sensitive=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("project", choices=["api", "web"])
    parser.add_argument("target", choices=["preview", "production"])
    parser.add_argument("--api-url", help="web only: the tend-api deployment /api/* goes to")
    args = parser.parse_args()
    if args.project == "api":
        push_api(args.target)
    elif not args.api_url:
        parser.error("web needs --api-url")
    else:
        push_web(args.target, args.api_url)


if __name__ == "__main__":
    main()
