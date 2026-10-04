"""A small client for the Neon API (branches, their computes, and the operations that create them).

Used by scripts/neon (publishing law versions) and the live tests (a throwaway branch per run). The API
itself never holds a Neon API key: it reads published branches as a SELECT-only role, by host.
Responses can carry connection strings with passwords; nothing here prints or logs them.
"""

from __future__ import annotations

import datetime as dt
import time
import urllib.parse
from dataclasses import dataclass
from typing import Any

import httpx

API = "https://console.neon.tech/api/v2"


class NeonError(RuntimeError):
    pass


@dataclass(frozen=True)
class Branch:
    id: str
    name: str
    parent_id: str | None
    host: str | None  # the read-write compute's host (direct, not pooled)
    owner_uri: str | None = None  # only right after creation; holds a password, never print it

    def __repr__(self) -> str:  # keep the URI out of tracebacks and logs
        return f"Branch(id={self.id!r}, name={self.name!r}, parent_id={self.parent_id!r}, host={self.host!r})"


class NeonAPI:
    def __init__(self, api_key: str, project_id: str, *, client: httpx.Client | None = None, timeout: float = 30.0):
        if not api_key or not project_id:
            raise NeonError("NEON_API_KEY and NEON_PROJECT_ID are both needed")
        self.project_id = project_id
        self._http = client or httpx.Client(
            base_url=API, timeout=timeout, headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"}
        )

    def close(self) -> None:
        self._http.close()

    def _call(self, method: str, path: str, **kw: Any) -> dict[str, Any]:
        for attempt in range(6):
            r = self._http.request(method, f"/projects/{self.project_id}{path}", **kw)
            # 423: another operation on the project is still running; wait for it rather than fail.
            if r.status_code in (423, 429, 503) and attempt < 5:
                time.sleep(1.5 * (attempt + 1))
                continue
            if r.status_code >= 400:
                raise NeonError(f"{method} {path}: {r.status_code} {r.text[:300]}")
            return r.json() if r.content else {}
        raise NeonError(f"{method} {path}: still locked after retries")

    def project(self) -> dict[str, Any]:
        return self._call("GET", "")["project"]

    def branches(self) -> list[dict[str, Any]]:
        return self._call("GET", "/branches")["branches"]

    def branch(self, branch_id: str) -> dict[str, Any]:
        return self._call("GET", f"/branches/{branch_id}")["branch"]

    def find_branch(self, name: str) -> dict[str, Any] | None:
        return next((b for b in self.branches() if b["name"] == name), None)

    def default_branch(self) -> dict[str, Any]:
        found = next((b for b in self.branches() if b.get("default")), None)
        if found is None:
            raise NeonError("the project has no default branch")
        return found

    def endpoints(self, branch_id: str) -> list[dict[str, Any]]:
        return self._call("GET", f"/branches/{branch_id}/endpoints")["endpoints"]

    def read_write_host(self, branch_id: str) -> str | None:
        return next((e["host"] for e in self.endpoints(branch_id) if e["type"] == "read_write"), None)

    def create_branch(
        self,
        name: str,
        parent_id: str,
        *,
        schema_only: bool = False,
        expires_in: dt.timedelta | None = None,
        compute: bool = True,
    ) -> Branch:
        """A new branch with a read-write compute. schema_only copies the parent's tables but none of its rows, which
        makes a new root branch; expires_in lets Neon delete it on its own (test branches)."""
        spec: dict[str, Any] = {"name": name, "parent_id": parent_id}
        if schema_only:
            spec["init_source"] = "schema-only"
        if expires_in is not None:
            spec["expires_at"] = (dt.datetime.now(dt.UTC) + expires_in).strftime("%Y-%m-%dT%H:%M:%SZ")
        body: dict[str, Any] = {"branch": spec}
        if compute:
            body["endpoints"] = [{"type": "read_write"}]
        data = self._call("POST", "/branches", json=body)
        self.wait(data.get("operations") or [])
        branch = data["branch"]
        host = next((e["host"] for e in data.get("endpoints") or [] if e["type"] == "read_write"), None)
        uri = next((c["connection_uri"] for c in data.get("connection_uris") or []), None)
        return Branch(branch["id"], branch["name"], branch.get("parent_id"), host, uri)

    def delete_branch(self, branch_id: str) -> None:
        data = self._call("DELETE", f"/branches/{branch_id}")
        self.wait(data.get("operations") or [])

    def wait(self, operations: list[dict[str, Any]], timeout: float = 180.0) -> None:
        deadline = time.monotonic() + timeout
        pending = [op["id"] for op in operations]
        while pending:
            op = self._call("GET", f"/operations/{pending[0]}")["operation"]
            if op["status"] == "finished":
                pending.pop(0)
                continue
            if op["status"] in ("failed", "error", "cancelled", "skipped"):
                raise NeonError(f"operation {op['action']} {op['status']}: {op.get('error', '')[:200]}")
            if time.monotonic() > deadline:
                raise NeonError(f"operation {op['action']} still {op['status']} after {timeout:.0f} s")
            time.sleep(0.5)


def with_host(url: str, host: str) -> str:
    """The same role, password, and database on another branch's compute. A pooled URL stays pooled."""
    parts = urllib.parse.urlsplit(url)
    endpoint, _, rest = host.partition(".")
    current = (parts.hostname or "").split(".", 1)[0]
    if current.endswith("-pooler") and not endpoint.endswith("-pooler"):
        endpoint += "-pooler"
    netloc = parts.netloc.rsplit("@", 1)
    userinfo = f"{netloc[0]}@" if len(netloc) == 2 else ""
    port = f":{parts.port}" if parts.port else ""
    return urllib.parse.urlunsplit((parts.scheme, f"{userinfo}{endpoint}.{rest}{port}", parts.path, parts.query, parts.fragment))


def url_role(url: str) -> str | None:
    return urllib.parse.urlsplit(url).username
