"""Per-person conversation state: ids, amounts, a state code, and the topic of an open question. Never the text of
a message, a confirm code, or anything about what happened. Each session ends after two quiet hours.

MemorySessions is the local agent's (nothing on disk). StorageSessions is for the Agentverse-hosted build, where
every message runs in a fresh process and only the agent's storage carries state from one message to the next.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Callable
from typing import Any

TTL_S = 7200.0


class MemorySessions:
    def __init__(self, ttl_s: float = TTL_S, now: Callable[[], float] = time.monotonic):
        self.ttl_s = ttl_s
        self.now = now
        self._data: dict[str, tuple[float, dict[str, Any]]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def lock(self, key: str) -> asyncio.Lock:
        if key not in self._locks:
            self._locks[key] = asyncio.Lock()
        return self._locks[key]

    def get(self, key: str) -> dict[str, Any]:
        hit = self._data.get(key)
        if hit is None or self.now() - hit[0] > self.ttl_s:
            self._data.pop(key, None)
            return {}
        return dict(hit[1])

    def put(self, key: str, state: dict[str, Any]) -> None:
        if state:
            self._data[key] = (self.now(), state)
        else:
            self._data.pop(key, None)
        for k in [k for k, (at, _) in self._data.items() if self.now() - at > self.ttl_s]:
            self._data.pop(k, None)
            self._locks.pop(k, None)

    def drop(self, key: str) -> None:
        self._data.pop(key, None)


class StorageSessions:
    """Sessions in a uAgents key-value store (ctx.storage). An index of keys lets every write sweep the expired ones."""

    PREFIX = "tend:s:"
    INDEX = "tend:sessions"

    def __init__(self, storage: Any, ttl_s: float = TTL_S, now: Callable[[], float] = time.time):
        self.storage = storage
        self.ttl_s = ttl_s
        self.now = now

    def lock(self, key: str) -> contextlib.AbstractAsyncContextManager[None]:
        return contextlib.nullcontext()  # type: ignore[return-value]  # one message per run when hosted

    def _index(self) -> dict[str, float]:
        raw = self.storage.get(self.INDEX)
        return {str(k): float(v) for k, v in raw.items()} if isinstance(raw, dict) else {}

    def get(self, key: str) -> dict[str, Any]:
        raw = self.storage.get(self.PREFIX + key)
        if not isinstance(raw, dict) or self.now() - float(raw.get("at") or 0) > self.ttl_s:
            return {}
        state = raw.get("state")
        return dict(state) if isinstance(state, dict) else {}

    def put(self, key: str, state: dict[str, Any]) -> None:
        index = self._index()
        now = self.now()
        if state:
            self.storage.set(self.PREFIX + key, {"at": now, "state": state})
            index[key] = now
        else:
            self._remove(key)
            index.pop(key, None)
        for k in [k for k, at in index.items() if now - at > self.ttl_s]:
            self._remove(k)
            index.pop(k, None)
        self.storage.set(self.INDEX, index)

    def drop(self, key: str) -> None:
        self.put(key, {})

    def _remove(self, key: str) -> None:
        remove = getattr(self.storage, "remove", None)
        if callable(remove):
            remove(self.PREFIX + key)
        else:
            self.storage.set(self.PREFIX + key, None)
