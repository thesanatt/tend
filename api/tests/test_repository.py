"""The Repository contract, run against SQLite always and against Neon with TEND_NEON_TEST=1.

The Neon run uses a throwaway schema (tend_test_<random>) on the real database and drops it after,
so it never touches the tables the API serves from.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path

import pytest
from dotenv import dotenv_values
from helpers import FIXTURES

from tend_api.config import REPO_ROOT
from tend_api.db import GENESIS_HASH, CorpusBundle, read_bundles, verify_chain
from tend_api.db.base import audit_body
from tend_api.db.sqlite import SQLiteRepository

NOW = "2026-10-03T18:00:00.000000Z"
LATER = "2026-10-03T18:10:00.000000Z"
TOMORROW = "2026-10-04T18:00:00.000000Z"


def neon_env() -> dict[str, str]:
    path = Path(os.environ.get("TEND_ENV_FILE") or REPO_ROOT.parent / ".env")
    if not path.is_file():
        path = next((d / ".env" for d in (REPO_ROOT, *REPO_ROOT.parents) if (d / ".env").is_file()), path)
    return {k: v for k, v in dotenv_values(path).items() if v} if path.is_file() else {}


NEON = os.environ.get("TEND_NEON_TEST") == "1"
BACKENDS = [
    "sqlite",
    pytest.param("neon", marks=[pytest.mark.live, pytest.mark.skipif(not NEON, reason="set TEND_NEON_TEST=1 to run against Neon")]),
]


@pytest.fixture(params=BACKENDS)
def repo(request, tmp_path):
    if request.param == "sqlite":
        r = SQLiteRepository(str(tmp_path / "repo.sqlite3"))
        yield r
        r.close()
        return
    from tend_api.db.postgres import PostgresRepository

    env = neon_env()
    url = env.get("DATABASE_URL_POOLED") or env.get("DATABASE_URL")
    if not url:
        pytest.skip("no DATABASE_URL in the .env file")
    r = PostgresRepository(url, schema=f"tend_test_{secrets.token_hex(4)}", migrate_url=env.get("DATABASE_URL"))
    try:
        yield r
    finally:
        r.drop_schema()
        r.close()


def raw(repo, sql: str, args: tuple = ()) -> None:
    """Run SQL as someone with database access would, bypassing the repository's own checks."""
    if repo.backend == "postgres":
        sql = sql.replace("?", "%s")
    with repo._tx() as c:
        c.execute(sql, args)


def fixture_bundles(images: bool = False) -> list[CorpusBundle]:
    image = {"image_sha256": "c" * 64, "engine_version": "test 1.2.0", "bytes": 1234}
    return read_bundles(FIXTURES / "rules", None, None, (lambda st: [image]) if images else None)


def test_migrations_run_once(repo):
    assert repo.migrate() == []
    assert repo.ping()["ok"] is True


def test_corpus_loads_once_and_reloads_on_change(repo):
    first = repo.load_corpus(fixture_bundles(images=True))
    assert first["loaded"] == ["MI", "WI"] and first["unchanged"] == []
    assert first["counts"] == {"categories": 19, "jurisdictions": 2, "sources": 25, "rules": 84, "law_images": 2}
    again = repo.load_corpus(fixture_bundles(images=True))
    assert again["loaded"] == [] and again["unchanged"] == ["MI", "WI"] and again["counts"]["law_images"] == 2
    forced = repo.load_corpus(fixture_bundles(), force=True)
    assert forced["loaded"] == ["MI", "WI"] and forced["counts"]["rules"] == 84
    assert set(repo.corpus_hashes()) == {"MI", "WI"}
    mi = repo.jurisdiction("MI")
    assert mi["name"] == "Michigan" and mi["program"]["phone"] == "877-251-7373" and mi["rule_count"] == 48
    [image] = repo.law_images("MI")
    assert image["image_sha256"] == "c" * 64 and image["engine_version"] == "test 1.2.0"


