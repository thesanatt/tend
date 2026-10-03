from __future__ import annotations

import re
import secrets
from pathlib import Path
from typing import Any

from .bill import (
    INSURANCE_MENTION,
    BillRefused,
    BillSource,
    balance_checks,
    document_check,
    extract_bill,
    find_bill,
    nessie_bill_check,
)
from .clock import Clock, iso, local_today, parse_date
from .engine import EngineError, EngineRouter
from .errors import TendError
from .models import BillAuditRequest, ClaimInput, Context, Item
from .money import assert_integer_cents, format_cents
from .rules import RulesStore, citation
from .scan import load_snapshot, persona_info
from .storage import Repository

HOLD_MESSAGE = "Hold this line. Ask billing to remove it first."


class ClaimError(TendError):
    pass


def check_evidence(items: list[Item], evidence: dict[str, dict[str, Any]]) -> tuple[list[Item], list[dict[str, Any]]]:
    """A claim line must point at a transaction or bill line from the scan, with the same amount and date."""
    kept, refused = [], []
    for item in items:
        record = evidence.get(item.item_id)
        reason = None
        if record is None:
            reason = "No transaction or bill line with this id is in your scan, so Tend will not count it."
        elif record["amount_cents"] != item.amount_cents:
            reason = f"The amount does not match the transaction on record ({format_cents(record['amount_cents'])})."
        elif record["date"] != item.date.isoformat():
            reason = f"The date does not match the transaction on record ({record['date']})."
        if reason:
            refused.append({"item_id": item.item_id, "amount_cents": item.amount_cents, "reason": reason})
        else:
            kept.append(item)
    return kept, refused


def validate_output(output: dict[str, Any], payload: dict[str, Any]) -> None:
    try:
        assert_integer_cents(output)
    except ValueError as exc:
        raise ClaimError(f"engine output broke the integer-cents rule: {exc}", 500) from exc
    lines = output.get("lines")
    if not isinstance(lines, list) or not isinstance(output.get("totals"), dict):
        raise ClaimError("engine output is missing lines or totals", 500)
    known = {i["item_id"] for i in payload["items"]}
    invented = [ln.get("item_id") for ln in lines if ln.get("item_id") not in known]
    if invented:
        raise ClaimError(f"engine output has lines with no input item: {invented[:3]}", 500)


