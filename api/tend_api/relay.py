"""The bank relay: a demo persona's statement, read from Nessie for the device.

The relay holds the Nessie key so the browser never does. It returns statement rows and keeps
nothing: no database writes, no logs of what it returned (docs/PRIVACY.md, "Bank connection").
When Nessie does not answer, the committed snapshot stands in and the response says so.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .bill import snapshot_documents
from .errors import TendError
from .nessie import BankSnapshot, NessieClient, list_persona_snapshots, load_persona_snapshot, read_persona

PERSONA = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
ACCOUNT_TYPES = {"checking": "Checking", "cushion": "Savings", "savings": "Savings"}


class RelayError(TendError):
    pass


class BankRelay:
    def __init__(self, seed_dir: Path, live: bool = False, client_factory: Callable[[], Any] | None = None):
        self.seed_dir = seed_dir
        self.live = live
        self.client_factory = client_factory or NessieClient.from_env

    @property
    def snapshot_dir(self) -> Path:
        return self.seed_dir / "snapshots"

    def personas(self) -> list[str]:
        return list_persona_snapshots(self.snapshot_dir)

    def _saved(self, persona_id: str) -> BankSnapshot:
        if not PERSONA.match(persona_id) or persona_id not in self.personas():
            raise RelayError(f"No demo persona named {persona_id!r}.", 404)
        return load_persona_snapshot(persona_id, self.snapshot_dir)

    def saved(self, persona_id: str) -> BankSnapshot:
        """The committed snapshot of a demo persona: what the demo starts from, and the list of its ids."""
        return self._saved(persona_id)

    def live_client(self) -> Any | None:
        """A fresh Nessie client when the relay reads live, else None. The caller closes it."""
        if not self.live:
            return None
        try:
            return self.client_factory()
        except Exception:  # no key or no client: the snapshot is the honest answer
            return None

    def read(self, persona_id: str) -> tuple[BankSnapshot, str]:
        """The persona's bank and where it came from: "live" (Nessie) or "snapshot"."""
        saved = self._saved(persona_id)
        if not self.live:
            return saved, "snapshot"
        try:
            client = self.client_factory()
        except Exception:  # no key or no client: the snapshot is the honest answer
            return saved, "snapshot"
        try:
            read = read_persona(persona_id, client, self.snapshot_dir)
        finally:
            close = getattr(client, "close", None)
            if callable(close):
                close()
        return read.snapshot, read.source

    @staticmethod
    def account(snapshot: BankSnapshot, key: str) -> Any:
        wanted = (snapshot.meta.get("account_keys") or {}).get(key)
        for a in snapshot.accounts:
            if a.id == wanted:
                return a
        kind = ACCOUNT_TYPES.get(key)
        for a in snapshot.accounts:
            if a.type == kind:
                return a
        raise RelayError(f"This persona has no {key} account.", 404)

    def transactions(self, persona_id: str, start: dt.date | None, end: dt.date | None, account: str = "checking") -> dict[str, Any]:
        if start and end and start > end:
            raise RelayError("from is after to.", 422)
        snapshot, source = self.read(persona_id)
        acct = self.account(snapshot, account)
        rows = snapshot.statement(acct.id, start.isoformat() if start else None, end.isoformat() if end else None)
        documents = {d["bill_id"]: d for d in snapshot_documents({"meta": snapshot.meta}) if d.get("bill_id")}
        bills = [
            {
                "id": b.item_id,
                "bill_id": b.id,
                "payee": b.payee,
                "amount_cents": b.amount_cents,
                "status": b.status,
                "due_date": b.payment_date,
                "itemized": b.id in documents,
                "service_date": documents[b.id].get("service_date") if b.id in documents else None,
                "document_path": f"/api/bank/{persona_id}/bills/{b.id}/document" if b.id in documents else None,
            }
            for b in snapshot.bills
            if b.account_id == acct.id and b.status != "cancelled"
        ]
        # The itemized bills' records, as a snapshot names them: web/lib/local reads service_date from here and
        # counts a ride that day as travel to care, the same anchor /scan uses.
        itemized = [
            {k: documents[b["bill_id"]].get(k) for k in ("kind", "bill_id", "statement_date", "service_date", "due_date", "total_cents")}
            for b in bills
            if b["itemized"]
        ]
        number = acct.account_number or ""
        return {
            "persona_id": persona_id,
            "fictional": bool(snapshot.meta.get("fictional", True)),
            "notice": snapshot.meta.get("notice") or "Fictional demo data on Capital One's Nessie mock bank.",
            "source": source,
            "account": {"id": acct.id, "type": acct.type, "nickname": acct.nickname, "mask": number[-4:] or None},
            "from": start.isoformat() if start else None,
            "to": end.isoformat() if end else None,
            "count": len(rows),
            "txns": rows,
            "bills": bills,
            "documents": itemized,
        }

    def bill_document(self, persona_id: str, bill_id: str) -> tuple[bytes, str]:
        """The itemized bill a persona's snapshot names, after checking it is the file the snapshot recorded."""
        snapshot = self._saved(persona_id)
        for doc in snapshot_documents({"meta": snapshot.meta}):
            if doc.get("bill_id") != bill_id:
                continue
            path = (self.seed_dir.parent / str(doc.get("path", ""))).resolve()
            if not path.is_file() or self.seed_dir.resolve() not in path.parents:
                path = (self.seed_dir / "bills" / Path(str(doc.get("path", ""))).name).resolve()
            if not path.is_file():
                break
            data = path.read_bytes()
            if doc.get("sha256") and hashlib.sha256(data).hexdigest() != doc["sha256"]:
                raise RelayError("This bill file does not match the one on record.", 409)
            return data, "application/pdf" if path.suffix.lower() == ".pdf" else "text/plain"
        raise RelayError("No itemized bill with that id for this persona.", 404)
