"""docs/PRIVACY.md on the server side: sealed shares, an audit log without names, packets that leave no trace."""

from __future__ import annotations

import base64
import json
import os
import sqlite3

import pytest
from helpers import client_for, confirm_all, make_services, scan_rowan

from tend_api.bank import BankError
from tend_api.storage import SQLiteRepository

CIPHERTEXT = base64.b64encode(os.urandom(512)).decode()
NONCE = base64.b64encode(os.urandom(12)).decode()


def seal(client, **extra):
    r = client.post("/api/share", json={"ciphertext": CIPHERTEXT, "nonce": NONCE, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def test_sealed_share_returns_exactly_the_ciphertext(client, services):
    link = seal(client)
    assert link["sealed"] is True and link["path"] == f"/share/{link['token']}"
    view = client.get(link["api_path"]).json()
    assert view == {
        "token": link["token"],
        "sealed": True,
        "read_only": True,
        "alg": "AES-256-GCM",
        "nonce": NONCE,
        "ciphertext": CIPHERTEXT,
        "open_once": False,
        "created_at": view["created_at"],
        "expires_at": link["expires_at"],
    }
    # The server keeps the ciphertext, the nonce, and a hash of the token; nothing it could read.
    conn = sqlite3.connect(services.settings.db_path)
    rows = conn.execute("SELECT * FROM sealed_shares").fetchall()
    assert len(rows) == 1 and link["token"] not in json.dumps(rows)
    assert conn.execute("SELECT COUNT(*) FROM claims").fetchone()[0] == 0
    conn.close()


def test_sealed_share_can_open_once(client):
    link = seal(client, open_once=True)
    assert client.get(f"{link['api_path']}/packet.pdf").status_code == 409  # checking for a packet does not use it up
    assert client.get(link["api_path"]).status_code == 200
    second = client.get(link["api_path"])
    assert second.status_code == 410 and "opened once" in second.json()["detail"]


def test_sealed_share_expires_and_can_be_turned_off(client, clock):
    link = seal(client, ttl_hours=1)
    other = seal(client)
    clock.advance(hours=1)
    assert client.get(link["api_path"]).status_code == 410
    assert client.delete(other["api_path"]).status_code == 204
    assert client.get(other["api_path"]).status_code == 410


@pytest.mark.parametrize(
    "body",
    [
        {"ciphertext": CIPHERTEXT},  # no nonce
        {"ciphertext": "not base64!!", "nonce": NONCE},
        {"ciphertext": CIPHERTEXT, "nonce": NONCE, "alg": "ROT13"},
        {"ciphertext": CIPHERTEXT, "nonce": NONCE, "claim_id": "clm_x"},
        {"claim_id": "clm_x", "open_once": True},
    ],
)
def test_sealed_share_validation(client, body):
    assert client.post("/api/share", json=body).status_code == 422


def test_audit_log_holds_no_names(client):
    proposal = client.post(
        "/api/actions/propose", json={"from": "acct-checking-0001", "payee": "Riverbend General Hospital", "amount_cents": 11800}
    ).json()
    client.post("/api/actions/confirm", json={"action_id": proposal["action_id"], "confirm_code": proposal["confirm_code"]})
    rows = client.get("/api/audit").json()["rows"]
    text = json.dumps(rows)
    assert "Riverbend" not in text and "acct-checking-0001" not in text
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


def test_failed_payment_log_drops_the_bank_error_text(settings, clock):
    client = client_for(make_services(settings, clock, banks={"dry_run": EchoingBank()}))
    proposal = client.post(
        "/api/actions/propose", json={"from": "acct-1", "payee": "Riverbend General Hospital", "amount_cents": 500}
    ).json()
    assert (
        client.post("/api/actions/confirm", json={"action_id": proposal["action_id"], "confirm_code": proposal["confirm_code"]}).status_code
        == 502
    )
    rows = client.get("/api/audit").json()["rows"]
    assert rows[-1]["event"] == "failed" and rows[-1]["data"]["error_kind"] == "ValueError"
    assert "Riverbend" not in json.dumps(rows)


def test_packet_without_storing_leaves_no_claim(client, services):
    body = confirm_all(scan_rowan(client)["engine_input"])
    r = client.post("/api/packet", json=body)
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    conn = sqlite3.connect(services.settings.db_path)
    assert conn.execute("SELECT COUNT(*) FROM claims").fetchone()[0] == 0
    conn.close()


def test_database_from_an_earlier_schema_is_upgraded(tmp_path):
    path = tmp_path / "old.sqlite3"
    conn = sqlite3.connect(path)
    conn.executescript(
        "CREATE TABLE evidence (scan_id TEXT NOT NULL, item_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, date TEXT NOT NULL,"
        " source TEXT NOT NULL, PRIMARY KEY (scan_id, item_id));"
        "CREATE TABLE actions (action_id TEXT PRIMARY KEY, status TEXT NOT NULL, amount_cents INTEGER NOT NULL, from_account TEXT NOT NULL,"
        " payee TEXT NOT NULL, claim_id TEXT, item_id TEXT, code_mac TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,"
        " dry_run INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, confirmed_at TEXT, finished_at TEXT,"
        " nessie_id TEXT, readback_json TEXT, error TEXT);"
    )
    conn.close()
    repo = SQLiteRepository(str(path))
    repo.insert_action(
        {
            "action_id": "act_1",
            "status": "proposed",
            "amount_cents": 100,
            "from_account": "a",
            "payee": "p",
            "code_mac": "m",
            "channel": "agent",
            "bill_id": "b",
            "item_ids": ["x"],
            "dry_run": True,
            "created_at": "t",
            "expires_at": "t",
        }
    )
    action = repo.get_action("act_1")
    assert action["channel"] == "agent" and action["item_ids"] == ["x"]
