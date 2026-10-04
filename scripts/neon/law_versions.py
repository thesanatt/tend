"""Publish each version of the law corpus as its own Neon branch, and compare versions.

usage (from the repo root):
  cd api && uv run python ../scripts/neon/law_versions.py publish              # the default versions, oldest first
  cd api && uv run python ../scripts/neon/law_versions.py publish --commits 52abf94,c8304df
  cd api && uv run python ../scripts/neon/law_versions.py list
  cd api && uv run python ../scripts/neon/law_versions.py diff --from law-2026-10-03-52abf94 --to law-2026-10-03-c959cb6 --st MI
  cd api && uv run python ../scripts/neon/law_versions.py snapshot             # the saved copy web/app/law/changes falls back to

A version is rules/verified and rules/ir exactly as committed at one git commit, named law-<date>-<short sha>.
The first version is a schema-only branch of production: it gets production's tables but none of its rows, so no
sealed share or payment record is ever copied into a law branch. Each later version is a child of the one before;
loading it rewrites only the states whose files changed, so Neon stores only the pages that changed. Each branch
records itself in its own law_versions table, and production's law_versions indexes them all. A published version
is never loaded again; run publish after a corpus change and the newest corpus commit becomes a new version.

Needs NEON_API_KEY and NEON_PROJECT_ID (branches), DATABASE_URL (the owner, to load), and, for the roles to exist
on the branches, scripts/neon/roles.py run first. Prints no passwords or keys.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

import psycopg
from neonenv import REPO, apply_ahead, bundles_at, commit_info, corpus_commits, load_env, url_password

from tend_api.db import bundle_hashes, corpus_sha256
from tend_api.db.base import migration_files
from tend_api.db.neon import NeonAPI, with_host
from tend_api.db.postgres import PostgresRepository
from tend_api.db.roles import APP, READER, apply_grants, ensure_role, existing_roles
from tend_api.law import LawService, neon_opener

# Why these: the first corpus with its law IR, then each enrichment commit. 3a2c64b (no IR yet) and 2fa60fb (replaced
# by c959cb6 21 seconds later) are left out. The newest commit that changed the corpus is always added.
DEFAULT_COMMITS = ("52abf94", "c8304df", "d83289a", "1e96ad5")
SNAPSHOT_DIR = REPO / "web" / "app" / "law" / "changes" / "data"


def owner_on(branch_host: str, env: dict[str, str]) -> str:
    return with_host(env["DATABASE_URL"], branch_host)


def prepare_root(conn: psycopg.Connection, env: dict[str, str]) -> list[str]:
    """A schema-only branch has the tables but no rows: record the migrations its schema already has, and make sure the
    two roles exist with production's passwords (so the API reads every branch with one URL)."""
    done = []
    for version, _, digest in migration_files("postgres"):
        conn.execute(
            "INSERT INTO schema_migrations (version, sha256) VALUES (%s, %s) ON CONFLICT (version) DO NOTHING", (version, digest)
        )
    present = existing_roles(conn)
    for role, key in ((READER, "DATABASE_URL_READER"), (APP, "DATABASE_URL_APP")):
        password = url_password(env[key]) if key in env else None
        if role not in present and password:
            ensure_role(conn, role, password)
            done.append(f"{role} created")
        elif role in present and password:
            ensure_role(conn, role, password)  # same password as production
            done.append(f"{role} password matched")
    return done


def resolve(commits: list[str]) -> list[dict[str, Any]]:
    infos = {}
    for ref in commits:
        info = commit_info(ref)
        infos[info["git_sha"]] = info
    order = {sha: i for i, sha in enumerate(corpus_commits())}
    missing = [i["name"] for sha, i in infos.items() if sha not in order]
    if missing:
        raise SystemExit(f"these commits did not change rules/verified or rules/ir: {', '.join(missing)}")
    return sorted(infos.values(), key=lambda i: order[i["git_sha"]])


