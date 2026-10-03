from __future__ import annotations

import datetime as dt
import hashlib
import re
import secrets
from pathlib import Path
from typing import Any

from .actions import ActionService
from .claims import HOLD_MESSAGE, ClaimService
from .clock import Clock, iso, local_today, parse_iso
from .engine import EngineError, EngineRouter, EngineUnavailable
from .errors import TendError
from .models import AgentConfirmRequest, AgentPayRequest, ConfirmRequest, ProposeRequest
from .money import format_cents, parse_cents
from .rules import RulesStore, citation, rule_expense
from .scan import ScanError, account_ids, load_snapshot
from .share import ShareService
from .storage import Repository

LINK_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"  # no 0/O, 1/I/L: the survivor reads it aloud or types it
LINK_TTL = dt.timedelta(minutes=30)
SESSION_TTL = dt.timedelta(hours=2)
CONFIRM_PHRASE = re.compile(r"^\s*confirm\s+\$?(?P<amount>\d[\d,]*(?:\.\d{2})?)\s*$", re.I)
NOT_INCLUDED = ("excluded", "unknown_rule", "out_of_window")


class AgentError(TendError):
    pass


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalize_link_code(code: str) -> str:
    return re.sub(r"[^0-9A-Za-z]", "", code).upper()


def confirm_phrase(amount_cents: int) -> str:
    return f"confirm {format_cents(amount_cents)[1:]}"


def _cite(c: dict[str, Any]) -> dict[str, Any]:
    return {k: c.get(k) for k in ("rule_id", "pinpoint", "quote", "fragment_url")}


