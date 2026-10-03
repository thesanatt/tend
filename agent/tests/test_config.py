from __future__ import annotations

import os
import stat

from tend_agent.config import Settings, ensure_seed, find_env_file, inspector_url, load_env


def test_seed_is_created_once_appended_and_never_printed(tmp_path, monkeypatch, capsys):
    env = tmp_path / ".env"
    env.write_text("NESSIE_API_KEY=abc")  # no trailing newline
    monkeypatch.delenv("AGENT_SEED", raising=False)
    assert ensure_seed(env) is True
    seed = os.environ["AGENT_SEED"]
    assert len(seed) == 64
    assert env.read_text() == f"NESSIE_API_KEY=abc\nAGENT_SEED={seed}\n"
    assert stat.S_IMODE(env.stat().st_mode) == 0o600
    assert ensure_seed(env) is False and env.read_text().count("AGENT_SEED=") == 1
    assert seed not in capsys.readouterr().out


def test_env_file_wins_over_the_shell(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("GEMINI_API_KEY=from-file\nTEND_API_URL=http://api.test/\n")
    monkeypatch.setenv("GEMINI_API_KEY", "stale-shell-value")
    monkeypatch.setenv("TEND_ENV_FILE", str(env))
    assert find_env_file() == env
    assert load_env() == env
    assert os.environ["GEMINI_API_KEY"] == "from-file"
    assert Settings.from_env().api_url == "http://api.test"
    monkeypatch.setenv("TEND_ENV_FILE", "")
    assert find_env_file() is None


def test_inspector_url():
    assert inspector_url("agent1qabc", 8001) == "https://agentverse.ai/inspect/?uri=http%3A//127.0.0.1%3A8001&address=agent1qabc"
