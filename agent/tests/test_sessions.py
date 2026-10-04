from __future__ import annotations

import json

from tend_agent.sessions import MemorySessions, StorageSessions


class Store:
    """Behaves like a uAgents key-value store (ctx.storage): JSON values, get/set/remove."""

    def __init__(self) -> None:
        self.data: dict[str, str] = {}

    def get(self, key: str):
        return json.loads(self.data[key]) if key in self.data else None

    def set(self, key: str, value) -> None:
        self.data[key] = json.dumps(value)

    def remove(self, key: str) -> None:
        self.data.pop(key, None)


def test_memory_sessions_expire_and_live_only_in_memory():
    clock = [0.0]
    s = MemorySessions(ttl_s=10, now=lambda: clock[0])
    s.put("a", {"st": "MI"})
    assert s.get("a") == {"st": "MI"}
    clock[0] = 11
    assert s.get("a") == {}


def test_storage_sessions_round_trip_expire_and_sweep():
    clock = [1000.0]
    store = Store()
    s = StorageSessions(store, ttl_s=10, now=lambda: clock[0])
    s.put("agent1qa", {"st": "MI", "demo": {"ref": {"payable_cents": 11800}}})
    assert s.get("agent1qa")["demo"]["ref"]["payable_cents"] == 11800
    clock[0] = 1005
    s.put("agent1qb", {"st": "OH"})
    clock[0] = 1012  # a's session has run out, b's has not
    assert s.get("agent1qa") == {}
    s.put("agent1qc", {"st": "TX"})  # any write sweeps what has expired
    assert "tend:s:agent1qa" not in store.data and set(store.get("tend:sessions")) == {"agent1qb", "agent1qc"}
    s.drop("agent1qb")
    assert s.get("agent1qb") == {} and set(store.get("tend:sessions")) == {"agent1qc"}


def test_storage_sessions_never_hold_message_text_or_codes():
    store = Store()
    s = StorageSessions(store)
    s.put("agent1qa", {"pending": {"action_id": "act_1", "amount_cents": 11800}})
    assert "482913" not in json.dumps(store.data)