def test_full_text_search_stems_and_filters(repo):
    repo.load_corpus(fixture_bundles())
    hits = repo.search_rules(["counsel"], "MI", 10)  # a stem finds "counseling"
    assert hits and {h["st"] for h in hits} == {"MI"}
    assert "MI-COV-2" in {h["id"] for h in hits}
    assert all(h["score"] > 0 and h["quote"] and h["source_sha256"] for h in hits)
    assert [h["score"] for h in hits] == sorted((h["score"] for h in hits), reverse=True)
    both = repo.search_rules(["counseling"], None, 50)
    assert {h["st"] for h in both} == {"MI", "WI"}
    assert repo.search_rules(["zzzqqq"], "MI", 10) == []
    phone = repo.search_rules(["phone"], "MI", 5)
    assert phone[0]["id"] == "MI-EXCL-1"


def test_rules_by_category_and_sources(repo):
    repo.load_corpus(fixture_bundles())
    deadlines = repo.rules_where("MI", ["filing_deadline"], [])
    assert [r["id"] for r in deadlines] == ["MI-FILE-1", "MI-FILE-2", "MI-FILE-3"]
    counseling = repo.rules_where("MI", [], ["counseling"])
    assert counseling and all(r["expense"] == "counseling" for r in counseling)
    assert repo.rules_where("MI", [], []) == []
    source = repo.source("MI", deadlines[0]["source_id"])
    assert source["sha256"] and source["url"].startswith("https://")


def test_open_once_share(repo):
    repo.insert_share({"id": "a" * 22, "ciphertext": b"x" * 40, "iv": b"y" * 12, "once": True, "created_at": NOW, "expires_at": TOMORROW})
    state, row = repo.open_share("a" * 22, LATER)
    assert state == "ok" and bytes(row["ciphertext"]) == b"x" * 40 and bytes(row["iv"]) == b"y" * 12
    assert repo.open_share("a" * 22, LATER) == ("opened", None)
    assert repo.open_share("b" * 22, LATER) == ("missing", None)


def test_share_expiry_delete_and_sweep(repo):
    for sid in ("c" * 22, "d" * 22, "e" * 22):
        repo.insert_share({"id": sid, "ciphertext": b"z" * 20, "iv": b"i" * 12, "once": False, "created_at": NOW, "expires_at": LATER})
    assert repo.open_share("c" * 22, NOW)[0] == "ok"
    assert repo.open_share("c" * 22, LATER) == ("expired", None)
    assert repo.open_share("c" * 22, NOW) == ("missing", None)  # expiring removed it
    assert repo.delete_share("d" * 22) is True and repo.delete_share("d" * 22) is False
    assert repo.sweep(TOMORROW)["shares"] == 1


def action(action_id: str = "act_" + "1" * 20, **over) -> dict:
    return {
        "action_id": action_id,
        "status": "proposed",
        "amount_cents": 11800,
        "from_account": "acct-1",
        "payee": "Riverbend",
        "payee_tag": "t" * 32,
        "code_mac": "m" * 64,
        "channel": "app",
        "dry_run": True,
        "bill_id": None,
        "item_ids": ["bill:x:1"],
        "created_at": NOW,
        "expires_at": LATER,
        **over,
    }


def test_actions_change_status_only_by_compare_and_set(repo):
    repo.insert_action(action())
    got = repo.get_action("act_" + "1" * 20)
    assert got["amount_cents"] == 11800 and got["item_ids"] == ["bill:x:1"] and got["dry_run"] is True and got["payee"] == "Riverbend"
    assert repo.transition_action(got["action_id"], "proposed", "executing", {"confirmed_at": NOW}, not_expired_at=NOW) is True
    assert repo.transition_action(got["action_id"], "proposed", "executing", {}) is False  # someone else already moved it
    readback = {"ok": True, "checks": {"amount": True}, "status": "completed"}
    assert repo.transition_action(got["action_id"], "executing", "done", {"finished_at": NOW, "withdrawal_id": "w-1", "readback": readback})
    done = repo.get_action(got["action_id"])
    assert done["status"] == "done" and done["payee"] is None and done["readback"] == readback and done["withdrawal_id"] == "w-1"
    with pytest.raises(ValueError):
        repo.transition_action(got["action_id"], "done", "done", {"amount_cents": 1})


