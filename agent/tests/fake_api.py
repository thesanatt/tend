"""A mocked Tend API for the agent tests. Responses are real captures for the fictional demo persona
(tests/fixtures), and the payment endpoints follow the API's rules: one code, single use, 5 tries, 10 minutes."""

from __future__ import annotations

import copy
import datetime as dt
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from tend_agent.states import STATES

FIXTURES = Path(__file__).parent / "fixtures"
CODE = "482913"
LINK_CODE = "W7MZ-EPHM"


def load(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


@dataclass
class FakeTend:
    """Set answer_fields / check_fields to add /api/agent/answer and /api/agent/check to the OpenAPI document,
    with those request field names (the agent must discover them)."""

    answer_fields: tuple[str, ...] | None = None
    check_fields: tuple[str, ...] | None = None
    answer_reply: dict[str, Any] | None = None
    down: bool = False
    now: dt.datetime = field(default_factory=lambda: dt.datetime.now(dt.UTC))
    calls: list[dict[str, Any]] = field(default_factory=list)
    actions: dict[str, dict[str, Any]] = field(default_factory=dict)
    fail_once: set[str] = field(default_factory=set)  # paths that answer 503 the next time they are called
    checklist_patch: dict[str, Any] = field(default_factory=dict)  # merged into the checklist reply
    summary_patch: dict[str, Any] = field(default_factory=dict)  # merged into the linked claim summary

    # ------------------------------------------------------------ helpers for tests

    def bodies(self, path: str) -> list[Any]:
        return [c["json"] for c in self.calls if c["path"] == path]

    def paths(self) -> list[str]:
        return [c["path"] for c in self.calls]

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    # ------------------------------------------------------------ the API

    def openapi(self) -> dict[str, Any]:
        paths: dict[str, Any] = {
            "/api/jurisdictions": {"get": {}},
            "/api/jurisdictions/{st}": {"get": {"parameters": [{"name": "st", "in": "path"}]}},
            "/api/agent/checklist/{st}": {"get": {"parameters": [{"name": "st", "in": "path"}]}},
            "/api/scan": {"post": {}},
            "/api/claim": {"post": {}},
            "/api/actions/propose": {"post": {}},
            "/api/actions/confirm": {"post": {}},
        }
        schemas: dict[str, Any] = {}
        for base, fields, name in (
            ("/api/agent/answer", self.answer_fields, "AnswerRequest"),
            ("/api/agent/check", self.check_fields, "CheckRequest"),
        ):
            if fields is None:
                continue
            schemas[name] = {"type": "object", "properties": {f: {"type": "string"} for f in fields}}
            body = {"content": {"application/json": {"schema": {"$ref": f"#/components/schemas/{name}"}}}}
            paths[base] = {"post": {"requestBody": body}}
        return {"openapi": "3.1.0", "paths": paths, "components": {"schemas": schemas}}

    def handle(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("connection refused", request=request)
        body = json.loads(request.content) if request.content else None
        path = request.url.path
        self.calls.append(
            {"method": request.method, "path": path, "json": body, "params": dict(request.url.params), "headers": dict(request.headers)}
        )
        if path in self.fail_once:
            self.fail_once.discard(path)
            return httpx.Response(503, json={"detail": "Service Unavailable"})
        try:
            status, data = self.route(request.method, path, body, request)
        except KeyError as exc:  # a missing field in a request body is the agent's bug
            status, data = 422, {"detail": f"missing {exc}"}
        return httpx.Response(status, json=data)

    def route(self, method: str, path: str, body: Any, request: httpx.Request) -> tuple[int, Any]:
        if path == "/api/openapi.json":
            return 200, self.openapi()
        if path == "/api/jurisdictions":
            return 200, {"jurisdictions": [{"jurisdiction": c, "name": n} for c, n in STATES.items()]}
        if path.startswith("/api/jurisdictions/"):
            st = path.rsplit("/", 1)[-1].upper()
            if st == "MI":
                return 200, load("MI.json")
            if st in STATES:
                return 200, {
                    "jurisdiction": st,
                    "name": STATES[st],
                    "program": {"program_name": "Crime Victim Compensation", "phone": "555-0100"},
                    "rules": [],
                    "sources": [],
                }
            return 404, {"detail": f"No verified rules for {st}."}
        if path.startswith("/api/agent/checklist/"):
            data = load("checklist_MI.json")
            st = path.rsplit("/", 1)[-1].upper()
            data["jurisdiction"], data["name"] = st, STATES.get(st, st)
            data.update(copy.deepcopy(self.checklist_patch))
            return 200, data
        if path == "/api/agent/answer" and self.answer_fields is not None:
            return 200, self.answer_reply or {
                "answer": "Michigan does not let a provider bill you for a forensic exam.",
                "known": True,
                "citations": [c for c in load("checklist_MI.json")["exam_billing"]["protection"]],
            }
        if path == "/api/agent/check" and self.check_fields is not None:
            return 200, load("checklist_MI.json")
        if path == "/api/scan" and method == "POST":
            scan = load("scan_rowan_mi.json")
            scan["st"] = body["st"]
            scan["engine_input"]["jurisdiction"] = body["st"]
            return 200, scan
        if path == "/api/bill/audit":
            return 200, load("audit_rowan_mi.json")
        if path == "/api/claim":
            for item in body["items"]:
                if item.get("description") or item.get("confirmed") is not True:
                    return 422, {"detail": "the agent sent text or an unconfirmed item"}
            return 200, load("claim_rowan_mi.json")
        if path == "/api/actions/propose":
            return self.propose(body)
        if path == "/api/actions/confirm":
            return self.confirm(body)
        if path == "/api/agent/redeem":
            if body.get("link_code", "").replace(" ", "-").upper() == LINK_CODE:
                return 200, {
                    "agent_token": "tok-1",
                    "claim_id": "clm_1",
                    "packet_path": "/api/share/abc/packet.pdf",
                    "share_path": "/share/abc",
                }
            return 404, {"detail": "That link code is not valid, was already used, or has expired. Ask Tend for a new one."}
        if path == "/api/agent/claim":
            if request.headers.get("authorization") == "Bearer tok-1":
                return 200, {**load("linked_summary.json"), **copy.deepcopy(self.summary_patch)}
            return 401, {"detail": "This agent session is not valid or has expired."}
        return 404, {"detail": "Not Found"}

    def propose(self, body: dict[str, Any]) -> tuple[int, Any]:
        audit = load("audit_rowan_mi.json")
        held = {h["item_id"] for h in audit["holds"]}
        if body.get("kind") != "pay_bill" or set(body["item_ids"]) & held:
            return 409, {"detail": "This line is held under the exam billing law."}
        total = sum(ln["amount_cents"] for ln in audit["lines"] if ln["item_id"] in body["item_ids"])
        if total != body["amount_cents"]:
            return 409, {"detail": "The amount does not match the lines being paid."}
        action_id = f"act_{len(self.actions) + 1:020d}"
        expires = self.now + dt.timedelta(minutes=10)
        self.actions[action_id] = {"code": CODE, "status": "proposed", "attempts": 0, "expires": expires, "body": copy.deepcopy(body)}
        return 200, {
            "action_id": action_id,
            "status": "proposed",
            "kind": "pay_bill",
            "amount_cents": body["amount_cents"],
            "from": body["from_account_id"],
            "payee": body["payee"],
            "bill_id": body["bill_id"],
            "item_ids": body["item_ids"],
            "confirm_code": CODE,
            "expires_at": expires.isoformat().replace("+00:00", "Z"),
            "dry_run": True,
        }

    def confirm(self, body: dict[str, Any]) -> tuple[int, Any]:
        action = self.actions.get(body["action_id"])
        if action is None:
            return 404, {"detail": "No action with that id."}
        if action["status"] != "proposed":
            return 409, {"detail": f"This action is already {action['status']}. Each confirm code works once."}
        if action["expires"] <= self.now:
            return 410, {"detail": "This confirm code expired. Propose the payment again to get a new code."}
        if body["confirm_code"] != action["code"]:
            action["attempts"] += 1
            if action["attempts"] >= 5:
                action["status"] = "locked"
                return 423, {"detail": "Too many wrong codes. This action is locked; propose it again."}
            return 403, {"detail": "That code does not match this action."}
        action["status"] = "done"
        amount = action["body"]["amount_cents"]
        return 200, {
            "action_id": body["action_id"],
            "status": "done",
            "amount_cents": amount,
            "dry_run": True,
            "nessie_id": "dryrun-0001",
            "read_back_matches": True,
            "audit_id": "aud_000004",
            "message": f"Paid ${amount // 100}.{amount % 100:02d} to Riverbend General Hospital. Dry run: Tend recorded it and read it back, but did not send it to the bank.",
        }
