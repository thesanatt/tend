"""Measure what docs/NEON.md reports: rows, branches and their sizes, and query timings with EXPLAIN ANALYZE.

usage (from the repo root):
  cd api && uv run python ../scripts/neon/measure.py [--json out.json]

Every query runs as tend_reader, the role the public reads use. EXPLAIN ANALYZE runs only SELECTs. Times on the
server come from the plan; times "from here" include the network from wherever this runs to Neon (us-east-2).
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from typing import Any

import psycopg
from neonenv import load_env

from tend_api.db.neon import NeonAPI, with_host
from tend_api.db.postgres import PostgresRepository
from tend_api.law import LawService, neon_opener

QUERIES = {
    "quote search, one state": (
        "SELECT r.st, r.id, ts_rank_cd(r.quote_search, q.query, 32) AS rank, ts_headline('english', r.quote, q.query,"
        " 'HighlightAll=true') AS marked FROM rules r CROSS JOIN websearch_to_tsquery('english', %(q)s) AS q(query)"
        " WHERE r.quote_search @@ q.query AND r.st = %(st)s ORDER BY rank DESC, r.st, r.ord LIMIT 20"
    ),
    "quote search, all states": (
        "SELECT r.st, r.id, ts_rank_cd(r.quote_search, q.query, 32) AS rank, ts_headline('english', r.quote, q.query,"
        " 'HighlightAll=true') AS marked FROM rules r CROSS JOIN websearch_to_tsquery('english', %(q)s) AS q(query)"
        " WHERE r.quote_search @@ q.query ORDER BY rank DESC, r.st, r.ord LIMIT 20"
    ),
    "version index": "SELECT name, seq, corpus_sha256 FROM law_versions ORDER BY seq",
    "which version holds this file": (
        "SELECT version FROM law_version_files WHERE st = %(st)s AND verified_sha256 = %(sha)s ORDER BY version DESC LIMIT 1"
    ),
    "one state's rules for a diff": (
        "SELECT r.st, r.id, r.quote, r.ir, s.sha256 FROM rules r JOIN sources s ON s.st = r.st AND s.id = r.source_id"
        " WHERE r.st = %(st)s ORDER BY r.st, r.ord"
    ),
}


def explain(conn: psycopg.Connection, sql: str, args: dict[str, Any]) -> dict[str, Any]:
    plan = conn.execute("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, args).fetchone()[0][0]
    nodes, stack = [], [plan["Plan"]]
    while stack:
        node = stack.pop()
        nodes.append(node["Node Type"] + (f" on {node['Index Name']}" if node.get("Index Name") else ""))
        stack.extend(node.get("Plans", []))
    return {"planning_ms": round(plan["Planning Time"], 3), "execution_ms": round(plan["Execution Time"], 3), "nodes": nodes}


def timed(fn, runs: int = 5) -> dict[str, float]:
    samples = []
    for _ in range(runs):
        started = time.perf_counter()
        fn()
        samples.append((time.perf_counter() - started) * 1000)
    return {"median_ms": round(statistics.median(samples), 1), "min_ms": round(min(samples), 1), "max_ms": round(max(samples), 1)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", help="also write the numbers to this file")
    args = parser.parse_args(argv)
    env = load_env()
    reader = env["DATABASE_URL_READER"]
    out: dict[str, Any] = {}

    neon = NeonAPI(env["NEON_API_KEY"], env["NEON_PROJECT_ID"])
    project = neon.project()
    branches = neon.branches()
    out["project"] = {
        "pg_version": project["pg_version"],
        "region": project["region_id"],
        "history_retention_s": project.get("history_retention_seconds"),
        "synthetic_storage_bytes": project.get("synthetic_storage_size"),
    }
    out["branches"] = [
        {
            "name": b["name"],
            "id": b["id"],
            "parent_id": b.get("parent_id"),
            "logical_bytes": b.get("logical_size"),
            "default": b.get("default", False),
        }
        for b in sorted(branches, key=lambda b: b["created_at"])
    ]
    neon.close()

    prod = PostgresRepository(reader, migrate=False)
    out["production_rows"] = prod.corpus_counts()
    with psycopg.connect(env["DATABASE_URL"], connect_timeout=20) as owner:  # counts of the private tables, as the owner
        out["production_rows"].update(
            {t: owner.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in ("sealed_shares", "pending_actions", "audit_log")}
        )
        out["production_rows"]["law_versions"] = owner.execute("SELECT count(*) FROM law_versions").fetchone()[0]
        out["production_rows"]["law_version_files"] = owner.execute("SELECT count(*) FROM law_version_files").fetchone()[0]
    law = LawService(prod, neon_opener(reader))
    versions = law.versions()
    out["versions"] = [
        {k: v[k] for k in ("name", "seq", "branch_id", "parent", "jurisdictions", "rules", "sources", "load_ms")} for v in versions
    ]
    mi_sha = law.files(versions[-1]["name"])["MI"]["verified_sha256"]

    args_for = {"q": "forensic examination", "st": "MI", "sha": mi_sha}
    out["explain"] = {}
    with psycopg.connect(reader, connect_timeout=20, prepare_threshold=None) as conn:
        for name, sql in QUERIES.items():
            if name == "one state's rules for a diff":
                continue
            explain(conn, sql, args_for)  # warm the cache once
            out["explain"][f"production: {name}"] = explain(conn, sql, args_for)
    newest = versions[-1]
    with psycopg.connect(with_host(reader, newest["endpoint_host"]), connect_timeout=30, prepare_threshold=None) as conn:
        sql = QUERIES["one state's rules for a diff"]
        explain(conn, sql, args_for)
        out["explain"][f"{newest['name']}: one state's rules for a diff"] = explain(conn, sql, args_for)
        out["explain"][f"{newest['name']}: quote search, one state"] = explain(conn, QUERIES["quote search, one state"], args_for)

    # From here: what a request costs end to end, network included.
    out["from_here"] = {}
    names = [v["name"] for v in versions]
    pairs = list(zip(names, names[1:], strict=False))
    moved = next(p for p in pairs if law.files(p[0])["MI"]["verified_sha256"] != law.files(p[1])["MI"]["verified_sha256"])
    still = next((p for p in pairs if law.files(p[0])["MI"] == {**law.files(p[1])["MI"], "version": p[0]}), None)
    started = time.perf_counter()
    first = law.diff(*moved, "MI")
    out["from_here"][f"diff MI {moved[0][-7:]} to {moved[1][-7:]}, first call (opens both branches, checks them, reads them)"] = round(
        (time.perf_counter() - started) * 1000, 1
    )
    out["from_here"]["the same diff again (from memory)"] = timed(lambda: law.diff(*moved, "MI"))
    if still:
        started = time.perf_counter()
        law.diff(*still, "MI")
        out["from_here"][f"diff MI {still[0][-7:]} to {still[1][-7:]}, files unchanged (index only)"] = round(
            (time.perf_counter() - started) * 1000, 1
        )
    started = time.perf_counter()
    law.diff(versions[0]["name"], versions[-1]["name"])
    out["from_here"]["diff all states, first vs newest, first call"] = round((time.perf_counter() - started) * 1000, 1)
    out["from_here"]["quote search MI (production)"] = timed(lambda: prod.law_search("forensic examination", "MI", 20))
    out["from_here"]["quote search all states (production)"] = timed(lambda: prod.law_search("forensic examination", None, 20))
    out["from_here"]["quote search MI on the oldest version's branch"] = timed(
        lambda: law.search("forensic examination", "MI", 20, version=versions[0]["name"])
    )
    out["from_here"]["version index"] = timed(lambda: prod.law_versions())
    out["diff_counts_measured_pair_MI"] = {"pair": list(moved), **first["counts"]}
    law.close()
    prod.close()

    for key, value in out.items():
        print(f"\n{key}:")
        print(json.dumps(value, indent=1, default=str))
    if args.json:
        with open(args.json, "w") as f:
            json.dump(out, f, indent=1, default=str)
    return 0


if __name__ == "__main__":
    sys.exit(main())
