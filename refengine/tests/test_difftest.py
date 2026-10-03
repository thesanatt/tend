"""difftest.py against stand-in engines: agreement, a planted bug, a crash, and no engine at all."""

import json
import shlex
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
DIFFTEST = HERE.parent / "difftest.py"
FAKE = HERE / "fake_engine.py"

sys.path.insert(0, str(HERE.parent))
from difftest import compare, json_diff  # noqa: E402


def difftest(tmp_path, *args: str) -> subprocess.CompletedProcess:
    cmd = [sys.executable, str(DIFFTEST), "--rules-dir", str(HERE / "fixtures"), "--jobs", "1",
           "--engine-root", str(tmp_path), "--out", str(tmp_path / "out"), *args]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=300)


def fake(bug: str = "") -> str:
    return f"{{python}} {FAKE} --rules {{rules}} --input {{input}}" + (f" --bug {bug}" if bug else "")


def test_without_an_engine_it_runs_the_reference_and_says_so(tmp_path):
    proc = difftest(tmp_path, "--n", "200")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "NOTICE: no C++ engine found" in proc.stdout
    assert "reference only, not compared" in proc.stdout
    assert "OK: 400 claims" in proc.stdout


def test_agreeing_engine_passes(tmp_path):
    proc = difftest(tmp_path, "--n", "25", "--engine-cmd", fake())
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "compared with --engine-cmd" in proc.stdout
    assert "0 failures" in proc.stdout


def test_planted_bug_is_found_shrunk_and_saved(tmp_path):
    proc = difftest(tmp_path, "--n", "60", "--engine-cmd", fake("collateral"), "--only", "ZZ")
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert "MISMATCH: ZZ claim" in proc.stdout
    assert "allowed_cents: reference" in proc.stdout
    assert "shrunk from" in proc.stdout
    saved = sorted((tmp_path / "out").glob("ZZ-*.input.json"))
    assert len(saved) == 1
    small = json.loads(saved[0].read_text())
    assert len(small["items"]) == 1
    assert small["items"][0]["insurance_paid_cents"] > 0
    # The printed replay command reaches the same engine and reproduces the mismatch.
    replay = next(line for line in proc.stdout.splitlines() if line.startswith("replay: "))
    args = shlex.split(replay.removeprefix("replay: "))
    again = subprocess.run([sys.executable, *args[1:], "--jobs", "1", "--out", str(tmp_path / "out2")],
                           capture_output=True, text=True, timeout=300)
    assert again.returncode == 1, again.stdout + again.stderr
    assert "MISMATCH: ZZ claim" in again.stdout


def test_trace_only_difference_is_reported(tmp_path):
    proc = difftest(tmp_path, "--n", "80", "--engine-cmd", fake("trace"), "--only", "ZZ")
    assert proc.returncode == 1
    assert "is the first trace difference" in proc.stdout
    proc = difftest(tmp_path, "--n", "80", "--engine-cmd", fake("trace"), "--only", "ZZ", "--no-trace")
    assert proc.returncode == 0, proc.stdout


def test_engine_failure_is_a_mismatch(tmp_path):
    proc = difftest(tmp_path, "--n", "3", "--engine-cmd", fake("crash"), "--only", "ZY", "--no-shrink")
    assert proc.returncode == 1
    assert "engine error: engine exited 3: simulated crash" in proc.stdout


def test_replay_reruns_one_claim(tmp_path):
    proc = difftest(tmp_path, "--replay", "ZZ:17", "--seed", "3")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "ZZ claim 17: reference invariants hold" in proc.stdout


def test_explicit_engine_without_tendc_is_an_error(tmp_path):
    lib = tmp_path / "libtend.dylib"
    lib.write_bytes(b"")
    proc = difftest(tmp_path, "--n", "1", "--engine-lib", str(lib))
    assert proc.returncode == 2
    assert "no tendc" in proc.stderr


def test_missing_rules_dir_is_an_error(tmp_path):
    proc = subprocess.run([sys.executable, str(DIFFTEST), "--rules-dir", str(tmp_path / "none"), "--no-fixtures"],
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 2


@pytest.mark.parametrize("a, b, paths", [
    ({"x": 1}, {"x": 1}, []),
    ({"x": 1}, {"x": 1.0}, ["$.x"]),
    ({"x": 1}, {"x": True}, ["$.x"]),
    ({"x": [1, 2]}, {"x": [1]}, ["$.x[1]"]),
    ({"x": 1}, {"y": 1}, ["$.x", "$.y"]),
])
def test_json_diff_is_type_strict(a, b, paths):
    assert [p for p, _, _ in json_diff(a, b)] == paths


def test_compare_ignores_the_image_hash_unless_asked():
    ref = {"law_image_sha256": "a", "lines": [], "trace": []}
    got = {"law_image_sha256": "b", "lines": [], "trace": []}
    assert not compare(ref, got, check_trace=True, check_sha=False)
    assert compare(ref, got, check_trace=True, check_sha=True)
