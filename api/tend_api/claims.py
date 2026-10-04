"""Claims, evaluated and returned. Nothing about a claim is stored on the server.

The device runs the same law engine in WebAssembly; this is the server-side fallback (native engine
through ctypes, then the Python reference) and the source of the cited views a packet prints.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .bill import INSURANCE_MENTION, find_bill, service_date, snapshot_documents, verify_bill
from .clock import Clock, parse_date, state_today
from .engine import EngineError, EngineRouter
from .errors import TendError
from .models import BillAuditRequest, ClaimInput, Context, Item
from .money import assert_integer_cents, canonical_json, sha256_hex
from .rules import RulesStore, citation
from .scan import account_ids, list_snapshots, load_snapshot, persona_info

HOLD_MESSAGE = "Don't pay this line. Ask billing to remove it first."


class ClaimError(TendError):
    pass


# SPEC statuses, v1.0 through v1.2.
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


def claim_reference(payload: dict[str, Any]) -> str:
    """A label for a packet, derived from what was claimed. Nothing is looked up by it."""
    return "T-" + sha256_hex(canonical_json(payload))[:12].upper()


class ClaimService:
    def __init__(self, rules: RulesStore, engines: EngineRouter, seed_dir: Path, clock: Clock):
        self.rules = rules
        self.engines = engines
        self.seed_dir = seed_dir
        self.clock = clock

    def _require_jurisdiction(self, st: str) -> dict[str, Any]:
        doc = self.rules.get(st)
        if doc is None:
            raise ClaimError(f"No verified rules for {st}.", 404)
        return doc

    def evaluate(self, claim: ClaimInput, prefer: str = "auto") -> tuple[dict[str, Any], str, dict[str, Any]]:
        """(engine output, which engine ran, the exact payload it read). Kept nowhere."""
        self._require_jurisdiction(claim.jurisdiction)
        payload = claim.model_dump(mode="json")
        try:
            output, engine = self.engines.evaluate(payload, prefer)
        except EngineError as exc:
            raise ClaimError(str(exc), 422) from exc
        validate_output(output, payload)
        return output, engine, payload

    def view(self, payload: dict[str, Any], output: dict[str, Any], engine: str, persona_id: str | None = None) -> dict[str, Any]:
        """The claim with every line joined to its item and the verbatim law behind it (for packets)."""
        st = payload["jurisdiction"]
        doc = self.rules.get(st) or {}
        rules = self.rules.rules_by_id(st)
        sources = self.rules.sources_by_id(st)

        def cite(ids: list[str]) -> list[dict[str, Any]]:
            return [citation(rules[r], sources) for r in ids if r in rules]

        persona = None
        if persona_id:
            try:
                persona = persona_info(load_snapshot(self.seed_dir, persona_id))
            except TendError:
                persona = None
        items = {i["item_id"]: i for i in payload["items"]}
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
        fictional = bool(persona and persona.get("fictional"))
        return {
            "claim_id": claim_reference(payload),
            "jurisdiction": st,
            "name": doc.get("name"),
            "program": doc.get("program", {}),
            "fictional": fictional,
            "display_name": persona.get("display_name") if fictional else None,
            "engine": engine,
            "context": payload.get("context", {}),
            "law_image_sha256": output.get("law_image_sha256"),
            "rules_sha256": self.rules.file_sha256(st),
            "totals": output.get("totals", {}),
            "checks": checks,
            "lines": lines,
            "refused": [],
            "info": cite(output.get("info_rule_ids") or []),
        }

    def audit_bill(self, req: BillAuditRequest, prefer: str = "auto") -> tuple[dict[str, Any], str]:
        """A demo persona's itemized bill: the lines must add up, the file must match the snapshot, and the
        law engine decides which lines are held. Nothing is stored."""
        persona_id = req.persona_id or (self.persona_for_bill(req.bill_id) if req.bill_id else None)
        snapshot = load_snapshot(self.seed_dir, persona_id) if persona_id else None
        info = persona_info(snapshot) if snapshot else {"context": {}, "jurisdiction": None}
        st = req.st or info.get("jurisdiction")
        if not st:
            raise ClaimError("st is required when the bill is not tied to a persona.", 422)
        doc = self._require_jurisdiction(st)
        source = find_bill(self.seed_dir, req.bill_id, persona_id, snapshot)
        bill, checks = verify_bill(source, snapshot)

        persona_context = info["context"]
        incident = req.incident_date or parse_date(persona_context.get("incident_date"))
        if incident is None:
            raise ClaimError("incident_date is required to audit a bill.", 422)
        context = Context(
            incident_date=incident,
            as_of_date=req.as_of_date or parse_date(persona_context.get("as_of_date")) or state_today(self.clock(), st),
            police_report=req.police_report or _police(persona_context.get("police_report")),
            forensic_exam=any(line.expense == "forensic_exam" for line in bill.lines) or persona_context.get("forensic_exam") is True,
        )
        items = [
            Item(
                item_id=line.item_id,
                date=line.date,
                amount_cents=line.amount_cents,
                expense=line.expense,
                confirmed=True,  # lines of the provider's own itemized statement
                is_bill=True,
                unit="session" if line.expense == "counseling" else None,
                units=1 if line.expense == "counseling" else 0,
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
        result = {
            # The shape the web reads first, then the proof behind it.
            "bill_id": req.bill_id or bill.nessie_bill_id or bill.bill_id,
            "persona_id": persona_id,
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
            "payable_item_ids": [ln["item_id"] for ln in lines if ln["status"] != "held"],
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
        }
        return result, engine

    def persona_for_bill(self, bill_id: str) -> str | None:
        """The demo persona whose snapshot records an itemized document for this Nessie bill."""
        for persona_id, snap in list_snapshots(self.seed_dir):
            if any(d.get("bill_id") == bill_id for d in snapshot_documents(snap)):
                return persona_id
        return None

    def bill_review(self, bill_id: str) -> dict[str, Any] | None:
        """What a payment needs to know about a bill Tend has read: each line with the engine's status,
        and the accounts that may pay it. Recomputed on every call; nothing is kept."""
        persona_id = self.persona_for_bill(bill_id)
        if persona_id is None:
            return None
        audit, _ = self.audit_bill(BillAuditRequest(persona_id=persona_id, bill_id=bill_id))
        snapshot = load_snapshot(self.seed_dir, persona_id)
        bank_bill = next((b for b in snapshot.get("bills") or [] if bill_id in (b.get("id"), b.get("_id"))), {})
        st = (audit.get("engine_output") or {}).get("jurisdiction")
        rules = self.rules.rules_by_id(st) if st else {}
        held_rules = {r for ln in audit["lines"] if ln["status"] == "held" for r in ln.get("rule_ids") or []}
        return {
            "bill_id": bill_id,
            "persona_id": persona_id,
            "accounts": account_ids(snapshot),
            "payee": audit["provider"],
            "lines": [
                {
                    "item_id": ln["item_id"],
                    "amount_cents": ln["amount_cents"],
                    "status": ln["status"],
                    "line_no": ln.get("line_no"),
                    "rule_ids": ln.get("rule_ids") or [],
                }
                for ln in audit["lines"]
            ],
            "payable_cents": audit["payable_cents"],
            # For tying a payment to the bank's own bill record (tend_api.payments).
            "total_cents": audit["total_cents"],
            "account_id": bank_bill.get("account_id"),
            "nickname": bank_bill.get("nickname"),
            "pinpoints": {r: rules[r].get("pinpoint") for r in sorted(held_rules) if r in rules and rules[r].get("pinpoint")},
        }

    def bills_for_account(self, account_id: str) -> list[dict[str, Any]]:
        """The demo bills on one account that Tend can itemize, so a plain payment of exactly what one of them
        has left to pay can be tied to it. Read from the persona snapshots; nothing is looked up live."""
        found = []
        for persona_id, snap in list_snapshots(self.seed_dir):
            itemized = {d.get("bill_id") for d in snapshot_documents(snap) if d.get("bill_id")}
            for bill in snap.get("bills") or []:
                bill_id = bill.get("id") or bill.get("_id")
                if bill_id in itemized and bill.get("account_id") == account_id and bill.get("status") != "cancelled":
                    found.append({"bill_id": bill_id, "payee": bill.get("payee") or "", "persona_id": persona_id})
        return found


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
