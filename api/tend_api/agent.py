"""What the Fetch.ai agent (an advocate's tool in ASI:One) can ask of Tend.

answer: a cited answer about one state's program, or a refusal when no verified rule supports one.
check: the Check summary for a state and four optional inputs, every sentence with its rule.
pay and confirm: a payment the survivor approves by typing the amount back. Nothing is stored
except the ten-minute proposal and, once confirmed, the payment's row in the audit log.
"""

from __future__ import annotations

import datetime as dt
import re
from typing import Any

from .actions import ActionService
from .clock import Clock, local_today
from .engine import EngineError, EngineRouter, EngineUnavailable, LawIR
from .errors import TendError
from .models import AgentCheckRequest, AgentConfirmRequest, AgentPayRequest, ConfirmRequest, ProposeRequest
from .money import format_cents, parse_cents
from .rulebook import Rulebook
from .rules import RulesStore, citation, rule_expense
from .scan import ScanService

CONFIRM_PHRASE = re.compile(r"^\s*confirm\s+\$?(?P<amount>\d[\d,]*(?:\.\d{2})?)\s*$", re.I | re.A)
NOTE = "Rules can have exceptions. The program decides."

LABELS = {
    "medical": "Medical care",
    "forensic_exam": "Forensic exam",
    "counseling": "Counseling",
    "prescription": "Prescriptions",
    "dental": "Dental care",
    "transportation": "Rides and travel to care",
    "lost_wages": "Lost pay",
    "relocation": "Moving",
    "temporary_housing": "Short-term housing",
    "security": "Locks and home security",
    "childcare": "Child care",
    "clothing_bedding": "Clothing and bedding",
    "property_replacement": "Replacing property",
    "crime_scene_cleanup": "Cleanup",
    "funeral": "Funeral costs",
    "legal": "Legal help",
    "tuition": "Tuition",
    "other": "Other costs",
}
UNIT_WORDS = {
    "session": "a session",
    "week": "a week",
    "hour": "an hour",
    "mile": "a mile",
    "day": "a day",
    "month": "a month",
    "item": "an item",
}
ALTERNATIVES = {
    "forensic_exam": "a forensic exam",
    "protective_order": "a protective order",
    "advocate": "talking with a victim advocate",
    "medical_provider": "a report to a medical provider",
    "other": "other proof the program accepts",
}


class AgentError(TendError):
    pass


def confirm_phrase(amount_cents: int) -> str:
    return f"confirm {format_cents(amount_cents)[1:]}"


def typed_cents(typed: str) -> int | None:
    m = CONFIRM_PHRASE.match(typed)
    if m is None:
        return None
    try:
        return parse_cents(m.group("amount"))
    except ValueError:  # "confirm 1,1" and other malformed amounts approve nothing
        return None


def money(cents: int) -> str:
    text = format_cents(cents)
    return text[:-3] if text.endswith(".00") else text


def long_date(day: str) -> str:
    d = dt.date.fromisoformat(day)
    return f"{d:%B} {d.day}, {d.year}"


def span(days: int) -> str:
    if days >= 365:
        years = round(days / 365.25)
        return f"{years} year{'s' if years != 1 else ''}"
    if days >= 60:
        months = round(days / 30)
        return f"{months} months"
    return f"{days} days"


def join_words(words: list[str]) -> str:
    if len(words) <= 2:
        return " or ".join(words)
    return ", ".join(words[:-1]) + f", or {words[-1]}"


UNIT_PERS = frozenset(UNIT_WORDS)
DEADLINE_FROM = frozenset({"crime", "incident", "discovery", "injury", "offense", "report"})


