from __future__ import annotations

from collections import Counter
from typing import Any

from fastapi import APIRouter

from ..clock import iso
from ..db import describe_url, verify_chain
from ..deps import ServicesDep
from ..redact import path_roots, redact_paths

router = APIRouter(tags=["system"])


@router.get("/health")
def health(svc: ServicesDep) -> dict[str, Any]:
    try:
        corpus = svc.rulebook.status()
    except Exception as exc:  # health must answer even when the database does not
        corpus = {"error": type(exc).__name__}
    database = {**svc.repo.ping(), "where": describe_url(svc.settings.database_url)}
    engines = svc.engines.status()
    if svc.settings.deployed:
        # A public deployment says what runs, not where its files or its database endpoint are.
        database.pop("where", None)
        engines = {name: {k: v for k, v in status.items() if k != "library"} for name, status in engines.items()}
        engines = redact_paths(engines, path_roots(svc.settings))
    return {
        "ok": True,
        "database": database,
        "corpus": corpus,
        "engines": engines,
        "jurisdictions": svc.rules.codes(),
        "bank": svc.settings.bank_mode,
        "relay": "live" if svc.settings.relay_live else "snapshot",
        "cloud_ai": svc.ai.status(),
        "time": iso(svc.clock()),
    }


@router.get("/audit")
def audit_log(svc: ServicesDep) -> dict[str, Any]:
    """The hash-chained log of confirmed payments, with its chain recomputed. Amounts, ids, and hashes only.

    A public deployment returns the chain's head, its length, and how many rows of each kind it holds, so
    anyone can check the chain is intact without seeing when each payment happened or how much it was.
    TEND_AUDIT_ROWS=1 lists the rows anyway, for a demo."""
    rows = svc.repo.audit_rows()
    chain = verify_chain(rows)
    if svc.settings.deployed and not svc.settings.audit_rows:
        return {"chain": chain, "counts": dict(sorted(Counter(r["event"] for r in rows).items()))}
    return {
        "chain": chain,
        "rows": [{k: r[k] for k in ("seq", "ts", "event", "action_id", "data", "prev_hash", "hash")} for r in rows],
    }