def test_an_expired_action_cannot_start(repo):
    repo.insert_action(action("act_" + "2" * 20))
    assert repo.transition_action("act_" + "2" * 20, "proposed", "executing", {}, not_expired_at=LATER) is False


def test_wrong_codes_lock_the_action(repo):
    repo.insert_action(action("act_" + "3" * 20))
    assert [repo.count_failed_attempt("act_" + "3" * 20, 3) for _ in range(3)] == [1, 2, 3]
    locked = repo.get_action("act_" + "3" * 20)
    assert locked["status"] == "locked" and locked["payee"] is None


def test_sweep_expires_waiting_actions_and_drops_old_ones(repo):
    repo.insert_action(action("act_" + "4" * 20))
    assert repo.sweep(LATER)["expired_actions"] == 1
    gone = repo.get_action("act_" + "4" * 20)
    assert gone["status"] == "expired" and gone["payee"] is None
    assert repo.sweep("2026-10-05T18:00:00.000000Z")["dropped_actions"] == 1
    assert repo.get_action("act_" + "4" * 20) is None


def test_audit_log_is_a_hash_chain(repo):
    rows = [repo.append_audit("confirmed" if i % 2 == 0 else "executed", f"act_{i:020x}", {"amount_cents": 100 * i}, NOW) for i in range(4)]
    assert rows[0]["prev_hash"] == GENESIS_HASH and all(rows[i]["prev_hash"] == rows[i - 1]["hash"] for i in range(1, 4))
    stored = repo.audit_rows()
    assert verify_chain(stored) == {"ok": True, "rows": 4, "head": rows[-1]["hash"]}
    assert [r["seq"] for r in repo.audit_rows("act_" + f"{2:020x}")] == [3]
    # Both backends compute the same chain for the same events: the hash covers canonical JSON only.
    body, digest = audit_body(1, NOW, "confirmed", f"act_{0:020x}", {"amount_cents": 0}, GENESIS_HASH)
    assert digest == rows[0]["hash"]


def test_audit_log_refuses_edits_deletes_and_forged_rows(repo):
    repo.append_audit("confirmed", "act_" + "5" * 20, {"amount_cents": 100}, NOW)
    head = repo.audit_rows()[-1]
    with pytest.raises(Exception, match="append-only"):
        raw(repo, "UPDATE audit_log SET event = 'failed'")
    with pytest.raises(Exception, match="append-only"):
        raw(repo, "DELETE FROM audit_log")
    with pytest.raises(Exception, match="audit_log"):
        # A row that does not name the current head cannot join the chain.
        body, digest = audit_body(2, NOW, "executed", "act_x", {}, "1" * 64)
        raw(
            repo,
            "INSERT INTO audit_log (seq, ts, event, action_id, body, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (2, NOW, "executed", "act_x", body, "1" * 64, digest),
        )
    if repo.backend == "postgres":
        # Neon also recomputes sha256(body) in the trigger, so a row with the right links but a made-up hash fails too.
        body, _ = audit_body(2, NOW, "executed", "act_x", {}, head["hash"])
        with pytest.raises(Exception, match="sha256"):
            raw(
                repo,
                "INSERT INTO audit_log (seq, ts, event, action_id, body, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (2, NOW, "executed", "act_x", body, head["hash"], "f" * 64),
            )
    assert verify_chain(repo.audit_rows())["ok"] is True


def test_the_secret_is_made_once(repo):
    first = repo.secret()
    assert len(first) == 32 and repo.secret() == first
