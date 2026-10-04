"""The Bank+Packet agent's work: the fictional demo claim, end to end, through the Tend API.

1. Scan the demo bank (Capital One's Nessie mock bank, a fictional persona) and read the itemized hospital bill.
2. Count the claim with the law engine, hold the forensic exam line the law says was never billable, and write the
   letter to the billing office that quotes that law.
3. Propose paying the rest of the bill. The API issues a 6-digit code; nothing moves until the person types it back
   and this agent sends exactly what they typed to the API, which checks it.
4. Seal the packet for an advocate: encrypted here with a fresh key, so Tend's server stores only ciphertext and
   the key travels in the link alone.

Each request is answered from fresh API reads, so the agent keeps no claim, bill, or merchant text between messages.
"""

from __future__ import annotations

import datetime as dt
import secrets
from typing import Any

from .api import ApiError, TendApi
from .demo import (
    FICTIONAL,
    confirmed_input,
    demo_ref,
    groups,
    held_lines,
    payment_body,
    payment_view,
    persona_for,
    render_claim,
    render_paid,
    render_scan,
)
from .desks import Idempotent, failure
from .fmt import cite_link, long_date, money, plural
from .knowledge import RuleBook, cite
from .letter import billing_letter
from .messages import (
    CostGroup,
    DemoCountReply,
    DemoCountRequest,
    DemoRef,
    DemoStartReply,
    DemoStartRequest,
    PacketShareReply,
    PacketShareRequest,
    PayConfirmRequest,
    PayProposeReply,
    PayProposeRequest,
    PayResultReply,
    PayStatusRequest,
)
from .packet import METHOD_LABEL, filing_routes, still_needed
from .settings import Settings
from .share import seal, share_link
from .states import state_name

CONFIRM_OUTCOMES = {403: "wrong_code", 410: "expired", 423: "locked", 404: "not_found"}
STATUS_OUTCOMES = {
    "proposed": "waiting",
    "executing": "in_progress",
    "done": "done",
    "unverified": "unverified",
    "failed": "bank_error",
    "expired": "expired",
    "locked": "locked",
}
SHOWN_DOCUMENTS = 5


def _utc_now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


