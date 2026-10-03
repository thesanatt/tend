"""docs/PRIVACY.md on the server side: sealed shares, an audit log without names, nothing else kept."""

from __future__ import annotations

import base64
import json
import os
import sqlite3

import pytest
from helpers import CHECKING, client_for, confirm_all, from_b64url, make_services, scan_rowan

from tend_api.bank import BankError
from tend_api.db import MAX_SHARE_BYTES
from tend_api.db.sqlite import SQLiteRepository

RAW = os.urandom(512)
CIPHERTEXT = base64.b64encode(RAW).decode()
IV_RAW = os.urandom(12)
IV = base64.b64encode(IV_RAW).decode()


def seal(client, **extra):
    r = client.post("/api/shares", json={"ciphertext": CIPHERTEXT, "iv": IV, **extra})
    assert r.status_code == 201, r.text
    return r.json()


def stored_shares(services) -> list[tuple]:
    conn = sqlite3.connect(services.settings.database_url)
    rows = conn.execute("SELECT * FROM sealed_shares").fetchall()
    conn.close()
    return rows


def test_sealed_share_returns_exactly_the_ciphertext(client, services):
    link = seal(client)
    assert set(link) >= {"id", "created_at", "expires_at", "once", "api_path"} and len(link["id"]) >= 22
    assert link["expires_at"] == "2026-10-06T18:00:00.000000Z"  # 72 hours by default
    view = client.get(link["api_path"]).json()
    assert view == {
        "id": link["id"],
        "alg": "AES-256-GCM",
        "encoding": "base64url",
        "ciphertext": base64.urlsafe_b64encode(RAW).decode().rstrip("="),
        "iv": base64.urlsafe_b64encode(IV_RAW).decode().rstrip("="),
        "created_at": link["created_at"],
        "expires_at": link["expires_at"],
        "once": False,
    }
    assert from_b64url(view["ciphertext"]) == RAW and from_b64url(view["iv"]) == IV_RAW
    # The server keeps the ciphertext bytes, the IV, and timestamps: nothing it could read.
    [row] = stored_shares(services)
    assert RAW in row and "key" not in json.dumps([str(c) for c in row]).lower()


def test_url_safe_base64_and_aliases_are_accepted(client):
    urlsafe = base64.urlsafe_b64encode(RAW).decode().rstrip("=")
    r = client.post("/api/shares", json={"ciphertext": urlsafe, "nonce": IV, "ttl_hours": 1, "open_once": True})
    assert r.status_code == 201, r.text
    assert r.json()["once"] is True
    assert from_b64url(client.get(r.json()["api_path"]).json()["ciphertext"]) == RAW


def test_an_opened_share_reads_with_the_browser_decoder(client):
    # web/lib/share seals with base64url and opens with a decoder that refuses "+", "/", and "=".
    # These bytes encode to all three in standard base64, which every real ciphertext nearly always does.
    raw = b"\xfb\xef\xff" * 300 + b"\x01"
    assert {"+", "/", "="} <= set(base64.b64encode(raw).decode())
    sealed = client.post("/api/shares", json={"ciphertext": base64.urlsafe_b64encode(raw).decode().rstrip("="), "iv": IV}).json()
    view = client.get(sealed["api_path"]).json()
    assert not {"+", "/", "="} & set(view["ciphertext"] + view["iv"])
    assert view["encoding"] == "base64url"
    assert from_b64url(view["ciphertext"]) == raw and from_b64url(view["iv"]) == IV_RAW


def test_open_once_share_gives_up_its_ciphertext_on_first_read(client, services):
    link = seal(client, once=True)
    assert client.get(link["api_path"]).status_code == 200
    [row] = stored_shares(services)
    assert row[1] is None and row[2] is None  # ciphertext and IV are gone; only the tombstone remains
    second = client.get(link["api_path"])
    assert second.status_code == 410 and "opened once" in second.json()["detail"]


def test_share_expires_and_can_be_deleted(client, clock, services):
    link = seal(client, expires_hours=1)
    other = seal(client)
    clock.advance(hours=1)
    assert client.get(link["api_path"]).status_code == 410
    assert client.delete(other["api_path"]).status_code == 204
    assert client.get(other["api_path"]).status_code == 404
    assert client.delete(other["api_path"]).status_code == 404
    clock.advance(hours=100)
    seal(client)  # each new share sweeps the expired ones away
    assert len(stored_shares(services)) == 1


@pytest.mark.parametrize(
    "body",
    [
        {"ciphertext": CIPHERTEXT},  # no IV
        {"ciphertext": "not base64!!", "iv": IV},
        {"ciphertext": CIPHERTEXT, "iv": IV, "alg": "ROT13"},
        {"ciphertext": CIPHERTEXT, "iv": IV, "key": "never sent"},
        {"ciphertext": CIPHERTEXT, "iv": IV, "expires_hours": 0},
        {"ciphertext": CIPHERTEXT, "iv": IV, "expires_hours": 169},
        {"ciphertext": CIPHERTEXT, "iv": IV, "packet": {"st": "MI"}},  # plaintext never has a place to go
    ],
)
def test_share_validation(client, body):
    assert client.post("/api/shares", json=body).status_code == 422


