from __future__ import annotations

import re
import secrets
from pathlib import Path
from typing import Any

from .bill import INSURANCE_MENTION, BillSource, find_bill, service_date, verify_bill
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


# SPEC statuses, v1.0 and v1.1 together.
LINE_STATUSES = {"out_of_window", "held", "excluded", "unknown_rule", "needs_confirmation", "eligible"}
CHECK_STATUSES = {
    "deadline": {"ok", "late", "unknown"},
    "minimum_loss": {"met", "not_met", "waived", "may_be_waived", "unknown"},
    "reporting": {"satisfied", "required", "not_required", "unknown"},
}


def validate_output(output: dict[str, Any], payload: dict[str, Any]) -> None:
    """Check the engine's arithmetic before anyone sees a dollar of it: one line per item, totals that add up."""
    try:
        assert_integer_cents(output)
    except ValueError as exc:
        raise ClaimError(f"engine output broke the integer-cents rule: {exc}", 500) from exc
    lines = output.get("lines")
    totals = output.get("totals")
    if not isinstance(lines, list) or not isinstance(totals, dict) or not all(isinstance(ln, dict) for ln in lines):
        raise ClaimError("engine output is missing lines or totals", 500)
    items = {i["item_id"]: i for i in payload["items"]}
    invented = [ln.get("item_id") for ln in lines if ln.get("item_id") not in items]
    if invented:
        raise ClaimError(f"engine output has lines with no input item: {invented[:3]}", 500)
    ids = [ln["item_id"] for ln in lines]
    if len(ids) != len(set(ids)) or set(ids) != set(items):
        raise ClaimError("engine output does not have exactly one line per input item", 500)

    problems = []
    for ln in lines:
        status, requested, allowed = ln.get("status"), ln.get("requested_cents"), ln.get("allowed_cents")
        if status not in LINE_STATUSES:
            problems.append(f"{ln['item_id']}: unknown status {status!r}")
        elif requested != items[ln["item_id"]]["amount_cents"]:
            problems.append(f"{ln['item_id']}: requested {requested} is not the item amount")
        elif not isinstance(allowed, int) or not 0 <= allowed <= requested:
            problems.append(f"{ln['item_id']}: allowed {allowed} is outside 0 to requested")
        elif status != "eligible" and allowed != 0:
            problems.append(f"{ln['item_id']}: a {status} line allows {allowed}")
    eligible = [ln for ln in lines if ln.get("status") == "eligible"]
    allowed_sum = sum(ln.get("allowed_cents") or 0 for ln in eligible)
    held_sum = sum(ln.get("requested_cents") or 0 for ln in lines if ln.get("status") == "held")
    if totals.get("allowed_cents") != allowed_sum:
        problems.append(f"totals.allowed_cents {totals.get('allowed_cents')} is not the sum of the lines ({allowed_sum})")
    if totals.get("held_cents") != held_sum:
        problems.append(f"totals.held_cents {totals.get('held_cents')} is not the sum of the held lines ({held_sum})")
    by_expense = totals.get("by_expense")
    if isinstance(by_expense, dict) and sum(by_expense.values()) != allowed_sum:
        problems.append("totals.by_expense does not add up to totals.allowed_cents")
    for name, statuses in CHECK_STATUSES.items():
        check = (output.get("checks") or {}).get(name)
        if check is not None and check.get("status") not in statuses:
            problems.append(f"checks.{name} has unknown status {check.get('status')!r}")
    if problems:
        raise ClaimError(f"engine output failed its own arithmetic, so Tend will not show it: {'; '.join(problems[:3])}", 500)


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

    def run(self, claim: ClaimInput, scan_id: str | None = None, prefer: str = "auto", store: bool = True) -> dict[str, Any]:
        """Evaluate a claim into a record; store=False keeps nothing on the server."""
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
        record = {
            "claim_id": f"clm_{secrets.token_hex(10)}",
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
        if store:
            self.repo.save_claim(record)
        return record

    def evaluate(self, claim: ClaimInput, scan_id: str | None = None, prefer: str = "auto") -> tuple[dict[str, Any], str]:
        record = self.run(claim, scan_id, prefer)
        response = {
            **record["output"],
            "claim_id": record["claim_id"],
            "refused": record["refused"],
            "evidence": {"checked": scan_id is not None, "scan_id": scan_id},
        }
        return response, record["engine"]

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
            for extra in [ln.get("cap_rule_id"), *(ln.get("alt_cap_rule_ids") or [])]:
                if extra and extra not in ids:
                    ids.append(extra)
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
        snapshot = load_snapshot(self.seed_dir, req.persona_id) if req.persona_id else None
        info = persona_info(snapshot) if snapshot else {"context": {}, "jurisdiction": None}
        st = req.st or info.get("jurisdiction")
        if not st:
            raise ClaimError("st is required when the bill is not tied to a persona.", 422)
        doc = self._require_jurisdiction(st)
        if req.bill_text is not None:
            source = BillSource(req.bill_text.encode("utf-8"), "text")
        else:
            source = find_bill(self.seed_dir, req.bill_id, req.persona_id, snapshot)
        bill, checks = verify_bill(source, snapshot)

        persona_context = info["context"]
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
                confirmed=True,  # lines of the provider's own statement, as in the scan
                is_bill=True,
                description=line.description[:200],
            )
            for line in bill.lines
        ]
        payload = ClaimInput(jurisdiction=st, context=context, items=items).model_dump(mode="json")
        try:
            output, engine = self.engines.evaluate(payload, prefer)
        except EngineError as exc:
            raise ClaimError(str(exc), 422) from exc
        validate_output(output, payload)

        rules = self.rules.rules_by_id(st)
        sources = self.rules.sources_by_id(st)
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
                    "rule_ids": result.get("rule_ids", []),
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
        scan_id = self._register_bill_evidence(req, st, bill, [h["item_id"] for h in holds])
        result = {
            # The shape the web reads first, then the proof behind it.
            "bill_id": req.bill_id or bill.nessie_bill_id or bill.bill_id,
            "provider": bill.provider,
            "statement_date": bill.statement_date,
            "service_date": service_date(bill, source.document),
            "account_ref": bill.account_ref,
            "total_cents": bill.due_cents,
            "lines_sum_cents": bill.lines_sum_cents,
            "lines": lines,
            "holds": holds,
            "held_cents": held_cents,
            "payable_cents": max(0, (bill.due_cents or 0) - held_cents),
            "flags": flags,
            "checks": checks,
            "statement_id": bill.bill_id,
            "nessie_bill_id": bill.nessie_bill_id,
            "fictional": bill.fictional,
            "format": bill.format,
            "sha256": bill.sha256,
            "amount_due_cents": bill.amount_due_cents,
            "adjustments": bill.adjustments,
            # In a claim these lines stand in for the single bank bill they itemize.
            "replaces_item_id": f"nessie:{bill.nessie_bill_id}" if bill.nessie_bill_id else None,
            "engine_items": payload["items"],
            "engine_context": payload["context"],
            "engine_output": output,
            "scan_id": scan_id,
        }
        return result, engine

    def _register_bill_evidence(self, req: BillAuditRequest, st: str, bill: Any, held: list[str]) -> str:
        evidence = [
            {"item_id": line.item_id, "amount_cents": line.amount_cents, "date": line.date.isoformat(), "source": "bill"}
            for line in bill.lines
        ]
        if req.scan_id is not None:
            if self.repo.get_scan(req.scan_id) is None:
                raise ClaimError(f"scan {req.scan_id} not found", 404)
            scan_id = req.scan_id
            self.repo.add_evidence(scan_id, evidence)
        else:
            scan_id = f"scan_{secrets.token_hex(10)}"
            self.repo.save_scan(
                {
                    "scan_id": scan_id,
                    "persona_id": req.persona_id,
                    "customer_id": None,
                    "jurisdiction": st,
                    "fictional": bill.fictional,
                    "display_name": None,
                    "created_at": iso(self.clock()),
                },
                evidence,
            )
        # Payments check this, so a line is paid only after the law ran on it and never when it is held.
        self.repo.mark_checked(scan_id, [line.item_id for line in bill.lines], held)
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