class BankDesk:
    name = "bank"

    def __init__(self, api: TendApi, settings: Settings, *, now: Any = _utc_now, rand: Any = secrets.token_bytes):
        self.api = api
        self.settings = settings
        self._now = now
        self._rand = rand
        self._once = Idempotent()

    async def handle(self, req: Any) -> Any:
        return await self._once.run(req.request_id, lambda: self._handle(req))

    async def _handle(self, req: Any) -> Any:
        routes = {
            DemoStartRequest: (self._start, DemoStartReply),
            DemoCountRequest: (self._count, DemoCountReply),
            PayProposeRequest: (self._propose, PayProposeReply),
            PayConfirmRequest: (self._confirm, PayResultReply),
            PayStatusRequest: (self._status, PayResultReply),
            PacketShareRequest: (self._share, PacketShareReply),
        }
        route = routes.get(type(req))
        if route is None:
            raise TypeError(f"the Bank agent does not take {type(req).__name__}")
        work, reply = route
        try:
            return await work(req)
        except ApiError as exc:
            return reply(request_id=req.request_id, ok=False, **failure(exc))

    # ------------------------------------------------------------ reading the demo

    async def _book(self, st: str) -> RuleBook:
        try:
            return RuleBook(await self.api.jurisdiction(st))
        except ApiError:
            return RuleBook({"jurisdiction": st, "name": state_name(st)})

    async def _scan_and_audit(self, persona_id: str, st: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
        scan = await self.api.scan(persona_id, st)
        bill_id = next((d.get("bill_id") for d in scan.get("documents") or [] if d.get("bill_id")), None)
        audit = None
        if bill_id:
            try:
                audit = await self.api.audit_bill(bill_id, persona_id, scan["scan_id"])
            except ApiError as exc:
                if exc.status == 0:
                    raise
        return scan, audit

    async def _start(self, req: DemoStartRequest) -> DemoStartReply:
        persona, st = persona_for(req.st, self.settings.demo_persona)
        scan, audit = await self._scan_and_audit(persona, st)
        return DemoStartReply(
            request_id=req.request_id,
            text=render_scan(scan, audit, state_name(st)),
            demo=DemoRef(**demo_ref(scan, audit, persona)),
            groups=[CostGroup(**g) for g in groups(scan)],
        )

    async def _count(self, req: DemoCountRequest) -> DemoCountReply:
        demo = req.demo
        scan, audit = await self._scan_and_audit(demo.persona_id, demo.st)
        claim = await self.api.claim(confirmed_input(scan, audit), scan["scan_id"])
        book = await self._book(demo.st)
        held = held_lines(audit)
        totals = claim.get("totals") or {}
        return DemoCountReply(
            request_id=req.request_id,
            text=render_claim(claim, book, demo.model_dump(), demo.who),
            letter=billing_letter(book, held) if held else "",
            allowed_cents=int(totals.get("allowed_cents") or 0),
            held_cents=int(totals.get("held_cents") or 0),
            deadline_date=((claim.get("checks") or {}).get("deadline") or {}).get("deadline_date"),
        )

    # ------------------------------------------------------------ paying the rest of the bill

    async def _propose(self, req: PayProposeRequest) -> PayProposeReply:
        demo = req.demo.model_dump()
        if not demo.get("payable_cents") or not demo.get("bill_id"):
            return PayProposeReply(
                request_id=req.request_id, ok=False, error="nothing_to_pay", text="There is nothing left to pay on the demo bill."
            )
        proposal = await self.api.propose(payment_body(demo))
        view = payment_view(proposal, demo)
        return PayProposeReply(
            request_id=req.request_id,
            action_id=view["action_id"],
            amount_cents=view["amount_cents"],
            confirm_code=view["code"],
            expires_at=proposal.get("expires_at"),
            payee_label=view["payee_label"],
            from_label=view["from_label"],
            lines_label=view["lines_label"],
            held_cents=view["held_cents"],
            dry_run=bool(proposal.get("dry_run")),
        )

    async def _confirm(self, req: PayConfirmRequest) -> PayResultReply:
        try:
            result = await self.api.confirm(req.action_id, req.confirm_code)
        except ApiError as exc:
            if exc.status == 409:  # already finished: say what happened, so a retried confirm never looks like a failure
                return await self._status(PayStatusRequest(request_id=req.request_id, action_id=req.action_id, demo=req.demo))
            if exc.status in CONFIRM_OUTCOMES:
                return PayResultReply(request_id=req.request_id, outcome=CONFIRM_OUTCOMES[exc.status], text=exc.message, status=exc.status)
            if exc.status == 502:  # the bank refused (nothing moved) or did not answer (it may have moved): ask the API which
                status = await self._status(PayStatusRequest(request_id=req.request_id, action_id=req.action_id, demo=req.demo))
                if status.outcome == "bank_error":
                    return PayResultReply(request_id=req.request_id, outcome="bank_error", text=exc.message, status=502)
                return status
            if exc.status == 0 or exc.status >= 500:
                # The code may have reached the API, or the API failed partway through: never call it failed.
                return PayResultReply(request_id=req.request_id, outcome="unknown", text=exc.message, status=exc.status)
            raise
        book = await self._book(req.demo.st)
        return PayResultReply(
            request_id=req.request_id,
            outcome="done" if result.get("read_back_matches") else "unverified",
            text=render_paid(result, req.demo.model_dump(), book),
            amount_cents=int(result.get("amount_cents") or 0),
            audit_id=result.get("audit_id"),
            bank_record=result.get("nessie_id"),
        )

    async def _status(self, req: PayStatusRequest) -> PayResultReply:
        action = await self.api.action(req.action_id)
        outcome = STATUS_OUTCOMES.get(str(action.get("status")), "waiting")
        amount = int(action.get("amount_cents") or 0)
        rows = action.get("audit") or []
        audit_id = f"aud_{int(rows[-1]['seq']):06d}" if rows and isinstance(rows[-1].get("seq"), int) else None
        text = ""
        if outcome == "unverified" and not action.get("withdrawal_id"):
            # The bank never answered, so there is no record to read back: the money may or may not have moved.
            outcome = "maybe"
        if outcome in ("done", "unverified"):
            payee = action.get("payee") or req.demo.provider or "the hospital"
            result = {
                "message": f"Paid {money(amount)} to {payee}."
                + (" Dry run: Tend recorded it and read it back, but did not send it to the bank." if action.get("dry_run") else ""),
                "nessie_id": action.get("withdrawal_id"),
                "read_back_matches": bool((action.get("readback") or {}).get("ok")),
                "audit_id": audit_id,
            }
            text = render_paid(result, req.demo.model_dump(), await self._book(req.demo.st))
        return PayResultReply(
            request_id=req.request_id,
            outcome=outcome,
            text=text,
            amount_cents=amount,
            audit_id=audit_id,
            bank_record=action.get("withdrawal_id"),
        )

    # ------------------------------------------------------------ the packet, sealed for an advocate

    async def _share(self, req: PacketShareRequest) -> PacketShareReply:
        demo = req.demo
        scan, audit = await self._scan_and_audit(demo.persona_id, demo.st)
        claim = await self.api.claim(confirmed_input(scan, audit), scan["scan_id"])
        book = await self._book(demo.st)
        full = confirmed_input(scan, audit, keep_text=True)  # the bill and merchant text travel only inside the ciphertext
        notes = f"Fictional demo claim for {demo.who} ({state_name(demo.st)}), shared from Tend Navigator in ASI:One. {FICTIONAL}"
        if req.paid_cents:
            notes += (
                f" The {money(req.paid_cents)} left on the hospital bill was paid from the mock bank after a typed confirm code."
                f" The {money(demo.held_cents)} exam line stays unpaid, held under the law."
            )
        packet = {
            "st": demo.st,
            "created_at": self._now().replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "input": full,
            "output": claim,
            "notes": notes,
        }
        ciphertext, iv, key = seal(packet, rand=self._rand)
        hours = max(1, min(168, int(req.hours or self.settings.share_hours)))
        sealed = await self.api.seal_share(ciphertext, iv, hours=hours)
        url = share_link(self.settings.share_origin, str(sealed["id"]), key)
        needed = still_needed(book, full, claim)
        text = render_share(url, sealed.get("expires_at"), needed, filing_routes(book), book, claim, demo.who)
        return PacketShareReply(
            request_id=req.request_id, url=url, expires_at=sealed.get("expires_at"), text=text, still_needed=len(needed)
        )


def render_share(
    url: str,
    expires_at: str | None,
    needed: list[dict[str, Any]],
    routes: list[dict[str, Any]],
    book: RuleBook,
    claim: dict[str, Any],
    who: str,
) -> str:
    until = f" It stops working {long_date(expires_at)}." if expires_at else ""
    out = [
        "**Here is a locked link for an advocate.** It opens the claim in their browser, with the key in the link. "
        f"Tend's server keeps only a copy it cannot read.{until}",
        url,
        "**In the packet:**\n"
        f"- {book.name}'s own application with safe fields only. Name, signature, Social Security number, and anything "
        "about what happened stay blank for the survivor to fill in.\n"
        "- The cited summary: every cost with its record and the exact words of the law.\n"
        "- The letter to the billing office about the exam line.",
    ]
    if needed:
        rows = []
        for item in needed[:SHOWN_DOCUMENTS]:
            link = (
                f" ({cite_link({'pinpoint': item.get('pinpoint'), 'fragment_url': item.get('fragment_url')})})"
                if item.get("pinpoint")
                else ""
            )
            have = " In hand: the hospital bill Tend read line by line." if item.get("have_it") else ""
            rows.append(f"- {item['document']}{link}{have}")
        more = len(needed) - SHOWN_DOCUMENTS
        tail = f"\n- And {plural(more, 'more item')} in the packet." if more > 0 else ""
        out.append(f"**Still needed** (from {book.name}'s rules):\n" + "\n".join(rows) + tail)
    if routes:
        lines = [f"- {METHOD_LABEL[r['method']]}: {r['target']} ({cite_link(cite(r['rule'], book.sources))})" for r in routes]
        out.append("**Where to file:**\n" + "\n".join(lines))
    allowed = int((claim.get("totals") or {}).get("allowed_cents") or 0)
    out.append(f"**Amount {who} can ask for: {money(allowed)}. The program decides.**")
    return "\n\n".join(out)