def test_share_size_limit_and_iv_length(client):
    # 413, never 422: web/lib/share turns 413 into "This claim is too large to share as a link."
    for size in (MAX_SHARE_BYTES + 1, 3 * MAX_SHARE_BYTES):
        big = base64.urlsafe_b64encode(b"\0" * size).decode().rstrip("=")
        r = client.post("/api/shares", json={"ciphertext": big, "iv": IV})
        assert r.status_code == 413 and "too large" in r.json()["detail"], size
    exact = base64.b64encode(b"\1" * MAX_SHARE_BYTES).decode()
    assert client.post("/api/shares", json={"ciphertext": exact, "iv": IV}).status_code == 201
    eight = base64.b64encode(os.urandom(8)).decode() + "AAAA"
    assert client.post("/api/shares", json={"ciphertext": CIPHERTEXT, "iv": eight}).status_code == 422


def test_unknown_share_is_404_and_bad_ids_422(client):
    assert client.get("/api/shares/" + "a" * 22).status_code == 404
    assert client.get("/api/shares/short").status_code == 422


def test_audit_log_holds_no_names(client):
    proposal = client.post(
        "/api/actions/propose", json={"from": CHECKING, "payee": "Riverbend General Hospital", "amount_cents": 11800}
    ).json()
    client.post("/api/actions/confirm", json={"action_id": proposal["action_id"], "confirm_code": proposal["confirm_code"]})
    rows = client.get("/api/audit").json()["rows"]
    text = json.dumps(rows)
    assert "Riverbend" not in text and CHECKING not in text
    tags = {(r["data"]["payee_tag"], r["data"]["from_tag"]) for r in rows if "payee_tag" in r["data"]}
    assert len(tags) == 1 and all(len(t) == 32 for t in next(iter(tags)))


class EchoingBank:
    """Fails the way Nessie can: the error text echoes the request, payee and all."""

    mode = "dry_run"
    whole_dollars = False

    def withdraw(self, account_id, amount_cents, description, on_date):
        raise BankError(f"Nessie POST -> 400: {description}") from ValueError("rejected")

    def read_withdrawal(self, withdrawal_id):
        raise AssertionError("not reached")

    def find_withdrawal(self, account_id, marker):
        return None


def test_failed_payment_keeps_only_the_kind_of_error(settings, clock):
    services = make_services(settings, clock, banks={"dry_run": EchoingBank()})
    client = client_for(services)
    proposal = client.post(
        "/api/actions/propose", json={"from": "acct-1", "payee": "Riverbend General Hospital", "amount_cents": 500}
    ).json()
    r = client.post("/api/actions/confirm", json={"action_id": proposal["action_id"], "confirm_code": proposal["confirm_code"]})
    assert r.status_code == 502 and "Riverbend" in r.json()["detail"]  # the person sees it once, in the response
    rows = client.get("/api/audit").json()["rows"]
    assert rows[-1]["event"] == "failed" and rows[-1]["data"]["error_kind"] == "ValueError"
    assert "Riverbend" not in json.dumps(rows)
    assert "Riverbend" not in str(services.repo.get_action(proposal["action_id"]))


def test_claims_scans_and_packets_leave_nothing_behind(client, services):
    body = confirm_all(scan_rowan(client)["engine_input"])
    assert client.post("/api/claim", json=body).status_code == 200
    r = client.post("/api/packet", json=body)
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    conn = sqlite3.connect(services.settings.database_url)
    counts = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("sealed_shares", "pending_actions", "audit_log")}
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    conn.close()
    assert counts == {"sealed_shares": 0, "pending_actions": 0, "audit_log": 0}
    assert not {"claims", "scans", "evidence", "shares"} & tables


def test_a_database_from_the_first_api_loses_its_stored_claims(tmp_path):
    path = tmp_path / "old.sqlite3"
    conn = sqlite3.connect(path)
    conn.executescript(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
        "CREATE TABLE claims (claim_id TEXT PRIMARY KEY, input_json TEXT NOT NULL);"
        "CREATE TABLE scans (scan_id TEXT PRIMARY KEY);"
        "CREATE TABLE shares (token_hash TEXT PRIMARY KEY, claim_id TEXT);"
        "INSERT INTO claims VALUES ('clm_1', '{\"items\": [\"counseling\"]}');"
    )
    conn.close()
    repo = SQLiteRepository(str(path))
    tables = {r["name"] for r in repo._all("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert not {"claims", "scans", "shares"} & tables
    assert {"sealed_shares", "pending_actions", "audit_log", "rules"} <= tables
    repo.close()
    assert SQLiteRepository(str(path)).migrate() == []  # the second start has nothing to do
