"""How the Navigator reaches the Law and Bank+Packet agents.

The Navigator calls two async functions, desks.law(request) and desks.bank(request), and gets a typed reply back.
Locally they are separate uAgents and the calls travel as messages (link.py). In the Agentverse-hosted build the
same desks run in the Navigator's own process (LocalDesks). Either way the conversation code is the same.
"""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Any

DESK_NAMES = {"law": "the Law agent", "bank": "the Bank and Packet agent"}


class DeskDown(Exception):
    """A sub-agent did not answer in time, after every attempt."""

    def __init__(self, desk: str):
        super().__init__(f"{desk} did not answer")
        self.desk = desk


def failure(exc: Any) -> dict[str, Any]:
    """Reply fields for an API error: api_down when the server did not answer, else api_error with its status."""
    status = int(getattr(exc, "status", 0) or 0)
    return {"error": "api_down" if status == 0 else "api_error", "status": status, "text": str(getattr(exc, "message", exc))}


class Idempotent:
    """Runs each request id once. A retry that arrives while the request runs waits for the same result, and one
    that arrives soon after gets the same reply again. Results are kept only for that retry window."""

    def __init__(self, ttl_s: float = 90.0, now: Callable[[], float] = time.monotonic, max_entries: int = 256):
        self._ttl = ttl_s
        self._now = now
        self._max = max_entries
        self._done: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._running: dict[str, asyncio.Task[Any]] = {}

    def _sweep(self) -> None:
        cutoff = self._now() - self._ttl
        while self._done and next(iter(self._done.values()))[0] < cutoff:
            self._done.popitem(last=False)

    def _finish(self, key: str, task: asyncio.Task[Any]) -> None:
        self._running.pop(key, None)
        if task.cancelled() or task.exception() is not None:
            return
        self._done[key] = (self._now(), task.result())
        while len(self._done) > self._max:
            self._done.popitem(last=False)

    async def run(self, key: str, factory: Callable[[], Awaitable[Any]]) -> Any:
        self._sweep()
        hit = self._done.get(key)
        if hit is not None:
            return hit[1]
        task = self._running.get(key)
        if task is None:
            task = asyncio.ensure_future(factory())
            self._running[key] = task
            task.add_done_callback(lambda t, k=key: self._finish(k, t))
        return await asyncio.shield(task)


class LocalDesks:
    """Both desks in this process: the Agentverse-hosted build, the console, and most tests."""

    def __init__(self, law: Any, bank: Any):
        self.law: Callable[[Any], Awaitable[Any]] = law.handle
        self.bank: Callable[[Any], Awaitable[Any]] = bank.handle