def publish(args: argparse.Namespace) -> int:
    env = load_env()
    neon = NeonAPI(env.get("NEON_API_KEY", ""), env.get("NEON_PROJECT_ID", ""))
    prod_branch = neon.default_branch()
    ahead = apply_ahead(env["DATABASE_URL"])
    if ahead:
        print(f"production: created {', '.join(ahead)} (not recorded, so older API code keeps starting)")
    prod = PostgresRepository(env["DATABASE_URL"], migrate=False)
    published = {v["name"]: v for v in prod.law_versions()}
    wanted = [c.strip() for c in (args.commits.split(",") if args.commits else DEFAULT_COMMITS) if c.strip()]
    newest = corpus_commits()[-1]
    if not args.commits and newest not in wanted:
        wanted.append(newest)
    plan = resolve(wanted)
    order = {sha: i for i, sha in enumerate(corpus_commits())}
    chain = sorted(published.values(), key=lambda v: v["seq"])
    parent = chain[-1] if chain else None
    rows = []
    for info in plan:
        name = info["name"]
        if name in published:
            print(f"{name}: already published on {published[name]['branch_id']}")
            continue
        if parent and order[info["git_sha"]] < order.get(parent["git_sha"], -1):
            print(f"{name}: older than the newest published version ({parent['name']}); a version only branches forward, skipped")
            continue
        bundles = bundles_at(info["git_sha"])
        hashes = bundle_hashes(bundles)
        digest = corpus_sha256(hashes)
        if parent and digest == parent["corpus_sha256"]:
            print(f"{name}: same files as {parent['name']}, nothing to publish")
            continue

        started = time.monotonic()
        existing = neon.find_branch(name)
        if existing:  # a run that stopped after creating the branch: reuse it
            host = neon.read_write_host(existing["id"])
            branch_id, owner = existing["id"], owner_on(host, env)
            created_s = None
            print(f"{name}: branch {branch_id} exists from an earlier run; loading it")
        else:
            branch = (
                neon.create_branch(name, parent["branch_id"])
                if parent
                else neon.create_branch(name, prod_branch["id"], schema_only=True)
            )
            created_s = time.monotonic() - started
            branch_id, host = branch.id, branch.host
            owner = branch.owner_uri or owner_on(host, env)
            print(f"{name}: created {branch_id} ({'child of ' + parent['name'] if parent else 'schema-only root'}) in {created_s:.1f} s")

        with psycopg.connect(owner, connect_timeout=30, autocommit=True) as conn:
            setup = prepare_root(conn, env) if parent is None else []
            granted = apply_grants(conn, "public")
            roles = sorted(existing_roles(conn))
        if setup:
            print(f"  roles on the new root: {', '.join(setup)}")

        repo = PostgresRepository(owner, migrate=False)
        load_started = time.monotonic()
        result = repo.load_corpus(bundles)
        with repo._tx() as c:  # a state dropped from the corpus leaves the branch too
            gone = c.execute("DELETE FROM jurisdictions WHERE st <> ALL(%s)", (sorted(hashes),)).rowcount
        load_ms = round((time.monotonic() - load_started) * 1000)
        counts = repo.corpus_counts()
        row = {
            "name": name,
            "seq": (chain[-1]["seq"] + 1) if chain else 1,
            "git_sha": info["git_sha"],
            "committed_at": info["committed_at"],
            "subject": info["subject"],
            "parent": parent["name"] if parent else None,
            "branch_id": branch_id,
            "endpoint_host": host,
            "corpus_sha256": digest,
            "jurisdictions": counts["jurisdictions"],
            "rules": counts["rules"],
            "sources": counts["sources"],
            "load_ms": load_ms,
        }
        files = [
            {"st": b.st, "verified_sha256": b.verified_sha256, "ir_sha256": b.ir_sha256, "rule_count": len(b.verified.get("rules") or [])}
            for b in bundles
        ]
        held = corpus_sha256(repo.corpus_hashes())
        if held != digest:
            raise SystemExit(f"{name}: the branch holds a different corpus than {info['git_sha'][:7]}; not published")
        repo.register_law_version(row, files)  # the branch names itself
        repo.close()
        prod.register_law_version(row, files)  # and production indexes it
        print(
            f"  loaded {len(result['loaded'])} states ({len(result['unchanged'])} unchanged{', ' + str(gone) + ' removed' if gone else ''})"
            f" in {load_ms / 1000:.1f} s: {counts['rules']} rules, {counts['sources']} sources; roles {', '.join(roles) or 'none'}"
            f"{' (grants applied)' if granted else ''}"
        )
        rows.append({**row, "created_s": created_s, "loaded": len(result["loaded"]), "unchanged": len(result["unchanged"])})
        chain.append({**row, "committed_at": info["committed_at"]})
        parent = chain[-1]
    prod.close()
    neon.close()
    if args.report and rows:
        Path(args.report).write_text(json.dumps(rows, indent=1, default=str))
    return 0


def law_service(env: dict[str, str]) -> LawService:
    prod = PostgresRepository(env.get("DATABASE_URL_READER") or env["DATABASE_URL"], migrate=False)
    return LawService(prod, neon_opener(env.get("DATABASE_URL_READER") or env["DATABASE_URL"]))


