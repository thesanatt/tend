from __future__ import annotations

import dataclasses
import importlib
import json
import secrets
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import Any

from pydantic import ValidationError

from .bill import BillRefused, load_document, snapshot_documents, verify_bill
from .clock import Clock, iso, local_today, parse_date
from .errors import TendError
from .models import Item, ScanRequest
from .storage import Repository

Classifier = Callable[[list[dict[str, Any]], str], list[Any]]
DEFAULT_LABEL = "Fictional demo data. Bank records come from Capital One's Nessie sandbox, a mock bank."
MOCK_BANK_LABEL = "Bank records come from Capital One's Nessie sandbox, a mock bank."
TRANSACTION_KINDS = ("purchases", "bills", "withdrawals", "transfers", "deposits")


class ScanError(TendError):
    pass


def snapshot_dir(seed_dir: Path) -> Path:
    return seed_dir / "snapshots"


def load_snapshot(seed_dir: Path, persona_id: str) -> dict[str, Any]:
    path = snapshot_dir(seed_dir) / f"{persona_id}.json"
    if not path.is_file():
        raise ScanError(f"No snapshot for persona {persona_id!r} in {snapshot_dir(seed_dir)}", 404)
    return json.loads(path.read_text(encoding="utf-8"))


def find_customer_snapshot(seed_dir: Path, customer_id: str) -> tuple[str, dict[str, Any]] | None:
    for path in sorted(snapshot_dir(seed_dir).glob("*.json")):
        snap = json.loads(path.read_text(encoding="utf-8"))
        customer = snap.get("customer") or {}
        if customer_id in (customer.get("_id"), customer.get("id"), snap.get("customer_id")):
            return path.stem, snap
    return None


def _id(record: dict[str, Any]) -> Any:
    return record.get("id") or record.get("_id")


def persona_info(snap: dict[str, Any]) -> dict[str, Any]:
    """Persona fields live under meta in tend-bank-snapshot/1 and at the top level in older fixtures."""
    meta = snap.get("meta") or {}
    context = {**(meta.get("demo_inputs") or {}), **(snap.get("context") or {})}
    jurisdiction = meta.get("jurisdiction") or snap.get("jurisdiction")
    return {
        "persona_id": meta.get("persona_id") or snap.get("persona_id"),
        "jurisdiction": jurisdiction.upper() if isinstance(jurisdiction, str) else None,
        "fictional": meta.get("fictional", snap.get("fictional")),
        "display_name": meta.get("display_name") or snap.get("display_name"),
        "label": meta.get("notice") or snap.get("label"),
        "context": context,
    }


def account_ids(snap: dict[str, Any]) -> set[str]:
    return {str(_id(a)) for a in snap.get("accounts") or [] if _id(a)}


def primary_account(snap: dict[str, Any]) -> dict[str, Any] | None:
    """The account payments come from: the persona's checking account."""
    accounts = snap.get("accounts") or []
    key = ((snap.get("meta") or {}).get("account_keys") or {}).get("checking")
    pick = (
        next((a for a in accounts if key and _id(a) == key), None)
        or next((a for a in accounts if str(a.get("type", "")).lower() == "checking"), None)
        or (accounts[0] if accounts else None)
    )
    if pick is None:
        return None
    number = str(pick.get("account_number") or "")
    return {"id": str(_id(pick)), "nickname": pick.get("nickname") or pick.get("type") or "Account", "mask": number[-4:] or None}


