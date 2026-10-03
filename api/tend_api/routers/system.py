from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from ..clock import iso
from ..db import describe_url, verify_chain
from ..deps import ServicesDep

router = APIRouter(tags=["system"])


@router.get("/health")
def health(svc: ServicesDep) -> dict[str, Any]:
    try:
        corpus = svc.rulebook.status()
    except Exception as exc:  # health must answer even when the database does not
        corpus = {"error": type(exc).__name__}
    return {
        "ok": True,
        "database": {**svc.repo.ping(), "where": describe_url(svc.settings.database_url)},
        "corpus": corpus,
        "engines": svc.engines.status(),
        "jurisdictions": svc.rules.codes(),
        "bank": svc.settings.bank_mode,
        "relay": "live" if svc.settings.relay_live else "snapshot",
        "cloud_ai": svc.ai.status(),
        "time": iso(svc.clock()),
    }


@router.get("/audit")
def audit_log(svc: ServicesDep) -> dict[str, Any]:
    """The hash-chained log of confirmed payments, with its chain recomputed. Amounts, ids, and hashes only."""
    rows = svc.repo.audit_rows()
    return {
        "chain": verify_chain(rows),
        "rows": [{k: r[k] for k in ("seq", "ts", "event", "action_id", "data", "prev_hash", "hash")} for r in rows],
    }
