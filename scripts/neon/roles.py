"""Least privilege in Neon: create the tend_reader and tend_app roles, grant each exactly what it needs, and prove it.

usage (from the repo root):
  cd api && uv run python ../scripts/neon/roles.py           # create what is missing, grant, then check
  cd api && uv run python ../scripts/neon/roles.py --check   # only run the privilege checks
  cd api && uv run python ../scripts/neon/roles.py --rotate  # new passwords (then update every place that holds them)

A role that does not exist yet gets a random 256-bit password, and its pooled URL is appended to the .env file as
DATABASE_URL_READER or DATABASE_URL_APP. Passwords are never printed. Law branches published after this point carry
both roles with the same passwords (a branch copies the roles of its parent).
"""

from __future__ import annotations

import argparse
import sys

import psycopg
from neonenv import append_env, ensure_law_tables, load_env, replace_env

from tend_api.db.roles import APP, READER, apply_grants, ensure_role, existing_roles, new_password, privilege_matrix, role_url

ENV_KEYS = {READER: "DATABASE_URL_READER", APP: "DATABASE_URL_APP"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="only run the privilege checks")
    parser.add_argument("--rotate", action="store_true", help="give both roles new passwords")
    args = parser.parse_args(argv)

    env = load_env()
    owner, pooled = env.get("DATABASE_URL"), env.get("DATABASE_URL_POOLED") or env.get("DATABASE_URL")
    if not owner:
        raise SystemExit("DATABASE_URL (the owner) is needed")

    if not args.check:
        # The law version index and quote search first, so the grants name them.
        created = ensure_law_tables(owner)
        print(f"law version index and quote search: {'created ' + ', '.join(created) if created else 'already there'}")
        with psycopg.connect(owner, connect_timeout=20, autocommit=True) as conn:
            present = existing_roles(conn)
            for role in (READER, APP):
                key = ENV_KEYS[role]
                need = args.rotate or role not in present or key not in env
                if not need:
                    print(f"{role}: exists, and {key} is in the .env file")
                    continue
                if key in env and not args.rotate:
                    raise SystemExit(f"{key} is in the .env file but {role} is missing; remove {key} and run again")
                password = new_password()
                created = ensure_role(conn, role, password)
                if key in env:
                    replace_env(key, role_url(pooled, role, password))
                    print(f"{role}: password rotated and {key} replaced in the .env file; update it wherever it is deployed")
                    continue
                append_env(key, role_url(pooled, role, password))
                print(f"{role}: {'created' if created else 'password set'}; {key} added to the .env file")
            # Role settings are applied even when nothing else changed, so a rerun repairs them.
            for role in (READER, APP):
                ensure_role(conn, role, None)
            granted = apply_grants(conn, "public")
            print(f"grants applied for: {', '.join(granted) or 'nobody (roles missing)'}")
        env = load_env()

    urls = {role: env[key] for role, key in ENV_KEYS.items() if key in env}
    if len(urls) < 2:
        raise SystemExit("both DATABASE_URL_READER and DATABASE_URL_APP are needed for the check")
    rows = privilege_matrix(urls)
    wrong = [r for r in rows if r["allowed"] != r["expected"]]
    width = max(len(r["check"]) for r in rows)
    print(f"\n{'check':<{width}}  {READER:<12} {APP:<12}")
    for name in dict.fromkeys(r["check"] for r in rows):
        cells = []
        for role in (READER, APP):
            r = next(x for x in rows if x["role"] == role and x["check"] == name)
            mark = "allowed" if r["allowed"] else "refused"
            cells.append(f"{mark + ('' if r['allowed'] == r['expected'] else ' (!)'):<12}")
        print(f"{name:<{width}}  {' '.join(cells)}")
    print(f"\n{len(rows) - len(wrong)} of {len(rows)} checks as expected")
    return 1 if wrong else 0


if __name__ == "__main__":
    sys.exit(main())