def list_versions(_: argparse.Namespace) -> int:
    env = load_env()
    neon = NeonAPI(env.get("NEON_API_KEY", ""), env.get("NEON_PROJECT_ID", ""))
    branches = {b["id"]: b for b in neon.branches()}
    law = law_service(env)
    listing = law.listing()
    print(f"{len(listing['versions'])} published; production's corpus is {listing['current'] or 'not a published version'}")
    for v in listing["versions"]:
        b = branches.get(v["branch_id"], {})
        size = b.get("logical_size")
        print(
            f"{v['seq']}. {v['name']}  {v['branch_id']}  parent {v['parent'] or '(schema-only root)'}  {v['jurisdictions']} states,"
            f" {v['rules']} rules, {v['sources']} sources  loaded in {(v['load_ms'] or 0) / 1000:.1f} s"
            f"  logical size {round(size / 1048576, 1) if size else '?'} MB  {'current' if v['current'] else ''}"
        )
        print(f"   {v['subject']}")
    law.close()
    law.repo.close()
    neon.close()
    return 0


def diff(args: argparse.Namespace) -> int:
    env = load_env()
    law = law_service(env)
    started = time.monotonic()
    result = law.diff(args.from_, args.to, args.st)
    took = time.monotonic() - started
    print(f"{result['from']['name']} -> {result['to']['name']} ({result['read']}, {took:.2f} s)")
    if args.st:
        c = result["counts"]
        print(f"{args.st}: {c['added']} added, {c['removed']} removed, {c['changed']} changed; sources {c['sources_changed']} saved again")
        for r in result["added"][: args.show]:
            print(f"  + {r['rule_id']} {r['pinpoint']}: {r['quote'][:110]}")
        for r in result["removed"][: args.show]:
            print(f"  - {r['rule_id']} {r['pinpoint']}: {r['quote'][:110]}")
        for r in result["changed"][: args.show]:
            print(f"  ~ {r['rule_id']} ({', '.join(r['kinds'])}): {', '.join(r['fields'])}")
    else:
        t = result["totals"]
        print(f"{result['changed_states']} states changed: {t['added']} rules added, {t['removed']} removed, {t['changed']} changed")
    law.close()
    law.repo.close()
    return 0


def snapshot(args: argparse.Namespace) -> int:
    """The saved copy the public page falls back to when the API cannot be reached: the index, plus each state's diff
    for every pair of consecutive versions and for the first against the newest. Computed from the branches."""
    env = load_env()
    law = law_service(env)
    versions = law.versions()
    if len(versions) < 2:
        raise SystemExit("publish at least two versions first")
    names = [v["name"] for v in versions]
    pairs = [(a, b) for a, b in zip(names, names[1:], strict=False)]
    if (names[0], names[-1]) not in pairs:
        pairs.append((names[0], names[-1]))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    listing = law.listing()
    summaries = {f"{a}..{b}": law.diff(a, b) for a, b in pairs}
    states = sorted({s["st"] for d in summaries.values() for s in d["states"]})
    for st in states:
        doc = {"st": st, "pairs": {}}
        for a, b in pairs:
            d = law.diff(a, b, st)
            d.pop("ms", None)
            doc["pairs"][f"{a}..{b}"] = d
        (out / f"{st}.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n")
    for d in summaries.values():
        d.pop("ms", None)
    index = {
        "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "versions": listing["versions"],
        "current": listing["current"],
        "pairs": [f"{a}..{b}" for a, b in pairs],
        "summaries": summaries,
    }
    (out / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1) + "\n")
    total = sum(p.stat().st_size for p in out.glob("*.json"))
    print(f"wrote {len(states) + 1} files to {out} ({total / 1024:.0f} KB) for {len(pairs)} pairs")
    law.close()
    law.repo.close()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("publish", help="create a branch for each version not yet published")
    p.add_argument("--commits", help="comma-separated commits (default: the enrichment commits and the newest corpus commit)")
    p.add_argument("--report", help="write timings for the versions published now to this JSON file")
    p.set_defaults(func=publish)
    sub.add_parser("list", help="the published versions and their branches").set_defaults(func=list_versions)
    d = sub.add_parser("diff", help="compare two versions")
    d.add_argument("--from", dest="from_")
    d.add_argument("--to")
    d.add_argument("--st")
    d.add_argument("--show", type=int, default=8)
    d.set_defaults(func=diff)
    s = sub.add_parser("snapshot", help="save the diffs the public page falls back to")
    s.add_argument("--out", default=str(SNAPSHOT_DIR))
    s.set_defaults(func=snapshot)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
