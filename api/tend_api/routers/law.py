from __future__ import annotations

import logging
import sqlite3
from collections.abc import Callable
from typing import Annotated, Any

import psycopg
from fastapi import APIRouter, Query

from ..deps import ServicesDep
from ..law import LawError, LawService

router = APIRouter(prefix="/law", tags=["law"])
log = logging.getLogger("tend.law")

VERSION_NAME = r"^law-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9a-f]{7,12}$"
State = Annotated[str | None, Query(pattern=r"^[A-Za-z]{2}$", description="two-letter code; all jurisdictions when left out")]
Version = Annotated[str | None, Query(pattern=VERSION_NAME, description="a published law version, e.g. law-2026-10-03-c959cb6")]


def _law(svc: ServicesDep) -> LawService:
    if svc.law is None:
        raise LawError("Law versions are not set up on this server.", 503)
    return svc.law


def _answer[T](fn: Callable[[], T]) -> T:
    """A database that is asleep, unreachable, or out of connections is a plain 503, not a 500 with a traceback. The
    log line names the error class only, never the query or what someone searched for."""
    try:
        return fn()
    except (psycopg.Error, sqlite3.Error) as exc:
        log.warning("law read failed: %s", type(exc).__name__)
        raise LawError("The law versions could not be read just now. Try again in a moment.", 503) from exc


@router.get("/versions")
def versions(svc: ServicesDep, st: State = None) -> dict[str, Any]:
    """Published law versions, oldest first. Each is a Neon branch holding the whole verified corpus at one git commit.
    `current` names the version this server's database has loaded. With st, each version shows that state's file hashes."""
    return _answer(lambda: _law(svc).listing(st.upper() if st else None))


@router.get("/diff")
def diff(
    svc: ServicesDep,
    from_: Annotated[str | None, Query(alias="from", pattern=VERSION_NAME, description="default: the version before `to`")] = None,
    to: Annotated[str | None, Query(pattern=VERSION_NAME, description="default: the newest version")] = None,
    st: State = None,
) -> dict[str, Any]:
    """What changed between two law versions, read from their two branches. With st: rules added, removed, and changed,
    each with its verbatim quote and source link, and the source copies that were saved again. Without st: counts per state."""
    return _answer(lambda: _law(svc).diff(from_, to, st))


@router.get("/search")
def search(
    svc: ServicesDep,
    q: Annotated[str, Query(min_length=2, max_length=200, description='words, "a phrase", or, -word')],
    st: State = None,
    version: Version = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> dict[str, Any]:
    """Full-text search over the verbatim quotes only (a tsvector with a GIN index in Neon). Each result is a quote with
    its rule id, pinpoint, and the link that opens the source at that sentence; `marks` are the matched words as
    [start, end) offsets into the quote. With version, the search runs on that version's branch."""
    return _answer(lambda: _law(svc).search(q, st, limit, version))
