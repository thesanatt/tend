"""A mocked Tend API for the agent tests. Responses are real captures from the API on this branch for the fictional
demo persona and the public corpus (tests/fixtures, refreshed by scripts/capture_fixtures.py). The payment endpoints
follow the API's rules: one code, single use, 5 tries, 10 minutes. Shares keep only what the API keeps: ciphertext."""

from __future__ import annotations

import copy
import datetime as dt
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from tend_agent.states import STATES

FIXTURES = Path(__file__).parent / "fixtures"
CODE = "482913"
PROVIDER = "Riverbend General Hospital"


def load(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text())


def money(cents: int) -> str:
    return f"${cents // 100:,}.{cents % 100:02d}"


@dataclass
class FakeTend:
    down: bool = False
    answer_missing: bool = False  # the API has no /api/agent/answer route
    answer_reply: dict[str, Any] | None = None
    check_patch: dict[str, Any] = field(default_factory=dict)  # merged into the Check reply
    now: dt.datetime = field(default_factory=lambda: dt.datetime.now(dt.UTC))
    calls: list[dict[str, Any]] = field(default_factory=list)
    actions: dict[str, dict[str, Any]] = field(default_factory=dict)
    shares: dict[str, dict[str, Any]] = field(default_factory=dict)
    fail_once: set[str] = field(default_factory=set)  # paths that answer 503 the next time they are called
    fail_always: dict[str, int] = field(default_factory=dict)  # path -> status, every time

    # ------------------------------------------------------------ helpers for tests

    def bodies(self, path: str) -> list[Any]:
        return [c["json"] for c in self.calls if c["path"] == path]

    def paths(self) -> list[str]:
        return [c["path"] for c in self.calls]

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    # ------------------------------------------------------------ the API

    def handle(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("connection refused", request=request)
        body = json.loads(request.content) if request.content else None
        path = request.url.path
        self.calls.append(
            {"method": request.method, "path": path, "json": body, "params": dict(request.url.params), "headers": dict(request.headers)}
        )
        if path in self.fail_always:
            return httpx.Response(self.fail_always[path], json={"detail": "Service Unavailable"})
        if path in self.fail_once:
            self.fail_once.discard(path)
            return httpx.Response(503, json={"detail": "Service Unavailable"})
        try:
            status, data = self.route(request.method, path, body)
        except KeyError as exc:  # a missing field in a request body is the agent's bug
            status, data = 422, {"detail": f"missing {exc}"}
        return httpx.Response(status, json=data)

    def route(self, method: str, path: str, body: Any) -> tuple[int, Any]:
        if path == "/api/jurisdictions":
            return 200, load("jurisdictions.json")
        if path.startswith("/api/jurisdictions/"):
            st = path.rsplit("/", 1)[-1].upper()
            if st in ("MI", "OH"):
                return 200, load(f"{st}.json")
            if st in STATES:
                return 200, {
                    "jurisdiction": st,
                    "name": STATES[st],
                    "program": {"program_name": "Crime Victim Compensation", "phone": "555-0100"},
                    "rules": [],
                    "sources": [],
                }
            return 404, {"detail": f"No verified rules for {st}."}
        if path == "/api/agent/answer":
            if self.answer_missing:
                return 404, {"detail": "Not Found"}
            return 200, self.answer(body)
        if path == "/api/agent/check" and method == "POST":
            exam = body.get("forensic_exam")
            data = load("check_MI.json" if exam is True else "check_MI_noexam.json" if exam is False else "check_MI_unsure.json")
            st = body["st"]
            data["st"], data["name"] = st, STATES.get(st, st)
            data["inputs"] = {k: body.get(k) for k in ("incident_date", "forensic_exam", "police_report")}
            data.update(copy.deepcopy(self.check_patch))
            return 200, data
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
                    return 422, {"detail": "the agent sent bill or merchant text, or an unconfirmed item"}
            claim = load("claim_rowan_mi.json")
            claim["jurisdiction"] = body["jurisdiction"]
            return 200, claim
        if path == "/api/actions/propose":
            return self.propose(body)
        if path == "/api/actions/confirm":
            return self.confirm(body)
        if path.startswith("/api/actions/") and method == "GET":
            return self.action_view(path.rsplit("/", 1)[-1])
        if path == "/api/shares" and method == "POST":
            return self.seal(body)
        if path.startswith("/api/shares/") and method == "GET":
            share = self.shares.get(path.rsplit("/", 1)[-1])
            return (200, share) if share else (404, {"detail": "This link is not valid. It may have been deleted."})
        return 404, {"detail": "Not Found"}

    def answer(self, body: dict[str, Any]) -> dict[str, Any]:
        if self.answer_reply is not None:
            return copy.deepcopy(self.answer_reply)
        q, st = body["question"].lower(), body.get("st")
        if st == "MI" and re.search(r"\bexam|\bkit\b|bill me|billed", q):
            return load("answer_MI_exam.json")
        if st == "MI" and re.search(r"counsel|therap", q):
            return load("answer_MI_counseling.json")
        if st == "MI" and re.search(r"deadline|how long", q):
            return load("answer_MI_deadline.json")
        if st == "OH" and re.search(r"deadline|how long", q):
            return load("answer_OH_deadline.json")
        refusal = load("answer_MI_unknown.json")
        refusal.update(st=st, name=STATES.get(st or "", st), question=body["question"])
        return refusal

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
            action["status"] = "expired"
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
            "message": f"Paid {money(amount)} to {PROVIDER}. Dry run: Tend recorded it and read it back, but did not send it to the bank.",
        }

    def action_view(self, action_id: str) -> tuple[int, Any]:
        action = self.actions.get(action_id)
        if action is None:
            return 404, {"detail": "No action with that id."}
        done = action["status"] == "done"
        return 200, {
            "action_id": action_id,
            "status": action["status"],
            "amount_cents": action["body"]["amount_cents"],
            "payee": None if done else action["body"]["payee"],  # the API forgets the payee once a payment finishes
            "dry_run": True,
            "withdrawal_id": "dryrun-0001" if done else None,
            "readback": {"ok": True} if done else None,
            "audit": [{"seq": 3, "event": "confirmed"}, {"seq": 4, "event": "executed"}] if done else [],
        }

    def seal(self, body: dict[str, Any]) -> tuple[int, Any]:
        if set(body) - {"ciphertext", "iv", "alg", "expires_hours", "once"}:
            return 422, {"detail": "extra fields"}
        share_id = f"shr{len(self.shares) + 1:013d}"
        expires = self.now + dt.timedelta(hours=int(body.get("expires_hours", 72)))
        self.shares[share_id] = {
            "id": share_id,
            "alg": "AES-256-GCM",
            "ciphertext": body["ciphertext"],
            "iv": body["iv"],
            "expires_at": expires.isoformat().replace("+00:00", "Z"),
            "once": bool(body.get("once")),
        }
        return 201, {
            "id": share_id,
            "expires_at": self.shares[share_id]["expires_at"],
            "once": bool(body.get("once")),
            "api_path": f"/api/shares/{share_id}",
        }
