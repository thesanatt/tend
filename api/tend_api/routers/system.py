from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from ..clock import iso
from ..deps import ServicesDep
from ..storage import verify_chain

router = APIRouter(tags=["system"])


@router.get("/health")
def health(svc: ServicesDep) -> dict[str, Any]:
    return {
        "ok": True,
        "engines": svc.engines.status(),
        "jurisdictions": svc.rules.codes(),
        "bank": svc.settings.bank_mode,
        "time": iso(svc.clock()),
    }


@router.get("/audit")
def audit_log(svc: ServicesDep) -> dict[str, Any]:
    rows = svc.repo.audit_rows()
    return {
        "chain": verify_chain(rows),
        "rows": [{k: r[k] for k in ("seq", "ts", "event", "action_id", "data", "prev_hash", "hash")} for r in rows],
    }
