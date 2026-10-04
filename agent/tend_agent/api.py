"""Client for the Tend API. The agents never decide law or money themselves; they ask the API, which runs the
law engine over the verified rules and holds the payment rules.

Reads retry once when the server is waking up (a dropped connection, 502, 503, or 504). Writes never retry here:
a payment proposal, a confirmation, or a share is sent once, and the Bank+Packet agent decides what a failure means.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

# httpx logs every request URL at INFO, and a Check's or a share's URL is nobody's business. Keep them out of logs.
for _name in ("httpx", "httpcore"):
    logging.getLogger(_name).setLevel(logging.WARNING)

DOC_TTL_S = 600.0
RETRY_STATUSES = {502, 503, 504}
_NOT_FOUND = {"Not Found", "Method Not Allowed"}


class ApiError(Exception):
    def __init__(self, status: int, message: str, *, route_missing: bool = False):
        super().__init__(message)
        self.status = status
        self.message = message
        self.route_missing = route_missing


def _detail(r: httpx.Response) -> str:
    try:
        body = r.json()
    except ValueError:
        return r.text[:200] or r.reason_phrase
    if isinstance(body, dict):
        detail = body.get("detail")
        if isinstance(detail, str):
            return detail
        if isinstance(detail, list):
            return "; ".join(str(d.get("msg", d)) if isinstance(d, dict) else str(d) for d in detail)[:300]
        err = body.get("error")
        if isinstance(err, dict) and err.get("message"):
            return str(err["message"])
    return r.reason_phrase


class TendApi:
    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 30.0,
        agent_key: str = "",
        transport: httpx.AsyncBaseTransport | None = None,
        now: Any = time.monotonic,
        retry_delay_s: float = 0.5,
    ):
        headers = {"User-Agent": "tend-navigator/0.2"}
        if agent_key:
            headers["X-Agent-Key"] = agent_key
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=timeout, headers=headers, transport=transport)
        self._now = now
        self._retry_delay_s = retry_delay_s
        self._docs: dict[str, tuple[float, Any]] = {}

    async def aclose(self) -> None:
        await self._client.aclose()

    # ------------------------------------------------------------ plumbing

    async def _once(self, method: str, path: str, **kw: Any) -> Any:
        try:
            r = await self._client.request(method, path, **kw)
        except httpx.TimeoutException as exc:
            raise ApiError(0, "Tend's server took too long to answer.") from exc
        except httpx.HTTPError as exc:
            raise ApiError(0, "Tend's server did not answer.") from exc
        if r.status_code >= 400:
            detail = _detail(r)
            raise ApiError(r.status_code, detail, route_missing=r.status_code in (404, 405) and detail in _NOT_FOUND)
        try:
            return r.json()
        except ValueError as exc:
            raise ApiError(r.status_code, "Tend's server sent a reply I could not read.") from exc

    async def _request(self, method: str, path: str, *, retry: bool = False, **kw: Any) -> Any:
        try:
            return await self._once(method, path, **kw)
        except ApiError as exc:
            if not retry or not (exc.status == 0 or exc.status in RETRY_STATUSES):
                raise
        await asyncio.sleep(self._retry_delay_s)
        return await self._once(method, path, **kw)

    async def _cached(self, key: str, loader: Any) -> Any:
        hit = self._docs.get(key)
        if hit and self._now() - hit[0] < DOC_TTL_S:
            return hit[1]
        value = await loader()
        self._docs[key] = (self._now(), value)
        return value

    # ------------------------------------------------------------ the public law corpus

    async def answer(self, question: str, st: str | None) -> dict[str, Any]:
        body: dict[str, Any] = {"question": question}
        if st:
            body["st"] = st
        return await self._request("POST", "/api/agent/answer", retry=True, json=body)

    async def check(self, st: str, incident_date: str | None, forensic_exam: bool | None, police_report: str) -> dict[str, Any]:
        body: dict[str, Any] = {"st": st, "police_report": police_report}
        if incident_date:
            body["incident_date"] = incident_date
        if forensic_exam is not None:
            body["forensic_exam"] = forensic_exam
        return await self._request("POST", "/api/agent/check", retry=True, json=body)

    async def jurisdiction(self, st: str) -> dict[str, Any]:
        return await self._cached(f"j:{st}", lambda: self._request("GET", f"/api/jurisdictions/{st}", retry=True))

    async def jurisdictions(self) -> list[dict[str, Any]]:
        data = await self._cached("j:*", lambda: self._request("GET", "/api/jurisdictions", retry=True))
        return list(data.get("jurisdictions", [])) if isinstance(data, dict) else []

    # ------------------------------------------------------------ the fictional demo claim

    async def scan(self, persona_id: str, st: str) -> dict[str, Any]:
        return await self._request("POST", "/api/scan", retry=True, json={"persona_id": persona_id, "st": st})

    async def audit_bill(self, bill_id: str, persona_id: str, scan_id: str) -> dict[str, Any]:
        body = {"bill_id": bill_id, "persona_id": persona_id, "scan_id": scan_id}
        return await self._request("POST", "/api/bill/audit", retry=True, json=body)

    async def claim(self, engine_input: dict[str, Any], scan_id: str) -> dict[str, Any]:
        return await self._request("POST", "/api/claim", retry=True, params={"scan_id": scan_id}, json=engine_input)

    # ------------------------------------------------------------ payments and shares (sent once)

    async def propose(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", "/api/actions/propose", json=body)

    async def confirm(self, action_id: str, confirm_code: str) -> dict[str, Any]:
        return await self._request("POST", "/api/actions/confirm", json={"action_id": action_id, "confirm_code": confirm_code})

    async def action(self, action_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/api/actions/{action_id}", retry=True)

    async def seal_share(self, ciphertext: str, iv: str, *, hours: int, once: bool = False) -> dict[str, Any]:
        body = {"ciphertext": ciphertext, "iv": iv, "alg": "AES-256-GCM", "expires_hours": hours, "once": once}
        return await self._request("POST", "/api/shares", json=body)
