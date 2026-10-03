"""Search over the verified corpus, keeping the database in step with rules/, and the loader command."""

from __future__ import annotations

import dataclasses
import json
import shutil

import pytest
from helpers import FIXTURES, REPO, client_for, make_services

from tend_api import loader
from tend_api.db import CATEGORIES
from tend_api.search import parse_query


def test_categories_match_the_schema_contract():
    text = (REPO / "rules" / "SCHEMA.md").read_text()
    table = text.split("## Categories (`category`)")[1].split("## Expense types")[0]
    names = [line.split("`")[1] for line in table.splitlines() if line.startswith("| `")]
    assert names == list(CATEGORIES)


def test_search_finds_rules_with_their_proof(client):
    data = client.get("/api/rules/search", params={"q": "therapy sessions", "st": "mi"}).json()
    assert data["st"] == "MI" and data["backend"] == "sqlite" and data["count"] == len(data["results"]) > 0
    assert data["intents"]["expenses"] == ["counseling"]
    top = data["results"][0]
    assert top["expense"] == "counseling" and top["category"] in ("covered_expense", "expense_cap")
    for r in data["results"]:
        assert r["st"] == "MI" and r["quote"] and r["pinpoint"] and r["source_sha256"] and r["source_url"]
    assert [r["score"] for r in data["results"]] == sorted((r["score"] for r in data["results"]), reverse=True)


def test_search_across_states_and_limits(client):
    data = client.get("/api/rules/search", params={"q": "counseling", "limit": 3}).json()
    assert data["st"] is None and data["count"] == 3
    both = client.get("/api/rules/search", params={"q": "counseling", "limit": 50}).json()
    assert {r["st"] for r in both["results"]} == {"MI", "WI"}


def test_search_errors(client):
    assert client.get("/api/rules/search", params={"q": "x"}).status_code == 422
    assert client.get("/api/rules/search", params={"q": "deadline", "st": "ZZ"}).status_code == 404
    assert client.get("/api/rules/search", params={"q": "deadline", "limit": 0}).status_code == 422
    assert client.get("/api/rules/search", params={"q": "zzzz qqqq", "st": "MI"}).json()["count"] == 0


@pytest.mark.parametrize(
    "question, categories, expenses",
    [
        ("How long do I have to apply?", {"filing_deadline"}, set()),
        ("Do I need a police report if I had a rape kit?", {"reporting_requirement", "exam_no_bill", "exam_payment"}, {"forensic_exam"}),
        (
            "Will they pay for my Uber rides to therapy?",
            {"covered_expense", "excluded_expense", "expense_cap"},
            {"transportation", "counseling"},
        ),
        ("Is my new phone covered?", {"covered_expense", "excluded_expense", "expense_cap"}, {"property_replacement"}),
        ("What's the phone number for the program?", set(), set()),
    ],
)
def test_questions_become_intents(question, categories, expenses):
    q = parse_query(question)
    assert categories <= q.categories and q.expenses == expenses
    assert all(t.isascii() and t.isalnum() for t in q.terms)
    if "number" in question:
        assert q.contact is True and "property_replacement" not in q.expenses


def test_the_state_name_is_not_a_search_word():
    q = parse_query("How long do I have in Michigan?", drop={"michigan"})
    assert "michigan" not in q.terms and "michigan" not in q.own


def test_sqlite_follows_rules_on_disk(settings, clock, tmp_path):
    rules = tmp_path / "rules"
    shutil.copytree(FIXTURES / "rules", rules)
    moved = dataclasses.replace(settings, rules_dir=rules)
    client = client_for(make_services(moved, clock))
    assert client.get("/api/health").json()["corpus"]["stale"] == []
    doc = json.loads((rules / "MI.json").read_text())
    doc["rules"] = [r for r in doc["rules"] if r["id"] != "MI-EXCL-1"]
    (rules / "MI.json").write_text(json.dumps(doc))
    services = make_services(moved, clock)  # a restart loads what changed, and only that
    status = services.rulebook.status()
    assert status["stale"] == [] and status["rules"] == 83
    assert "MI-EXCL-1" not in {
        r["rule_id"] for r in client_for(services).get("/api/rules/search", params={"q": "phone", "st": "MI"}).json()["results"]
    }


def test_neon_is_never_loaded_behind_anyones_back(services):
    # Only an empty Postgres database is filled at startup; a loaded one waits for the loader command.
    class Repo:
        backend = "postgres"
        loads = 0

        def corpus_counts(self):
            return {"jurisdictions": 51}

        def load_corpus(self, *args, **kwargs):
            Repo.loads += 1

    from tend_api.services import autoload

    autoload(services.rulebook, Repo())
    assert Repo.loads == 0


def test_loader_command_on_sqlite(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("TEND_ENV_FILE", "")
    monkeypatch.setenv("TEND_RULES_DIR", str(FIXTURES / "rules"))
    monkeypatch.setenv("TEND_IR_DIR", str(tmp_path / "no-ir"))
    db = tmp_path / "loaded.sqlite3"
    assert loader.main(["--db", str(db), "--no-images"]) == 0
    out = capsys.readouterr().out
    assert "migrations applied now: 0001_corpus, 0002_shares, 0003_payments" in out
    assert "loaded 2 jurisdictions, unchanged 0" in out and "rules 84" in out and "stale after load: none" in out
    assert loader.main(["--db", str(db), "--no-images", "--states", "MI"]) == 0
    again = capsys.readouterr().out
    assert "migrations applied now: none" in again and "loaded 0 jurisdictions, unchanged 1" in again
    assert loader.main(["--db", str(db), "--no-images", "--states", "MI", "--force"]) == 0
    assert "loaded 1 jurisdictions" in capsys.readouterr().out
