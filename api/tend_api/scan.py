"""Scan a demo persona's bank into claim items, on the server. Nothing is stored.

In the local-first flow the device classifies its own statement (web/lib/local/classify) and this
endpoint is the server-side twin for demo personas, for the agent, and for parity checks. Every
item is SPEC v1.2 shaped (typed unit and tags), and anything inferred starts unconfirmed.
"""

from __future__ import annotations

import dataclasses
import importlib
import json
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import Any

from pydantic import ValidationError

from .bill import BillRefused, load_document, snapshot_documents, verify_bill
from .clock import Clock, parse_date, state_today
from .errors import TendError
from .models import Item, ScanRequest
from .money import canonical_json, sha256_hex

Classifier = Callable[[list[dict[str, Any]], str], list[Any]]
DEFAULT_LABEL = "Fictional demo data. Bank records come from Capital One's Nessie sandbox, a mock bank."
MOCK_BANK_LABEL = "Bank records come from Capital One's Nessie sandbox, a mock bank."
TRANSACTION_KINDS = ("purchases", "bills", "withdrawals", "transfers", "deposits")
# Methods whose label is a guess or a link, so the line always waits for the survivor's yes.
INFERRED = frozenset({"model", "link", "inference", "unresolved"})


class ScanError(TendError):
    pass


def snapshot_dir(seed_dir: Path) -> Path:
    return seed_dir / "snapshots"


def load_snapshot(seed_dir: Path, persona_id: str) -> dict[str, Any]:
    path = snapshot_dir(seed_dir) / f"{persona_id}.json"
    if not path.is_file():
        raise ScanError(f"No snapshot for persona {persona_id!r}.", 404)
    return json.loads(path.read_text(encoding="utf-8"))


def list_snapshots(seed_dir: Path) -> list[tuple[str, dict[str, Any]]]:
    out = []
    for path in sorted(snapshot_dir(seed_dir).glob("*.json")):
        try:
            out.append((path.stem, json.loads(path.read_text(encoding="utf-8"))))
        except (OSError, ValueError):
            continue
    return out


def find_customer_snapshot(seed_dir: Path, customer_id: str) -> tuple[str, dict[str, Any]] | None:
    for persona_id, snap in list_snapshots(seed_dir):
        customer = snap.get("customer") or {}
        if customer_id in (customer.get("_id"), customer.get("id"), snap.get("customer_id")):
            return persona_id, snap
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