def itemized_bill_items(seed_dir: Path, snap: dict[str, Any]) -> tuple[list[dict[str, Any]], set[str], list[dict[str, Any]]]:
    """Each verified itemized bill becomes its lines, standing in for the single bank bill it explains."""
    rows: list[dict[str, Any]] = []
    replaced: set[str] = set()
    errors: list[dict[str, Any]] = []
    for doc in snapshot_documents(snap):
        if not doc.get("bill_id"):
            continue
        source = load_document(seed_dir, doc)
        if source is None:
            errors.append({"bill_id": doc["bill_id"], "message": "The itemized bill file is missing."})
            continue
        try:
            bill, _ = verify_bill(source, snap)
        except BillRefused as exc:
            errors.append({"bill_id": doc["bill_id"], **exc.detail})
            continue
        replaced.add(f"nessie:{doc['bill_id']}")
        for line in bill.lines:
            matched = f', matched on "{line.match}"' if line.match else ""
            rows.append(
                {
                    "item_id": line.item_id,
                    "date": line.date.isoformat(),
                    "amount_cents": line.amount_cents,
                    "expense": line.expense,
                    # The provider's own itemized statement, not an inference, so the line starts confirmed.
                    "confirmed": True,
                    "is_bill": True,
                    "units": 0,
                    "description": (f"{bill.provider} - {line.description}" if bill.provider else line.description)[:200],
                    "merchant": bill.provider,
                    "source": "bill",
                    "bill_id": doc["bill_id"],
                    "confidence": 1.0,
                    "method": "itemized_bill",
                    "reason": f"Line {line.line_no} of the itemized bill{matched}",
                }
            )
    return rows, replaced, errors


def transactions_from_snapshot(snap: dict[str, Any]) -> list[dict[str, Any]]:
    merchants = {_id(m): m for m in snap.get("merchants") or [] if isinstance(m, dict)}
    if isinstance(snap.get("transactions"), list):
        records = [dict(t) for t in snap["transactions"]] + [{**b, "kind": "bill"} for b in snap.get("bills") or []]
    else:
        records = [{**r, "kind": r.get("kind", kind[:-1])} for kind in TRANSACTION_KINDS for r in snap.get(kind) or []]
    for txn in records:
        merchant = merchants.get(txn.get("merchant_id"))
        if merchant and "merchant" not in txn:
            txn["merchant"] = merchant
    return records


def _classify_module() -> ModuleType:
    try:
        return importlib.import_module("tend_api.classify")
    except ImportError as exc:
        raise ScanError(f"The classifier is not installed (tend_api.classify): {exc}", 503) from exc


def default_classifier() -> Classifier:
    module = _classify_module()
    if not hasattr(module, "classify_transactions"):
        raise ScanError("tend_api.classify has no classify_transactions(transactions, st)", 503)
    return module.classify_transactions


def items_from_classifications(snap: dict[str, Any], results: dict[str, Any]) -> list[dict[str, Any]]:
    """Engine items from classify_snapshot's {nessie id: Classification}. Only candidates become items."""
    service_dates = {d.get("bill_id"): d.get("service_date") for d in snapshot_documents(snap) if d.get("bill_id")}
    items = []
    for txn in transactions_from_snapshot(snap):
        ref = _id(txn)
        result = results.get(ref)
        if result is None:
            continue
        r = result.to_dict() if hasattr(result, "to_dict") else dict(result)
        if not r.get("candidate"):
            continue
        is_bill = txn.get("kind") == "bill"
        merchant = (txn.get("merchant") or {}).get("name")
        description = txn.get("payee") if is_bill else " ".join(filter(None, [merchant, txn.get("description")]))
        items.append(
            {
                "item_id": f"nessie:{ref}",
                # A Nessie bill's own dates are bookkeeping; the itemized bill says when care happened.
                "date": (service_dates.get(ref) if is_bill else None) or txn.get("date") or txn.get("creation_date"),
                "amount_cents": txn.get("amount_cents"),
                "expense": r.get("expense", "unknown"),
                "confirmed": bool(r.get("confirmed")),
                "is_bill": is_bill,
                # Each counseling charge is one session, so per-session caps can apply.
                "units": 1 if r.get("expense") == "counseling" and not is_bill else 0,
                "tags": list(r.get("tags") or []),
                "description": (description or "")[:200],
                "merchant": txn.get("payee") if is_bill else merchant,
                "source": txn.get("kind"),
                "bill_id": ref if is_bill else None,
                "confidence": r.get("confidence"),
                "reason": r.get("reason"),
                "method": r.get("method"),
                "linked_item_ids": [f"nessie:{x}" for x in r.get("linked_refs") or []],
            }
        )
    return items


