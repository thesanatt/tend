"""Record Nessie's real answers once, then replay them, so tests check real payloads without the network.

A cassette is a JSON file of exchanges: method, path, request body, and Nessie's status and body. The API
key travels in the query string and is never written down. Replay hands each request the first unused
exchange with the same method, path, and body, so a request repeated over time (a list read before and
after a write) gets its answers in the order they were recorded. A request with no recording raises and
is kept in `unmatched`, which is how a test shows that nothing was sent twice and nothing unplanned was
sent at all. seed/record_cassettes.py makes the files; only fictional demo personas are ever recorded.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

import httpx

FORMAT = "tend-nessie-cassette/1"


def _body(request: httpx.Request) -> Any:
    if not request.content:
        return None
    try:
        return json.loads(request.content)
    except ValueError:
        return request.content.decode("utf-8", "replace")


def _payload(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return response.text


class RecordingTransport(httpx.BaseTransport):
    """Passes every request to the real transport and keeps the exchange, without the query string."""

    def __init__(self, inner: httpx.BaseTransport | None = None):
        self.inner = inner or httpx.HTTPTransport()
        self.exchanges: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        response = self.inner.handle_request(request)
        content = response.read()
        exchange = {
            "method": request.method,
            "path": request.url.path,
            "body": _body(request),
            "status": response.status_code,
            "response": _payload(response),
        }
        with self._lock:
            self.exchanges.append(exchange)
        return httpx.Response(response.status_code, headers=response.headers, content=content, request=request)

    def take(self) -> list[dict[str, Any]]:
        with self._lock:
            taken, self.exchanges = self.exchanges, []
        return taken


def save(path: str | Path, exchanges: list[dict[str, Any]], *, note: str, context: dict[str, Any] | None = None) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = {"format": FORMAT, "note": note, "context": context or {}, "exchanges": exchanges}
    path.write_text(json.dumps(doc, indent=1, sort_keys=False) + "\n")


class Cassette:
    def __init__(self, exchanges: list[dict[str, Any]], context: dict[str, Any] | None = None):
        self.exchanges = exchanges
        self.context = context or {}
        self.used = [False] * len(exchanges)
        self.unmatched: list[str] = []
        self._lock = threading.Lock()

    @classmethod
    def load(cls, path: str | Path) -> Cassette:
        doc = json.loads(Path(path).read_text())
        if doc.get("format") != FORMAT:
            raise ValueError(f"not a Nessie cassette: {path}")
        return cls(doc["exchanges"], doc.get("context"))

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        key = (request.method, request.url.path, _body(request))
        with self._lock:
            for i, ex in enumerate(self.exchanges):
                if not self.used[i] and (ex["method"], ex["path"], ex["body"]) == key:
                    self.used[i] = True
                    break
            else:
                self.unmatched.append(f"{request.method} {request.url.path} {json.dumps(key[2])[:200]}")
                raise AssertionError(f"no recorded Nessie answer for {self.unmatched[-1]}")
        data = ex["response"]
        if isinstance(data, str):
            return httpx.Response(ex["status"], text=data)
        return httpx.Response(ex["status"], json=data)

    def unused(self) -> list[str]:
        return [f"{ex['method']} {ex['path']}" for ex, used in zip(self.exchanges, self.used, strict=True) if not used]

    def count(self, method: str, path_part: str = "") -> int:
        return sum(1 for ex in self.exchanges if ex["method"] == method and path_part in ex["path"])