class ClaimService:
    def __init__(self, repo: Repository, rules: RulesStore, engines: EngineRouter, seed_dir: Path, clock: Clock):
        self.repo = repo
        self.rules = rules
        self.engines = engines
        self.seed_dir = seed_dir
        self.clock = clock

    def _require_jurisdiction(self, st: str) -> dict[str, Any]:
        doc = self.rules.get(st)
        if doc is None:
            raise ClaimError(f"No verified rules for {st}.", 404)
        return doc

    def evaluate(self, claim: ClaimInput, scan_id: str | None = None, prefer: str = "auto") -> tuple[dict[str, Any], str]:
        self._require_jurisdiction(claim.jurisdiction)
        scan = None
        items, refused = list(claim.items), []
        if scan_id is not None:
            scan = self.repo.get_scan(scan_id)
            if scan is None:
                raise ClaimError(f"scan {scan_id} not found", 404)
            items, refused = check_evidence(items, self.repo.evidence(scan_id))
        payload = claim.model_copy(update={"items": items}).model_dump(mode="json")
        try:
            output, engine = self.engines.evaluate(payload, prefer)
        except EngineError as exc:
            raise ClaimError(str(exc), 422) from exc
        validate_output(output, payload)
        claim_id = f"clm_{secrets.token_hex(10)}"
        self.repo.save_claim(
            {
                "claim_id": claim_id,
                "jurisdiction": claim.jurisdiction,
                "scan_id": scan_id,
                "persona_id": scan["persona_id"] if scan else None,
                "fictional": bool(scan and scan["fictional"]),
                "display_name": scan["display_name"] if scan else None,
                "engine": engine,
                "input": payload,
                "output": output,
                "refused": refused,
                "created_at": iso(self.clock()),
            }
        )
        response = {**output, "claim_id": claim_id, "refused": refused, "evidence": {"checked": scan_id is not None, "scan_id": scan_id}}
        return response, engine

    def get(self, claim_id: str) -> dict[str, Any]:
        claim = self.repo.get_claim(claim_id)
        if claim is None:
            raise ClaimError(f"claim {claim_id} not found", 404)
        return claim

    def view(self, claim: dict[str, Any]) -> dict[str, Any]:
        """The claim with every line joined to its transaction and the verbatim law behind it."""
        st = claim["jurisdiction"]
        doc = self.rules.get(st) or {}
        rules = self.rules.rules_by_id(st)
        sources = self.rules.sources_by_id(st)

        def cite(ids: list[str]) -> list[dict[str, Any]]:
            return [citation(rules[r], sources) for r in ids if r in rules]

        items = {i["item_id"]: i for i in claim["input"]["items"]}
        output = claim["output"]
        lines = []
        for ln in output.get("lines", []):
            item = items.get(ln["item_id"], {})
            ids = list(ln.get("rule_ids") or [])
            if ln.get("cap_rule_id") and ln["cap_rule_id"] not in ids:
                ids.append(ln["cap_rule_id"])
            lines.append(
                {
                    **ln,
                    "date": item.get("date"),
                    "description": item.get("description", ""),
                    "amount_cents": item.get("amount_cents"),
                    "is_bill": item.get("is_bill", False),
                    "citations": cite(ids),
                }
            )
        checks = {name: {**check, "citations": cite(check.get("rule_ids") or [])} for name, check in (output.get("checks") or {}).items()}
        return {
            "claim_id": claim["claim_id"],
            "jurisdiction": st,
            "name": doc.get("name"),
            "program": doc.get("program", {}),
            "fictional": claim["fictional"],
            "display_name": claim.get("display_name"),
            "engine": claim["engine"],
            "created_at": claim["created_at"],
            "context": claim["input"].get("context", {}),
            "law_image_sha256": output.get("law_image_sha256"),
            "rules_sha256": self.rules.file_sha256(st),
            "totals": output.get("totals", {}),
            "checks": checks,
            "lines": lines,
            "refused": claim.get("refused", []),
            "info": cite(output.get("info_rule_ids") or []),
        }

    def audit_bill(self, req: BillAuditRequest, prefer: str = "auto") -> tuple[dict[str, Any], str]:
        doc = self._require_jurisdiction(req.st)
        snapshot = load_snapshot(self.seed_dir, req.persona_id) if req.persona_id else None
        if req.bill_text is not None:
            source = BillSource(req.bill_text.encode("utf-8"), "text")
        else:
            source = find_bill(self.seed_dir, req.bill_id, req.persona_id, snapshot)
        bill = extract_bill(source.raw, source.format)
        checks = balance_checks(bill)
        if source.document is not None:
            bill.nessie_bill_id = bill.nessie_bill_id or source.document.get("bill_id")
            bill.statement_date = bill.statement_date or source.document.get("statement_date")
            checks.append(document_check(bill, source.document))
            if not checks[-1]["ok"]:
                raise BillRefused("This file is not the bill recorded for this person.", {"checks": checks})
        nessie_check = nessie_bill_check(bill, snapshot)
        if nessie_check is not None:
            checks.append(nessie_check)
            if not nessie_check["ok"]:
                raise BillRefused("The bill does not match the bill on record in the bank.", {"checks": checks})

        persona_context = persona_info(snapshot)["context"] if snapshot else {}
        incident = req.incident_date or parse_date(persona_context.get("incident_date"))
        if incident is None:
            raise ClaimError("incident_date is required to audit a bill.", 422)
        context = Context(
            incident_date=incident,
            as_of_date=req.as_of_date or parse_date(persona_context.get("as_of_date")) or local_today(self.clock()),
            police_report=req.police_report or _police(persona_context.get("police_report")),
            forensic_exam=any(line.expense == "forensic_exam" for line in bill.lines) or persona_context.get("forensic_exam") is True,
        )
        items = [
            Item(
                item_id=line.item_id,
                date=line.date,
                amount_cents=line.amount_cents,
                expense=line.expense,
                confirmed=False,
                is_bill=True,
                description=line.description[:200],
            )
            for line in bill.lines
        ]
        payload = ClaimInput(jurisdiction=req.st, context=context, items=items).model_dump(mode="json")
        try:
            output, engine = self.engines.evaluate(payload, prefer)
        except EngineError as exc:
            raise ClaimError(str(exc), 422) from exc
        validate_output(output, payload)

        rules = self.rules.rules_by_id(req.st)
        sources = self.rules.sources_by_id(req.st)
        by_item = {ln["item_id"]: ln for ln in output["lines"]}
        lines, holds, flags = [], [], []
        for line in bill.lines:
            result = by_item.get(line.item_id, {})
            lines.append(
                {
                    "line_no": line.line_no,
                    "item_id": line.item_id,
                    "date": line.date.isoformat(),
                    "description": line.description,
                    "amount_cents": line.amount_cents,
                    "columns_cents": line.columns_cents,
                    "expense": line.expense,
                    "matched_on": line.match,
                    "status": result.get("status"),
                    "rule_ids": result.get("rule_ids", []),
                }
            )
            if result.get("status") != "held":
                continue
            held_rules = [rules[r] for r in result.get("rule_ids", []) if r in rules]
            holds.append(
                {
                    "item_id": line.item_id,
                    "line_no": line.line_no,
                    "description": line.description,
                    "amount_cents": line.amount_cents,
                    "message": HOLD_MESSAGE,
                    "citations": [citation(r, sources) for r in held_rules],
                    "payers": [
                        r["params"]["payer"]
                        for r in held_rules
                        if r.get("category") == "exam_payment" and (r.get("params") or {}).get("payer")
                    ],
                }
            )
            flag = consent_flag(line.item_id, line.description, doc, sources)
            if flag:
                flags.append(flag)

        held_cents = sum(h["amount_cents"] for h in holds)
        due = bill.due_cents
        scan_id = self._register_bill_evidence(req, bill)
        result = {
            "bill": {
                "bill_id": bill.bill_id or req.bill_id,
                "provider": bill.provider,
                "statement_date": bill.statement_date,
                "fictional": bill.fictional,
                "format": bill.format,
                "sha256": bill.sha256,
                "nessie_bill_id": bill.nessie_bill_id,
                "total_cents": bill.total_cents,
                "amount_due_cents": bill.amount_due_cents,
                "lines_sum_cents": bill.lines_sum_cents,
                "adjustments": bill.adjustments,
            },
            "checks": checks,
            "lines": lines,
            "holds": holds,
            "flags": flags,
            "held_cents": held_cents,
            "payable_cents": max(0, (due or 0) - held_cents),
            # In a claim these lines stand in for the single bank bill they itemize.
            "replaces_item_id": f"nessie:{bill.nessie_bill_id}" if bill.nessie_bill_id else None,
            "engine_items": payload["items"],
            "engine_context": payload["context"],
            "engine_output": output,
            "scan_id": scan_id,
        }
        return result, engine

    def _register_bill_evidence(self, req: BillAuditRequest, bill: Any) -> str:
        evidence = [
            {"item_id": line.item_id, "amount_cents": line.amount_cents, "date": line.date.isoformat(), "source": "bill"}
            for line in bill.lines
        ]
        if req.scan_id is not None:
            if self.repo.get_scan(req.scan_id) is None:
                raise ClaimError(f"scan {req.scan_id} not found", 404)
            self.repo.add_evidence(req.scan_id, evidence)
            return req.scan_id
        scan_id = f"scan_{secrets.token_hex(10)}"
        self.repo.save_scan(
            {
                "scan_id": scan_id,
                "persona_id": req.persona_id,
                "customer_id": None,
                "jurisdiction": req.st,
                "fictional": bill.fictional,
                "display_name": None,
                "created_at": iso(self.clock()),
            },
            evidence,
        )
        return scan_id


def consent_flag(item_id: str, description: str, doc: dict[str, Any], sources: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    """A held exam line that mentions insurance (a deductible, a co-pay) raises the separate consent-to-bill-insurance rule."""
    if not INSURANCE_MENTION.search(description):
        return None
    exam_rules = [
        r
        for r in doc.get("rules", [])
        if r.get("category") == "exam_no_bill" and (r.get("params") or {}).get("insurance_billing") in ("consent_required", "prohibited")
    ]
    consent = [r for r in exam_rules if re.search(r"consent", r.get("quote", ""), re.I)] or exam_rules
    if not consent:
        return None
    mode = consent[0]["params"]["insurance_billing"]
    message = (
        "This line shows insurance was billed for the exam. That needs your express written consent."
        if mode == "consent_required"
        else "This line shows insurance was billed for the exam, which this state does not allow."
    )
    return {
        "item_id": item_id,
        "kind": "insurance_billed_for_exam",
        "message": message,
        "citations": [citation(r, sources) for r in consent],
    }


def _police(value: Any) -> str:
    return value if value in ("yes", "no", "unknown") else "unknown"
