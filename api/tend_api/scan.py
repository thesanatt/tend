from __future__ import annotations

import dataclasses
import json
import secrets
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from .clock import Clock, iso, local_today, parse_date
from .errors import TendError
from .models import Item, ScanRequest
from .storage import Repository

Classifier = Callable[[list[dict[str, Any]], str], list[Any]]
DEFAULT_LABEL = "Fictional demo data. Bank records come from Capital One's Nessie sandbox, a mock bank."
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


def transactions_from_snapshot(snap: dict[str, Any]) -> list[dict[str, Any]]:
    if isinstance(snap.get("transactions"), list):
        return [dict(t) for t in snap["transactions"]]
    merchants = {m.get("_id"): m for m in snap.get("merchants") or [] if isinstance(m, dict)}
    out = []
    for kind in TRANSACTION_KINDS:
        for record in snap.get(kind) or []:
            txn = dict(record)
            txn.setdefault("kind", kind[:-1])
            merchant = merchants.get(txn.get("merchant_id"))
            if merchant and "merchant" not in txn:
                txn["merchant"] = merchant
            out.append(txn)
    return out


def default_classifier() -> Classifier:
    try:
        from tend_api.classify import classify_transactions
    except ImportError as exc:
        raise ScanError(f"The classifier is not installed (tend_api.classify): {exc}", 503) from exc
    return classify_transactions


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
    def __init__(self, repo: Repository, seed_dir: Path, clock: Clock, classifier: Classifier | None = None,
                 live_scan: bool = False, nessie_client_factory: Callable[[], Any] | None = None):
        self.repo = repo
        self.seed_dir = seed_dir
        self.clock = clock
        self._classifier = classifier
        self.live_scan = live_scan
        self.nessie_client_factory = nessie_client_factory

    def classifier(self) -> Classifier:
        if self._classifier is None:
            self._classifier = default_classifier()
        return self._classifier

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
        snap = client.snapshot(req.customer_id)
        snap.setdefault("fictional", False)
        return None, snap

    def scan(self, req: ScanRequest) -> dict[str, Any]:
        persona_id, snap = self.snapshot_for(req)
        context = dict(snap.get("context") or {})
        incident_date = req.incident_date or parse_date(context.get("incident_date"))
        if incident_date is None:
            raise ScanError("incident_date is required (the persona snapshot does not set one).", 422)
        now = self.clock()
        as_of = parse_date(context.get("as_of_date")) or local_today(now)

        transactions = transactions_from_snapshot(snap)
        items, rows = normalize_items(list(self.classifier()(transactions, req.st)))
        forensic_exam = context.get("forensic_exam")
        if not isinstance(forensic_exam, bool):
            forensic_exam = any(i.expense == "forensic_exam" for i in items)
        police = context.get("police_report") if context.get("police_report") in ("yes", "no", "unknown") else "unknown"

        scan_id = f"scan_{secrets.token_hex(10)}"
        fictional = bool(snap.get("fictional", persona_id is not None))
        display_name = snap.get("display_name") if fictional else None
        self.repo.save_scan(
            {"scan_id": scan_id, "persona_id": persona_id, "customer_id": req.customer_id, "jurisdiction": req.st,
             "fictional": fictional, "display_name": display_name, "created_at": iso(now)},
            [{"item_id": i.item_id, "amount_cents": i.amount_cents, "date": i.date.isoformat(), "source": "nessie"} for i in items],
        )
        return {
            "scan_id": scan_id,
            "persona_id": persona_id,
            "customer_id": req.customer_id,
            "fictional": fictional,
            "label": snap.get("label") or (DEFAULT_LABEL if fictional else "Bank records come from Capital One's Nessie sandbox, a mock bank."),
            "display_name": display_name,
            "st": req.st,
            "counts": {
                "transactions": len(transactions),
                "items": len(items),
                "by_expense": dict(Counter(i.expense for i in items)),
            },
            "items": rows,
            "engine_input": {
                "jurisdiction": req.st,
                "context": {
                    "incident_date": incident_date.isoformat(), "as_of_date": as_of.isoformat(),
                    "police_report": police, "forensic_exam": forensic_exam,
                },
                "items": [i.model_dump(mode="json") for i in items],
            },
        }


def _nessie_client() -> Any:
    try:
        from tend_api.nessie import NessieClient
    except ImportError as exc:
        raise ScanError(f"The Nessie client is not installed (tend_api.nessie): {exc}", 503) from exc
    return NessieClient()