def classify_with_snapshot(module: ModuleType, snap: dict[str, Any]) -> dict[str, Any]:
    from tend_api.nessie import BankSnapshot

    try:
        bank = BankSnapshot.from_dict(snap)
    except (ValueError, KeyError, TypeError) as exc:
        raise ScanError(f"This snapshot is not in the format the classifier reads: {exc}", 502) from exc
    anchors = [(d["service_date"], d["bill_id"], "medical") for d in snapshot_documents(snap) if d.get("service_date") and d.get("bill_id")]
    return module.classify_snapshot(bank, extra_anchors=anchors)


def _as_dict(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if hasattr(raw, "model_dump"):
        return raw.model_dump(mode="json")
    if dataclasses.is_dataclass(raw) and not isinstance(raw, type):
        return dataclasses.asdict(raw)
    raise ScanError(f"classifier returned a {type(raw).__name__}, expected a mapping", 502)


def normalize_items(raw_items: list[Any]) -> tuple[list[Item], list[dict[str, Any]]]:
    """Split classifier output into strict engine items and display rows (engine fields plus confidence, reason, ...)."""
    items: list[Item] = []
    rows: list[dict[str, Any]] = []
    for raw in raw_items:
        data = _as_dict(raw)
        fields = {k: data[k] for k in Item.model_fields if k in data}
        fields.setdefault("confirmed", False)
        confidence = data.get("confidence")
        if isinstance(confidence, (int, float)) and confidence < 1:
            fields["confirmed"] = False  # anything inferred waits for the survivor's yes
        try:
            item = Item.model_validate(fields)
        except ValidationError as exc:
            raise ScanError(f"classifier returned an invalid item {data.get('item_id')!r}: {exc.errors()[0]['msg']}", 502) from exc
        items.append(item)
        extras = {k: v for k, v in data.items() if k not in Item.model_fields}
        rows.append({**item.model_dump(mode="json"), **extras})
    return items, rows


class ScanService:
    def __init__(
        self,
        repo: Repository,
        seed_dir: Path,
        clock: Clock,
        classifier: Classifier | None = None,
        live_scan: bool = False,
        nessie_client_factory: Callable[[], Any] | None = None,
    ):
        self.repo = repo
        self.seed_dir = seed_dir
        self.clock = clock
        self._classifier = classifier
        self.live_scan = live_scan
        self.nessie_client_factory = nessie_client_factory

    def accounts_for_scan(self, scan_id: str) -> set[str] | None:
        """The persona's own account ids, when the scan came from a persona snapshot."""
        scan = self.repo.get_scan(scan_id)
        if not scan or not scan.get("persona_id"):
            return None
        try:
            return account_ids(load_snapshot(self.seed_dir, scan["persona_id"])) or None
        except ScanError:
            return None

    def classify(self, snap: dict[str, Any], st: str) -> list[Any]:
        if self._classifier is not None:
            return list(self._classifier(transactions_from_snapshot(snap), st))
        module = _classify_module()
        if hasattr(module, "classify_transactions"):
            return list(module.classify_transactions(transactions_from_snapshot(snap), st))
        if hasattr(module, "classify_snapshot"):
            return items_from_classifications(snap, classify_with_snapshot(module, snap))
        raise ScanError("tend_api.classify has neither classify_transactions nor classify_snapshot", 503)

    def snapshot_for(self, req: ScanRequest) -> tuple[str | None, dict[str, Any]]:
        if req.persona_id:
            return req.persona_id, load_snapshot(self.seed_dir, req.persona_id)
        found = find_customer_snapshot(self.seed_dir, req.customer_id or "")
        if found:
            return found
        if not self.live_scan:
            raise ScanError("No offline snapshot for that customer, and live Nessie scans are off (TEND_LIVE_SCAN=1 turns them on).", 404)
        client = self.nessie_client_factory() if self.nessie_client_factory else _nessie_client()
        if not hasattr(client, "snapshot"):
            raise ScanError("The Nessie client has no snapshot(customer_id) method.", 503)
        try:
            snap = client.snapshot(req.customer_id)
        except Exception as exc:
            raise ScanError(f"Nessie did not answer the scan: {exc}", 502) from exc
        if hasattr(snap, "to_dict"):
            snap = snap.to_dict()
        if not isinstance(snap, dict):
            raise ScanError("Nessie returned an unexpected snapshot.", 502)
        snap.setdefault("fictional", False)
        return None, snap

    def scan(self, req: ScanRequest) -> dict[str, Any]:
        persona_id, snap = self.snapshot_for(req)
        info = persona_info(snap)
        context = info["context"]
        incident_date = req.incident_date or parse_date(context.get("incident_date"))
        if incident_date is None:
            raise ScanError("incident_date is required (the persona snapshot does not set one).", 422)
        now = self.clock()
        as_of = parse_date(context.get("as_of_date")) or local_today(now)

        transactions = transactions_from_snapshot(snap)
        bill_rows, replaced, bill_errors = itemized_bill_items(self.seed_dir, snap)
        classified = [r for r in self.classify(snap, req.st) if _as_dict(r).get("item_id") not in replaced]
        items, rows = normalize_items(classified + bill_rows)
        forensic_exam = context.get("forensic_exam")
        if not isinstance(forensic_exam, bool):
            forensic_exam = any(i.expense == "forensic_exam" for i in items)
        police = context.get("police_report") if context.get("police_report") in ("yes", "no", "unknown") else "unknown"

        scan_id = f"scan_{secrets.token_hex(10)}"
        fictional = bool(info["fictional"] if info["fictional"] is not None else persona_id is not None)
        display_name = info["display_name"] if fictional else None
        self.repo.save_scan(
            {
                "scan_id": scan_id,
                "persona_id": persona_id,
                "customer_id": req.customer_id,
                "jurisdiction": req.st,
                "fictional": fictional,
                "display_name": display_name,
                "created_at": iso(now),
            },
            [{"item_id": i.item_id, "amount_cents": i.amount_cents, "date": i.date.isoformat(), "source": "nessie"} for i in items],
        )
        documents = [
            {k: d.get(k) for k in ("kind", "bill_id", "statement_date", "service_date", "due_date", "total_cents")}
            for d in snapshot_documents(snap)
            if d.get("bill_id")
        ]
        return {
            "scan_id": scan_id,
            "persona_id": persona_id,
            "customer_id": req.customer_id,
            "fictional": fictional,
            "label": info["label"] or (DEFAULT_LABEL if fictional else MOCK_BANK_LABEL),
            "display_name": display_name,
            "st": req.st,
            "incident_date": incident_date.isoformat(),
            "as_of_date": as_of.isoformat(),
            "account": primary_account(snap),
            "accounts": sorted(account_ids(snap)),
            "read_count": len(transactions),
            "documents": documents,
            "bill_errors": bill_errors,
            "counts": {
                "transactions": len(transactions),
                "items": len(items),
                "by_expense": dict(Counter(i.expense for i in items)),
            },
            "items": rows,
            "engine_input": {
                "jurisdiction": req.st,
                "context": {
                    "incident_date": incident_date.isoformat(),
                    "as_of_date": as_of.isoformat(),
                    "police_report": police,
                    "forensic_exam": forensic_exam,
                },
                "items": [i.model_dump(mode="json") for i in items],
            },
        }


def _nessie_client() -> Any:
    try:
        from tend_api.nessie import NessieClient
    except ImportError as exc:
        raise ScanError(f"The Nessie client is not installed (tend_api.nessie): {exc}", 503) from exc
    return NessieClient.from_env() if hasattr(NessieClient, "from_env") else NessieClient()