def primary_account(snap: dict[str, Any], key: str = "checking") -> dict[str, Any] | None:
    """The account payments come from: the persona's checking account unless another is named."""
    accounts = snap.get("accounts") or []
    wanted = ((snap.get("meta") or {}).get("account_keys") or {}).get(key)
    kind = {"checking": "checking", "cushion": "savings", "savings": "savings"}.get(key, key)
    pick = (
        next((a for a in accounts if wanted and _id(a) == wanted), None)
        or next((a for a in accounts if str(a.get("type", "")).lower() == kind), None)
        or (accounts[0] if accounts and key == "checking" else None)
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
            counseling = line.expense == "counseling"
            rows.append(
                {
                    "item_id": line.item_id,
                    "date": line.date.isoformat(),
                    "amount_cents": line.amount_cents,
                    "expense": line.expense,
                    # The provider's own itemized statement, not an inference, so the line starts confirmed.
                    "confirmed": True,
                    "insurance_paid_cents": 0,
                    "is_bill": True,
                    "units": 1 if counseling else 0,
                    "unit": "session" if counseling else None,
                    "description": (f"{bill.provider} - {line.description}" if bill.provider else line.description)[:200],
                    "tags": [],
                    "source": "rule",
                    "reason": f"Line {line.line_no} of the itemized bill{matched}",
                    "confidence": 1.0,
                    "merchant": bill.provider,
                    "kind": "bill_line",
                    "bill_id": doc["bill_id"],
                    "method": "itemized_bill",
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


def items_from_snapshot(module: ModuleType, snap: dict[str, Any], incident_date: str | None) -> list[dict[str, Any]]:
    """ClassifiedItems from the real classifier, plus the display fields the scan view shows."""
    from tend_api.nessie import BankSnapshot

    try:
        bank = BankSnapshot.from_dict(snap)
    except (ValueError, KeyError, TypeError) as exc:
        raise ScanError(f"This snapshot is not in the format the classifier reads: {exc}", 502) from exc
    anchors = [(d["service_date"], d["bill_id"], "medical") for d in snapshot_documents(snap) if d.get("service_date") and d.get("bill_id")]
    # Rules and the committed answers only: a scan never sends anything to a model (that takes the
    # survivor's yes, at POST /api/ai/classify) and never writes the cache file.
    cache = module.ClassificationCache(module.DEFAULT_CACHE_PATH)
    cache.path = None
    classifier = module.Classifier(cache=cache, use_model=False)
    results = module.classify_snapshot(bank, classifier, extra_anchors=anchors, incident_date=incident_date)
    kinds = {t.item_id: t.kind for t in bank.txns} | {b.item_id: "bill" for b in bank.bills}
    merchants = {t.item_id: (bank.merchant(t.merchant_id).name if bank.merchant(t.merchant_id) else None) for t in bank.txns}
    merchants |= {b.item_id: b.payee for b in bank.bills}
    items = []
    for item in module.snapshot_items(bank, results, incident_date):
        ref = item["item_id"].removeprefix("nessie:")
        r = results[ref]
        items.append(
            {
                **item,
                "merchant": merchants.get(item["item_id"]),
                "kind": kinds.get(item["item_id"]),
                "bill_id": ref if kinds.get(item["item_id"]) == "bill" else None,
                "method": r.method,
                "linked_item_ids": [f"nessie:{x}" for x in r.linked_refs],
            }
        )
    return items


def scan_reference(engine_input: dict[str, Any]) -> str:
    """A label for one scan, derived from what it found. Clients written for the first API send it back
    with a bill audit; nothing is stored under it or looked up by it."""
    return "scan_" + sha256_hex(canonical_json(engine_input))[:20]


def _as_dict(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if hasattr(raw, "model_dump"):
        return raw.model_dump(mode="json")
    if dataclasses.is_dataclass(raw) and not isinstance(raw, type):
        return dataclasses.asdict(raw)
    raise ScanError(f"classifier returned a {type(raw).__name__}, expected a mapping", 502)


def normalize_items(raw_items: list[Any]) -> tuple[list[Item], list[dict[str, Any]]]:
    """Split classifier output into strict engine items and display rows (engine fields plus reason, ...)."""
    items: list[Item] = []
    rows: list[dict[str, Any]] = []
    for raw in raw_items:
        data = _as_dict(raw)
        fields = {k: data[k] for k in Item.model_fields if k in data}
        fields.setdefault("confirmed", False)
        if data.get("method") in INFERRED or data.get("source") in ("cloud_ai", "device_ai"):
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
        seed_dir: Path,
        clock: Clock,
        classifier: Classifier | None = None,
        live_scan: bool = False,
        nessie_client_factory: Callable[[], Any] | None = None,
    ):
        self.seed_dir = seed_dir
        self.clock = clock
        self._classifier = classifier
        self.live_scan = live_scan
        self.nessie_client_factory = nessie_client_factory

    def persona_accounts(self) -> set[str]:
        """Every account id in the seed personas: the only accounts a live payment may come from."""
        accounts: set[str] = set()
        for _, snap in list_snapshots(self.seed_dir):
            accounts |= account_ids(snap)
        return accounts

    def persona_account(self, persona_id: str, key: str = "checking") -> dict[str, Any]:
        account = primary_account(load_snapshot(self.seed_dir, persona_id), key)
        if account is None:
            raise ScanError(f"{persona_id} has no {key} account.", 404)
        return account

    def classify(self, snap: dict[str, Any], st: str, incident_date: str | None) -> list[Any]:
        if self._classifier is not None:
            return list(self._classifier(transactions_from_snapshot(snap), st))
        module = _classify_module()
        if hasattr(module, "snapshot_items"):
            return items_from_snapshot(module, snap, incident_date)
        if hasattr(module, "classify_transactions"):
            return list(module.classify_transactions(transactions_from_snapshot(snap), st))
        raise ScanError("tend_api.classify has neither snapshot_items nor classify_transactions", 503)

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
            raise ScanError(f"Nessie did not answer the scan ({type(exc).__name__}).", 502) from exc
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
        as_of = parse_date(context.get("as_of_date")) or state_today(self.clock(), req.st)

        transactions = transactions_from_snapshot(snap)
        bill_rows, replaced, bill_errors = itemized_bill_items(self.seed_dir, snap)
        classified = [r for r in self.classify(snap, req.st, incident_date.isoformat()) if _as_dict(r).get("item_id") not in replaced]
        items, rows = normalize_items(classified + bill_rows)
        forensic_exam = context.get("forensic_exam")
        if not isinstance(forensic_exam, bool):
            forensic_exam = any(i.expense == "forensic_exam" for i in items)
        police = context.get("police_report") if context.get("police_report") in ("yes", "no", "unknown") else "unknown"
        fictional = bool(info["fictional"] if info["fictional"] is not None else persona_id is not None)
        documents = [
            {k: d.get(k) for k in ("kind", "bill_id", "statement_date", "service_date", "due_date", "total_cents")}
            for d in snapshot_documents(snap)
            if d.get("bill_id")
        ]
        engine_input = {
            "jurisdiction": req.st,
            "context": {
                "incident_date": incident_date.isoformat(),
                "as_of_date": as_of.isoformat(),
                "police_report": police,
                "forensic_exam": forensic_exam,
            },
            "items": [i.model_dump(mode="json") for i in items],
        }
        return {
            "scan_id": scan_reference(engine_input),
            "persona_id": persona_id,
            "customer_id": req.customer_id,
            "fictional": fictional,
            "label": info["label"] or (DEFAULT_LABEL if fictional else MOCK_BANK_LABEL),
            "display_name": info["display_name"] if fictional else None,
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
            "engine_input": engine_input,
        }


def _nessie_client() -> Any:
    try:
        from tend_api.nessie import NessieClient
    except ImportError as exc:
        raise ScanError(f"The Nessie client is not installed (tend_api.nessie): {exc}", 503) from exc
    return NessieClient.from_env() if hasattr(NessieClient, "from_env") else NessieClient()
