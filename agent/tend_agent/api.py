"""Client for the Tend API. The agent never decides law or money itself; it asks the API.

/api/agent/answer and /api/agent/check are found through the API's OpenAPI document, so the agent adapts to
their field names. When the API does not have them yet, callers fall back to endpoints that exist today.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import httpx

OPENAPI_TTL_S = 300.0
DOC_TTL_S = 600.0

ANSWER_FIELDS = {
    "question": ("question", "q", "text", "query", "message", "prompt"),
    "st": ("st", "state", "jurisdiction", "code"),
}
CHECK_FIELDS = {
    "st": ("st", "state", "jurisdiction", "code"),
    "incident_date": ("incident_date", "date", "happened_on", "incident"),
    "forensic_exam": ("forensic_exam", "exam", "had_exam"),
    "police_report": ("police_report", "report", "reported"),
}
_NOT_FOUND = {"Not Found", "Method Not Allowed"}


class ApiError(Exception):
    def __init__(self, status: int, message: str, *, route_missing: bool = False):
        super().__init__(message)
        self.status = status
        self.message = message
        self.route_missing = route_missing


class RouteMissing(ApiError):
    def __init__(self, path: str):
        super().__init__(404, f"{path} is not on this API yet", route_missing=True)


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


@dataclass
class Plan:
    method: str
    path: str
    body_fields: list[str] = field(default_factory=list)
    query_fields: list[str] = field(default_factory=list)
    path_fields: list[str] = field(default_factory=list)


def _pick(fields: list[str], names: tuple[str, ...]) -> str | None:
    return next((n for n in names if n in fields), None)


def _shape(values: dict[str, Any], synonyms: dict[str, tuple[str, ...]], fields: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in values.items():
        if value is None:
            continue
        name = _pick(fields, synonyms.get(key, (key,)))
        if name is not None:
            out[name] = value
    return out


class TendApi:
    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 30.0,
        agent_key: str = "",
        transport: httpx.AsyncBaseTransport | None = None,
        now: Any = time.monotonic,
    ):
        headers = {"User-Agent": "tend-navigator/0.1"}
        if agent_key:
            headers["X-Agent-Key"] = agent_key
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=timeout, headers=headers, transport=transport)
        self._now = now
        self._openapi: tuple[float, dict[str, Any] | None] | None = None
        self._docs: dict[str, tuple[float, Any]] = {}

    async def aclose(self) -> None:
        await self._client.aclose()

    # ------------------------------------------------------------ plumbing

    async def _request(self, method: str, path: str, **kw: Any) -> Any:
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

    async def _cached(self, key: str, loader: Any) -> Any:
        hit = self._docs.get(key)
        if hit and self._now() - hit[0] < DOC_TTL_S:
            return hit[1]
        value = await loader()
        self._docs[key] = (self._now(), value)
        return value

    async def openapi(self) -> dict[str, Any] | None:
        if self._openapi and self._now() - self._openapi[0] < OPENAPI_TTL_S:
            return self._openapi[1]
        try:
            doc = await self._request("GET", "/api/openapi.json")
            doc = doc if isinstance(doc, dict) and isinstance(doc.get("paths"), dict) else None
        except ApiError:
            doc = None
        self._openapi = (self._now(), doc)
        return doc

    async def plan(self, base: str) -> Plan | None:
        """How to call a route, read from OpenAPI. None if the route is not there. Raises nothing."""
        doc = await self.openapi()
        if doc is None:
            return Plan("POST", base, list(_all_names()), [], [])  # unknown API: try the obvious shape
        paths = doc["paths"]
        candidates = [p for p in paths if p == base or (p.startswith(base + "/{") and p.count("/") == base.count("/") + 1)]
        if not candidates:
            return None
        path = candidates[0]
        ops = paths[path]
        method = "post" if "post" in ops else "get" if "get" in ops else next(iter(ops), "post")
        op = ops.get(method, {})
        params = op.get("parameters", [])
        return Plan(
            method=method.upper(),
            path=path,
            body_fields=_body_fields(doc, op),
            query_fields=[p["name"] for p in params if p.get("in") == "query"],
            path_fields=[p["name"] for p in params if p.get("in") == "path"],
        )

    async def _flexible(self, base: str, values: dict[str, Any], synonyms: dict[str, tuple[str, ...]]) -> Any:
        plan = await self.plan(base)
        if plan is None:
            raise RouteMissing(base)
        path = plan.path
        for name in plan.path_fields:
            key = next((k for k, names in synonyms.items() if name in names), None)
            if key is None or values.get(key) is None:
                raise RouteMissing(base)
            path = path.replace("{" + name + "}", str(values[key]))
        rest = {k: v for k, v in values.items() if not any(n in plan.path_fields for n in synonyms.get(k, ()))}
        try:
            if plan.method == "GET":
                query = _shape(rest, synonyms, plan.query_fields)
                return await self._request("GET", path, params={k: _query_value(v) for k, v in query.items()})
            return await self._request(plan.method, path, json=_shape(rest, synonyms, plan.body_fields))
        except ApiError as exc:
            if exc.route_missing:
                raise RouteMissing(base) from exc
            raise

    # ------------------------------------------------------------ law questions and Checks

    async def answer(self, question: str, st: str | None) -> dict[str, Any]:
        return await self._flexible("/api/agent/answer", {"question": question, "st": st}, ANSWER_FIELDS)

    async def check(self, st: str, incident_date: str | None, forensic_exam: bool | None, police_report: str) -> dict[str, Any]:
        values = {"st": st, "incident_date": incident_date, "forensic_exam": forensic_exam, "police_report": police_report}
        return await self._flexible("/api/agent/check", values, CHECK_FIELDS)

    async def checklist(self, st: str, incident_date: str | None, forensic_exam: bool | None, police_report: str) -> dict[str, Any]:
        params: dict[str, str] = {"police_report": police_report}
        if incident_date:
            params["incident_date"] = incident_date
        if forensic_exam is not None:
            params["forensic_exam"] = "true" if forensic_exam else "false"
        return await self._request("GET", f"/api/agent/checklist/{st}", params=params)

    async def jurisdiction(self, st: str) -> dict[str, Any]:
        return await self._cached(f"j:{st}", lambda: self._request("GET", f"/api/jurisdictions/{st}"))

    async def jurisdictions(self) -> list[dict[str, Any]]:
        data = await self._cached("j:*", lambda: self._request("GET", "/api/jurisdictions"))
        return list(data.get("jurisdictions", [])) if isinstance(data, dict) else []

    # ------------------------------------------------------------ the fictional demo claim

    async def scan(self, persona_id: str, st: str) -> dict[str, Any]:
        return await self._request("POST", "/api/scan", json={"persona_id": persona_id, "st": st})

    async def audit_bill(self, bill_id: str, persona_id: str, scan_id: str) -> dict[str, Any]:
        return await self._request("POST", "/api/bill/audit", json={"bill_id": bill_id, "persona_id": persona_id, "scan_id": scan_id})

    async def claim(self, engine_input: dict[str, Any], scan_id: str) -> dict[str, Any]:
        return await self._request("POST", "/api/claim", params={"scan_id": scan_id}, json=engine_input)

    async def propose(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", "/api/actions/propose", json=body)

    async def confirm(self, action_id: str, confirm_code: str) -> dict[str, Any]:
        return await self._request("POST", "/api/actions/confirm", json={"action_id": action_id, "confirm_code": confirm_code})

    # ------------------------------------------------------------ a packet someone linked from the Tend app

    async def redeem(self, link_code: str) -> dict[str, Any]:
        return await self._request("POST", "/api/agent/redeem", json={"link_code": link_code})

    async def linked_claim(self, token: str) -> dict[str, Any]:
        return await self._request("GET", "/api/agent/claim", headers={"Authorization": f"Bearer {token}"})


def _all_names() -> set[str]:
    return {n for names in (*ANSWER_FIELDS.values(), *CHECK_FIELDS.values()) for n in names[:1]}


def _query_value(v: Any) -> Any:
    return ("true" if v else "false") if isinstance(v, bool) else v


def _body_fields(doc: dict[str, Any], op: dict[str, Any]) -> list[str]:
    content = (op.get("requestBody") or {}).get("content") or {}
    schema = (content.get("application/json") or {}).get("schema") or {}
    seen: set[str] = set()
    while "$ref" in schema and schema["$ref"] not in seen:
        seen.add(schema["$ref"])
        name = schema["$ref"].rsplit("/", 1)[-1]
        schema = ((doc.get("components") or {}).get("schemas") or {}).get(name) or {}
    props = schema.get("properties") or {}
    return list(props.keys())
