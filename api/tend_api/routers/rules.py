from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query

from ..deps import ServicesDep

router = APIRouter(prefix="/rules", tags=["rules"])


@router.get("/search")
def search(
    svc: ServicesDep,
    q: Annotated[str, Query(min_length=2, max_length=200)],
    st: Annotated[str | None, Query(pattern=r"^[A-Za-z]{2}$")] = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> dict[str, Any]:
    """Full-text search over the verified rules (Postgres tsvector in Neon, FTS5 offline), with quotes and links."""
    return svc.rulebook.search(q, st.upper() if st else None, limit)
