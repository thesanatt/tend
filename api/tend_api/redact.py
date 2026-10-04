"""What a public deployment says about itself: no file paths in health or error messages (docs/DEPLOY.md).

Locally a path is the fastest way to fix a problem ("libtend.dylib is missing at ..."), so this runs only when
Settings.deployed is on. Paths under the repository become repository-relative, which shows nothing the public
repository does not. Other directories the settings name lose their location, and any other absolute path under
a system root is cut to its last part.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .config import REPO_ROOT, Settings

# Absolute paths under the usual system roots. App routes ("/law/MI#rule") and URLs never start with these, and a
# path inside a URL follows a host name, which the lookbehind refuses.
_SYSTEM_PATH = re.compile(
    r"(?<![\w.:/-])/(?:var|tmp|usr|opt|home|Users|private|root|etc|proc|lib|lib64|mnt|srv|run|nix|Library|Volumes)"
    r"(?:/[^\s/'\"(),:;]+)+"
)
_END = r"(/|(?=$|[\s'\"(),:;]))"  # a root ends at a slash or where the path ends, never inside a longer name


def path_roots(settings: Settings) -> tuple[Path, ...]:
    """Directories a message may name: the repository and every directory the settings point at."""
    dirs = (settings.rules_dir, settings.seed_dir, settings.refengine_dir, settings.forms_dir, settings.cache_dir)
    return (REPO_ROOT, settings.engine_lib.parent, *settings.law_dirs, *dirs)


def _patterns(roots: Iterable[Path]) -> list[re.Pattern[str]]:
    repo = {str(REPO_ROOT), str(REPO_ROOT.resolve())}
    found: list[str] = []
    for root in (REPO_ROOT, *roots):
        for form in (str(root), str(root.resolve())):
            # Inside the repository, removing the repository's own path is enough and keeps "engine/build/...".
            nested = form not in repo and any(form.startswith(r + "/") for r in repo)
            if form in ("", "/", ".") or nested or form in found:
                continue
            found.append(form)
    found.sort(key=len, reverse=True)  # the longest first, so /var/task wins over /var
    return [re.compile(re.escape(form) + _END) for form in found]


def _text(text: str, patterns: list[re.Pattern[str]]) -> str:
    for pattern in patterns:
        text = pattern.sub(lambda m: "" if m.group(1) == "/" else ".", text)
    return _SYSTEM_PATH.sub(lambda m: m.group(0).rsplit("/", 1)[-1], text)


def redact_paths(value: Any, roots: Iterable[Path] = ()) -> Any:
    """The same value with local paths taken out of every string in it (lists and dicts included)."""
    patterns = _patterns(roots)

    def walk(v: Any) -> Any:
        if isinstance(v, str):
            return _text(v, patterns)
        if isinstance(v, list | tuple):
            return [walk(x) for x in v]
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        return v

    return walk(value)


class PublicErrors:
    """In a public deployment, a JSON error body (status 400 and up) has local paths taken out before it is sent.
    Every error the API raises passes through here, so a message written for a developer cannot show this
    server's file layout to the public."""

    def __init__(self, app: ASGIApp, roots: tuple[Path, ...] = ()) -> None:
        self.app = app
        self.roots = roots

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        held: Message | None = None
        chunks: list[bytes] = []

        async def scrub(message: Message) -> None:
            nonlocal held
            if message["type"] == "http.response.start":
                headers = dict(message.get("headers", []))
                if message["status"] >= 400 and b"json" in headers.get(b"content-type", b""):
                    held = message  # send it with the cleaned body
                    return
            elif message["type"] == "http.response.body" and held is not None:
                chunks.append(message.get("body", b""))
                if message.get("more_body", False):
                    return
                body = b"".join(chunks)
                try:
                    body = json.dumps(redact_paths(json.loads(body), self.roots), ensure_ascii=False).encode("utf-8")
                except ValueError:  # not JSON after all: send it as it was
                    pass
                headers = [(k, v) for k, v in held.get("headers", []) if k.lower() != b"content-length"]
                headers.append((b"content-length", str(len(body)).encode("latin-1")))
                await send({**held, "headers": headers})
                await send({"type": "http.response.body", "body": body, "more_body": False})
                return
            await send(message)

        await self.app(scope, receive, scrub)
