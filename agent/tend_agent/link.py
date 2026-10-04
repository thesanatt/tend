"""Request and reply between uAgents, matched by request_id, with a timeout per attempt and a fixed number of attempts.

The Navigator sends a typed request to the Law or Bank+Packet agent and waits for the reply with the same
request_id from that agent's address. A reply from any other address, or one that arrives after the Navigator
gave up, is dropped. A retry resends the same request_id; the sub-agent answers it once (desks.Idempotent).
When every attempt times out, the caller gets DeskDown and tells the person in plain words.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from typing import Any

from uagents_core.types import DeliveryStatus

from .desks import DeskDown


class AgentLink:
    def __init__(
        self,
        addresses: dict[str, str] | None = None,
        *,
        timeouts: dict[str, float] | None = None,
        attempts: int = 2,
        retry_pause_s: float = 1.0,
    ):
        self.addresses = dict(addresses or {})
        self.timeouts = dict(timeouts or {})
        self.attempts = max(1, attempts)
        self.retry_pause_s = retry_pause_s
        # Called after each answered call with (desk, request, reply, seconds, attempts). The rehearsal uses it to show
        # which agent did each step; it sees only the typed messages, which carry no message text.
        self.observer: Callable[[str, Any, Any, float, int], None] | None = None
        self._pending: dict[str, tuple[str, asyncio.Future[Any]]] = {}

    async def call(self, ctx: Any, desk: str, request: Any) -> Any:
        address = self.addresses.get(desk)
        if not address:
            raise DeskDown(desk)
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[request.request_id] = (desk, fut)
        timeout = float(self.timeouts.get(desk, 20.0))
        started = time.monotonic()
        tries = 0
        try:
            while tries < self.attempts:
                tries += 1
                status = await ctx.send(address, request, timeout=max(1, int(timeout)))
                if getattr(status, "status", None) == DeliveryStatus.FAILED:
                    if fut.done():
                        break
                    await asyncio.sleep(self.retry_pause_s)
                    continue
                try:
                    await asyncio.wait_for(asyncio.shield(fut), timeout)
                    break
                except TimeoutError:
                    continue
            if not fut.done():
                raise DeskDown(desk)
            reply = fut.result()
            if self.observer is not None:
                self.observer(desk, request, reply, time.monotonic() - started, tries)
            return reply
        finally:
            self._pending.pop(request.request_id, None)
            if not fut.done():
                fut.cancel()

    def resolve(self, sender: str, reply: Any) -> bool:
        """Hand a reply to the call waiting for it. False when nobody is waiting or the sender is not that desk."""
        entry = self._pending.get(getattr(reply, "request_id", ""))
        if entry is None:
            return False
        desk, fut = entry
        if sender != self.addresses.get(desk) or fut.done():
            return False
        fut.set_result(reply)
        return True


class RemoteDesks:
    """The desks as other agents, for one turn of the Navigator's conversation (it needs that turn's context)."""

    def __init__(self, ctx: Any, link: AgentLink):
        self._ctx = ctx
        self._link = link

    async def law(self, request: Any) -> Any:
        return await self._link.call(self._ctx, "law", request)

    async def bank(self, request: Any) -> Any:
        return await self._link.call(self._ctx, "bank", request)