class AgentService:
    """What the Fetch.ai agent can do: a public cited checklist, and, after the survivor links it with a
    one-time code, a summary without bill text and payments that need a typed approval."""

    def __init__(
        self,
        repo: Repository,
        rules: RulesStore,
        engines: EngineRouter,
        claims: ClaimService,
        actions: ActionService,
        shares: ShareService,
        seed_dir: Path,
        clock: Clock,
    ):
        self.repo = repo
        self.rules = rules
        self.engines = engines
        self.claims = claims
        self.actions = actions
        self.shares = shares
        self.seed_dir = seed_dir
        self.clock = clock

    def checklist(self, st: str, incident_date: dt.date | None) -> dict[str, Any]:
        doc = self.rules.get(st)
        if doc is None:
            raise AgentError(f"No verified rules for {st}.", 404)
        sources = self.rules.sources_by_id(st)

        def cites(*categories: str) -> list[dict[str, Any]]:
            return [_cite(citation(r, sources)) for r in doc["rules"] if r.get("category") in categories]

        today = local_today(self.clock())
        checks: dict[str, Any] = {}
        engine = None
        if incident_date is not None:
            payload = {
                "jurisdiction": st,
                "context": {
                    "incident_date": incident_date.isoformat(),
                    "as_of_date": today.isoformat(),
                    "police_report": "unknown",
                    "forensic_exam": True,
                },
                "items": [],
            }
            try:
                output, engine = self.engines.evaluate(payload)
                checks = output.get("checks") or {}
            except (EngineUnavailable, EngineError):
                checks = {}
        rules_by_id = self.rules.rules_by_id(st)

        def check(name: str, category: str) -> dict[str, Any]:
            found = checks.get(name)
            if found is None:
                return {"status": "unknown", "citations": cites(category)}
            return {**found, "citations": [_cite(citation(rules_by_id[r], sources)) for r in found.get("rule_ids", []) if r in rules_by_id]}

        covered: dict[str, list[dict[str, Any]]] = {}
        for r in doc["rules"]:
            if r.get("category") == "covered_expense" and rule_expense(r):
                covered.setdefault(rule_expense(r), []).append(_cite(citation(r, sources)))
        program = doc.get("program", {})
        return {
            "jurisdiction": st,
            "name": doc.get("name"),
            "program": {k: program.get(k) for k in ("program_name", "agency", "phone", "website", "apply_url", "statute_citation")},
            "as_of_date": today.isoformat(),
            "incident_date": incident_date.isoformat() if incident_date else None,
            "engine": engine,
            "deadline": check("deadline", "filing_deadline"),
            "reporting": check("reporting", "reporting_requirement"),
            "exam_billing": {"protection": cites("exam_no_bill"), "who_pays": cites("exam_payment")},
            "covered": [{"expense": e, "citations": c} for e, c in sorted(covered.items())],
            "not_covered": cites("excluded_expense"),
            "caps": cites("total_cap", "expense_cap"),
            "note": "Rules can have exceptions. The Commission decides.",
        }

    def create_link(self, claim_id: str) -> dict[str, Any]:
        self.claims.get(claim_id)
        raw = "".join(secrets.choice(LINK_ALPHABET) for _ in range(8))
        now = self.clock()
        expires_at = iso(now + LINK_TTL)
        self.repo.insert_agent_link({"code_hash": _hash(raw), "claim_id": claim_id, "created_at": iso(now), "expires_at": expires_at})
        code = f"{raw[:4]}-{raw[4:]}"
        return {"link_code": code, "expires_at": expires_at, "say_to_agent": f"link {code}"}

    def redeem(self, link_code: str) -> dict[str, Any]:
        code = normalize_link_code(link_code)
        now = self.clock()
        claim_id = self.repo.redeem_agent_link(_hash(code), iso(now)) if len(code) == 8 else None
        if claim_id is None:
            raise AgentError("That link code is not valid, was already used, or has expired. Ask Tend for a new one.", 404)
        token = secrets.token_urlsafe(32)
        expires_at = iso(now + SESSION_TTL)
        self.repo.insert_agent_session({"token_hash": _hash(token), "claim_id": claim_id, "created_at": iso(now), "expires_at": expires_at})
        share = self.shares.create(claim_id, ttl_hours=int(SESSION_TTL.total_seconds() // 3600))
        return {
            "agent_token": token,
            "expires_at": expires_at,
            "claim_id": claim_id,
            "packet_path": f"{share['api_path']}/packet.pdf",
            "share_path": share["path"],
        }

    def session_claim(self, token: str) -> str:
        session = self.repo.get_agent_session(_hash(token))
        if session is None or parse_iso(session["expires_at"]) <= self.clock():
            raise AgentError("This agent session is not valid or has expired. Ask Tend for a new link code.", 401)
        return session["claim_id"]

    def summary(self, claim_id: str) -> dict[str, Any]:
        """Totals by expense with the rules behind them. No descriptions or bill text leave through the agent."""
        view = self.claims.view(self.claims.get(claim_id))
        by_expense: dict[str, dict[str, Any]] = {}
        for ln in view["lines"]:
            if ln["status"] != "eligible":
                continue
            entry = by_expense.setdefault(ln["expense"], {"expense": ln["expense"], "allowed_cents": 0, "lines": 0, "rules": {}})
            entry["allowed_cents"] += ln["allowed_cents"]
            entry["lines"] += 1
            for c in ln["citations"]:
                entry["rules"][c["rule_id"]] = _cite(c)
        held = [
            {
                "item_id": ln["item_id"],
                "amount_cents": ln["amount_cents"],
                "message": HOLD_MESSAGE,
                "rules": [_cite(c) for c in ln["citations"] if c.get("category") == "exam_no_bill"],
            }
            for ln in view["lines"]
            if ln["status"] == "held"
        ]
        program = view.get("program") or {}
        return {
            "claim_id": claim_id,
            "jurisdiction": view["jurisdiction"],
            "fictional": view["fictional"],
            "program": {k: program.get(k) for k in ("program_name", "agency", "phone", "website", "apply_url")},
            "amount_you_can_ask_for_cents": view["totals"].get("allowed_cents", 0),
            "by_expense": [{**e, "rules": list(e["rules"].values())} for e in sorted(by_expense.values(), key=lambda e: e["expense"])],
            "held": held,
            "held_cents": view["totals"].get("held_cents", 0),
            "waiting_for_confirmation": sum(1 for ln in view["lines"] if ln["status"] == "needs_confirmation"),
            "not_included": [
                {"item_id": ln["item_id"], "amount_cents": ln["amount_cents"], "status": ln["status"]}
                for ln in view["lines"]
                if ln["status"] in NOT_INCLUDED
            ],
            "checks": {
                name: {k: check.get(k) for k in ("status", "deadline_date") if k in check}
                | {"rules": [_cite(c) for c in check["citations"]]}
                for name, check in view["checks"].items()
            },
            "note": "Amount you can ask for. The Commission decides.",
        }

    def pay(self, claim_id: str, req: AgentPayRequest) -> dict[str, Any]:
        self._check_account(self.claims.get(claim_id), req.from_account)
        proposed = self.actions.propose(
            ProposeRequest(
                from_account=req.from_account, payee=req.payee, amount_cents=req.amount_cents, claim_id=claim_id, item_id=req.item_id
            ),
            channel="agent",
        )
        phrase = confirm_phrase(req.amount_cents)
        return {
            **proposed,
            "confirm_phrase": phrase,
            "ask_user": f'Pay {format_cents(req.amount_cents)} to {req.payee}? Nothing moves until you type "{phrase}".',
        }

    def confirm(self, claim_id: str, req: AgentConfirmRequest) -> dict[str, Any]:
        action = self.repo.get_action(req.action_id)
        if action is None or action["claim_id"] != claim_id:
            raise AgentError("No payment with that id in this session.", 404)
        typed = CONFIRM_PHRASE.match(req.typed)
        if typed is None or parse_cents(typed.group("amount")) != action["amount_cents"]:
            raise AgentError(f'Nothing was paid. To approve, type exactly: "{confirm_phrase(action["amount_cents"])}"', 409)
        return self.actions.confirm(ConfirmRequest(action_id=req.action_id, confirm_code=req.confirm_code), channel="agent")

    def _check_account(self, claim: dict[str, Any], account_id: str) -> None:
        # When the claim came from a persona snapshot, the agent may only pay from that person's own accounts.
        scan = self.repo.get_scan(claim["scan_id"]) if claim.get("scan_id") else None
        if not scan or not scan.get("persona_id"):
            return
        try:
            accounts = account_ids(load_snapshot(self.seed_dir, scan["persona_id"]))
        except ScanError:
            return
        if accounts and account_id not in accounts:
            raise AgentError("The agent can only pay from your own accounts.", 403)
