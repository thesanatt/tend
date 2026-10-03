"""Expired payment proposals lose their payee, and expired shares their ciphertext, soon after they expire.

Every new payment and share sweeps as it arrives. On a quiet server the app sweeps once after it starts and
then only when something this process stored has come due, so an idle server sends Neon no queries and its
compute can suspend.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import heapq
import logging
import threading
from typing import TYPE_CHECKING

from .clock import iso

if TYPE_CHECKING:
    from .services import Services

SWEEP_EVERY_S = 60.0
log = logging.getLogger("tend")


class SweepSchedule:
    """When things this process stored expire. Only the times: no ids, amounts, or names."""

    def __init__(self) -> None:
        self._due: list[dt.datetime] = []
        self._lock = threading.Lock()

    def add(self, at: dt.datetime) -> None:
        with self._lock:
            heapq.heappush(self._due, at)

    def take_due(self, now: dt.datetime) -> bool:
        """True when something has expired since the last sweep. Those times are then forgotten."""
        taken = False
        with self._lock:
            while self._due and self._due[0] <= now:
                heapq.heappop(self._due)
                taken = True
        return taken


async def sweep_forever(services: Services, every_s: float = SWEEP_EVERY_S) -> None:
    swept = False
    while True:
        await asyncio.sleep(every_s)
        now = services.clock()
        due = services.sweeps.take_due(now)
        if swept and not due:
            continue
        try:
            await asyncio.to_thread(services.repo.sweep, iso(now))
            swept = True
        except Exception as exc:  # a database hiccup: try again next round
            services.sweeps.add(now)
            log.warning("sweep failed: %s", type(exc).__name__)