def ir_from_verified(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """The few IR fields the Check summary reads, taken straight from verified params. Used only when the
    IR is missing or older than the verified file; the summary then says law_ir: false."""
    out: list[dict[str, Any]] = []
    for r in doc.get("rules") or []:
        p, cat, expense = r.get("params") or {}, r.get("category"), rule_expense(r)
        cents = p.get("amount_cents") if isinstance(p.get("amount_cents"), int) else None
        if cat == "covered_expense" and expense:
            out.append({"id": r["id"], "kind": "covered", "expense": expense})
        elif cat == "expense_cap" and expense and cents:
            unit = p.get("per") if p.get("per") in UNIT_PERS else None
            out.append(
                {
                    "id": r["id"],
                    "kind": "expense_cap",
                    "expense": expense,
                    "cap_cents": cents,
                    "per": "unit" if unit else "claim",
                    "unit": unit,
                    "count_limit": p.get("count_limit"),
                }
            )
        elif cat == "total_cap" and cents:
            out.append({"id": r["id"], "kind": "total_cap", "cap_cents": cents})
        elif cat == "filing_deadline" and p.get("from", "crime") in DEADLINE_FROM and (p.get("days") or p.get("years")):
            days = int(p["days"]) if p.get("days") else int(p["years"]) * 365 + int(p["years"]) // 4
            out.append({"id": r["id"], "kind": "deadline", "days": days, "from": p.get("from", "crime")})
        elif cat == "reporting_requirement":
            out.append(
                {"id": r["id"], "kind": "reporting", "required": bool(p.get("required")), "alternatives": list(p.get("alternatives") or [])}
            )
        elif cat == "minimum_loss":
            sa = re.search(r"sexual|forensic", str(p.get("waived_for") or ""), re.I) is not None
            out.append(
                {
                    "id": r["id"],
                    "kind": "minimum_loss",
                    "cap_cents": cents,
                    "days_lost": p.get("days_lost"),
                    "waiver": "discretionary" if sa else "none",
                    "waiver_for_sexual_assault": sa,
                }
            )
        elif cat == "excluded_expense" and expense and not p.get("item"):
            out.append({"id": r["id"], "kind": "excluded", "expense": expense})
    return out


class AgentService:
    def __init__(
        self,
        rules: RulesStore,
        ir: LawIR,
        engines: EngineRouter,
        rulebook: Rulebook,
        actions: ActionService,
        scans: ScanService,
        clock: Clock,
    ):
        self.rules = rules
        self.ir = ir
        self.engines = engines
        self.rulebook = rulebook
        self.actions = actions
        self.scans = scans
        self.clock = clock

    # answers

    def answer(self, question: str, st: str | None) -> dict[str, Any]:
        return self.rulebook.answer(question, st)

    # the Check summary

    def _engine_checks(self, st: str, incident_date: dt.date, exam: bool, police: str) -> tuple[dict[str, Any], str | None]:
        payload = {
            "jurisdiction": st,
            "context": {
                "incident_date": incident_date.isoformat(),
                "as_of_date": local_today(self.clock()).isoformat(),
                "police_report": police,
                "forensic_exam": exam,
            },
            "items": [],
        }
        try:
            output, engine = self.engines.evaluate(payload)
        except (EngineUnavailable, EngineError):
            return {}, None
        return output.get("checks") or {}, engine

    def check(self, req: AgentCheckRequest) -> dict[str, Any]:
        st = req.st
        doc = self.rules.get(st)
        if doc is None:
            raise AgentError(f"No verified rules for {st}.", 404)
        name = doc.get("name") or st
        place = f"the {name}" if name.startswith("District of") else name  # "apply in the District of Columbia"
        opening = place[0].upper() + place[1:]  # the same words at the start of a sentence
        by_id = self.rules.rules_by_id(st)
        sources = self.rules.sources_by_id(st)
        try:
            ir = self.ir.load(st) or {}
        except EngineUnavailable:
            ir = {}
        law_ir = bool(ir.get("rules"))
        ir_rules = ir.get("rules") if law_ir else ir_from_verified(doc)

        def cite(ids: list[str]) -> list[dict[str, Any]]:
            out = []
            for rid in dict.fromkeys(ids):
                if rid in by_id:
                    c = citation(by_id[rid], sources)
                    out.append({k: c.get(k) for k in ("rule_id", "pinpoint", "quote", "fragment_url", "source_title", "source_url")})
            return out

        def sentence(text: str, ids: list[str], **extra: Any) -> dict[str, Any]:
            return {"text": text, "rule_ids": list(dict.fromkeys(ids)), "citations": cite(ids), **extra}

        def of_category(*categories: str) -> list[dict[str, Any]]:
            return [r for r in doc.get("rules") or [] if r.get("category") in categories]

        police = {"yes": "yes", "no": "no", "not_yet": "no", "unknown": "unknown"}[req.police_report]
        checks, engine = ({}, None)
        if req.incident_date:
            checks, engine = self._engine_checks(st, req.incident_date, bool(req.forensic_exam), police)

        # deadline
        deadline_ids = [r["id"] for r in ir_rules if r.get("kind") == "deadline"] or [r["id"] for r in of_category("filing_deadline")]
        found = checks.get("deadline") or {}
        flags = list(found.get("flags") or [])
        if found.get("status") == "ok" and found.get("deadline_date"):
            text = f"Apply by {long_date(found['deadline_date'])}."
            if "deadline_from_report" in flags:
                text += " That date is measured from the day it happened. The law counts from your report, so you may have longer."
            deadline = sentence(text, found.get("rule_ids") or deadline_ids, status="ok", deadline_date=found["deadline_date"], flags=flags)
        elif found.get("status") == "late":
            deadline = sentence(
                f"The usual deadline was {long_date(found['deadline_date'])}. Ask the program about exceptions.",
                found.get("rule_ids") or deadline_ids,
                status="late",
                deadline_date=found.get("deadline_date"),
                flags=flags,
            )
        else:
            days = max((r.get("days") or 0 for r in ir_rules if r.get("kind") == "deadline"), default=0)
            text = (
                f"You have about {span(days)} from the date it happened to apply."
                if days
                else f"Tend found no set filing deadline in {place}'s rules. Ask the program."
            )
            deadline = sentence(text, deadline_ids, status="unknown", deadline_date=None, flags=flags)

        # police report
        reporting_rules = [r for r in ir_rules if r.get("kind") == "reporting"]
        alternatives = sorted({a for r in reporting_rules for a in r.get("alternatives") or []})
        report_ids = [r["id"] for r in reporting_rules] or [r["id"] for r in of_category("reporting_requirement")]

        def reporting_sentence(found_check: dict[str, Any], exam: bool) -> dict[str, Any]:
            status = found_check.get("status", "unknown")
            ids = found_check.get("rule_ids") or report_ids
            if status == "satisfied":
                text = (
                    "Your police report meets this rule." if police == "yes" else "Your forensic exam counts in place of a police report."
                )
            elif status == "required":
                text = f"{opening} asks for a police report."
                if alternatives:
                    text += f" These can count instead: {join_words([ALTERNATIVES.get(a, a) for a in alternatives])}."
            elif status == "not_required":
                text = f"{opening} does not require a police report."
            else:
                text = "Ask the program whether you need a police report."
            return sentence(text, ids, status=status, alternatives=alternatives, assumes_exam=exam)

        reporting = reporting_sentence(checks.get("reporting") or {}, bool(req.forensic_exam))
        if req.incident_date and req.forensic_exam is None:
            other, _ = self._engine_checks(st, req.incident_date, True, police)
            reporting_if_exam = reporting_sentence(other.get("reporting") or {}, True)
        else:
            reporting_if_exam = None

        # what is covered, with caps
        covered: dict[str, dict[str, Any]] = {}
        for r in ir_rules:
            expense = r.get("expense")
            if r.get("kind") in ("covered", "expense_cap") and expense:
                entry = covered.setdefault(expense, {"expense": expense, "label": LABELS.get(expense, expense), "ids": [], "caps": []})
                entry["ids"].append(r["id"])
                if r.get("kind") == "expense_cap":
                    entry["caps"].append(r)
                    entry["ids"] += r.get("alt_rule_ids") or []
        covered_list = []
        for expense in [e for e in LABELS if e in covered]:
            entry = covered[expense]
            cap_text, cap_cents = None, None
            if entry["caps"]:
                cap = max(entry["caps"], key=lambda c: c.get("cap_cents") or 0)
                cap_cents = cap.get("cap_cents")
                if cap.get("per") == "unit" and cap.get("unit"):
                    cap_text = f"up to {money(cap_cents)} {UNIT_WORDS.get(cap['unit'], 'each')}"
                    if cap.get("count_limit"):
                        count = int(cap["count_limit"])
                        cap_text += f" for up to {count} {cap['unit']}{'s' if count != 1 else ''}"
                elif cap_cents:
                    cap_text = f"up to {money(cap_cents)}"
            text = f"{entry['label']}, {cap_text}" if cap_text else entry["label"]
            covered_list.append(sentence(text, entry["ids"], expense=expense, label=entry["label"], cap_cents=cap_cents))

        totals = [r for r in ir_rules if r.get("kind") == "total_cap" and r.get("cap_cents")]
        total = min(totals, key=lambda r: r["cap_cents"]) if totals else None
        total_cap = sentence(f"Up to {money(total['cap_cents'])} in all.", [total["id"]], cap_cents=total["cap_cents"]) if total else None

        minimum = None
        for r in ir_rules:
            if r.get("kind") != "minimum_loss":
                continue
            cents = r.get("cap_cents")
            if cents == 0:
                text = "There is no minimum amount of costs."
            elif cents:
                text = f"The program asks for at least {money(cents)} in costs"
                if r.get("days_lost"):
                    text += f" or {r['days_lost']} days of missed work"
                text += "."
                if r.get("waiver_for_sexual_assault") and r.get("waiver") == "automatic":
                    text = text[:-1] + ", but this does not apply to sexual assault survivors."
                elif r.get("waiver_for_sexual_assault"):
                    text += " It can be waived for sexual assault survivors."
            else:
                continue
            minimum = sentence(text, [r["id"]])
            break

        exam_rules = of_category("exam_no_bill")
        payers = of_category("exam_payment")
        exam = sentence(exam_rules[0].get("summary") or "", [r["id"] for r in exam_rules + payers]) if exam_rules else None
        excluded_ids = {i["id"] for i in ir_rules if i.get("kind") == "excluded"}
        # Without the IR, an exclusion that names only an item (a phone, a purse) is still worth showing.
        not_covered = [
            sentence(r.get("summary") or "", [r["id"]]) for r in of_category("excluded_expense") if r["id"] in excluded_ids or not law_ir
        ]
        privacy = [
            sentence(r.get("summary") or "", [r["id"]], category=r["category"])
            for r in of_category("address_confidentiality", "record_confidentiality")
        ]

        eligible = [r["id"] for r in of_category("eligible_crime")]
        if deadline["status"] == "late":
            headline = sentence(f"The usual deadline in {place} may have passed. Ask the program about exceptions.", deadline["rule_ids"])
        else:
            headline = sentence(f"You can likely apply in {place}.", eligible)

        program = doc.get("program") or {}
        phone_source = sources.get(program.get("phone_source_id") or "")
        return {
            "st": st,
            "name": name,
            "inputs": {
                "incident_date": req.incident_date.isoformat() if req.incident_date else None,
                "forensic_exam": req.forensic_exam,
                "police_report": req.police_report,
            },
            "headline": headline,
            "deadline": deadline,
            "reporting": reporting,
            "reporting_if_exam": reporting_if_exam,
            "covered": covered_list,
            "total_cap": total_cap,
            "minimum_loss": minimum,
            "exam": exam,
            "not_covered": not_covered,
            "privacy": privacy,
            "program": {
                "program_name": program.get("program_name"),
                "agency": program.get("agency"),
                "phone": program.get("phone"),
                "website": program.get("website"),
                "apply_url": program.get("apply_url"),
                "source": {k: phone_source.get(k) for k in ("id", "title", "url", "sha256")} if phone_source else None,
            },
            "engine": engine,
            "law_ir": law_ir,
            "note": NOTE,
        }

    # payments the survivor approves by typing the amount

    def pay(self, req: AgentPayRequest) -> dict[str, Any]:
        if req.persona_id:
            account = self.scans.persona_account(req.persona_id, req.account)["id"]
        else:
            account = req.from_account or ""
        proposal = self.actions.propose(
            ProposeRequest(
                from_account=account,
                payee=req.payee,
                amount_cents=req.amount_cents,
                kind="pay_bill" if req.bill_id else None,
                bill_id=req.bill_id,
                item_ids=req.item_ids,
            ),
            channel="agent",
        )
        phrase = confirm_phrase(req.amount_cents)
        return {
            **proposal,
            "confirm_phrase": phrase,
            "ask_user": f'Pay {format_cents(req.amount_cents)} to {req.payee}? Nothing moves until you type "{phrase}".',
        }

    def confirm(self, req: AgentConfirmRequest) -> dict[str, Any]:
        action = self.actions.repo.get_action(req.action_id)
        if action is None or action["channel"] != "agent":
            raise AgentError("No agent payment with that id.", 404)
        if typed_cents(req.typed) != action["amount_cents"]:
            raise AgentError(f'Nothing was paid. To approve, type exactly: "{confirm_phrase(action["amount_cents"])}"', 409)
        return self.actions.confirm(ConfirmRequest(action_id=req.action_id, confirm_code=req.confirm_code), channel="agent")
