"""difftest.py: agreement, planted bugs, crashes, refusals, and a run with no engine at all."""

import json
import shlex
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
DIFFTEST = HERE.parent / "difftest.py"
FAKE = HERE / "fake_engine.py"
TENDC = HERE.parents[1] / "engine" / "build" / "tendc"
ZZ_IR = HERE / "fixtures" / "ir" / "ZZ.json"

sys.path.insert(0, str(HERE.parent))
from difftest import compare, json_diff  # noqa: E402

needs_tendc = pytest.mark.skipif(not TENDC.is_file(), reason="engine/build/tendc is not built")


def difftest(tmp_path, *args: str) -> subprocess.CompletedProcess:
    cmd = [sys.executable, str(DIFFTEST), "--ir-dir", str(tmp_path / "no-ir"), "--jobs", "1",
           "--engine-root", str(tmp_path), "--out", str(tmp_path / "out"), *args]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=600)


def fake(bug: str = "") -> list[str]:
    cmd = f"{{python}} {FAKE} --law {{law}} --ir {ZZ_IR} --input {{input}}" + (f" --bug {bug}" if bug else "")
    return ["--engine-cmd", cmd, "--tendc", str(TENDC), "--only", "ZZ"]


def test_without_an_engine_it_runs_the_reference_and_says_so(tmp_path):
    proc = difftest(tmp_path, "--n", "150")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "NOTICE: no C++ engine found" in proc.stdout
    assert "reference only, not compared" in proc.stdout
    assert "OK: 300 claims" in proc.stdout  # the ZY and ZZ fixtures


@needs_tendc
def test_agreeing_engine_passes_byte_for_byte(tmp_path):
    proc = difftest(tmp_path, "--n", "40", *fake())
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "0 mismatches (compared with the C++ engine)" in proc.stdout
    line = next(x for x in proc.stdout.splitlines() if x.startswith("byte-identical results"))
    done, of = line.split(": ")[1].split(" well-formed")[0].split(" of ")
    assert done == of


@needs_tendc
def test_planted_bug_is_found_shrunk_saved_and_replayed(tmp_path):
    proc = difftest(tmp_path, "--n", "60", *fake("unit"))
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert "MISMATCH: ZZ claim" in proc.stdout
    assert "rate_unverified" in proc.stdout
    assert "shrunk from" in proc.stdout
    saved = sorted((tmp_path / "out").glob("ZZ-*.input.json"))
    assert len(saved) == 1
    small = json.loads(saved[0].read_text())
    assert len(small["items"]) == 1 and small["items"][0].get("unit")
    replay = next(line for line in proc.stdout.splitlines() if line.startswith("replay: "))
    args = shlex.split(replay.removeprefix("replay: "))
    again = subprocess.run([sys.executable, *args[1:], "--jobs", "1", "--out", str(tmp_path / "out2")],
                           capture_output=True, text=True, timeout=300)
    assert again.returncode == 1, again.stdout + again.stderr
    assert "MISMATCH" in again.stdout


@needs_tendc
@pytest.mark.parametrize("bug,field", [("collateral", "allowed_cents"), ("trace", "trace"),
                                       ("message", "error.message"), ("bytes", "same document, different bytes")])
def test_each_kind_of_difference_is_reported(tmp_path, bug, field):
    proc = difftest(tmp_path, "--n", "120", "--keep-going", "--no-shrink", *fake(bug))
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert field in proc.stdout


@needs_tendc
def test_an_engine_that_accepts_text_that_is_not_json_is_caught(tmp_path):
    proc = difftest(tmp_path, "--n", "300", "--keep-going", "--no-shrink", *fake("malformed"))
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert "malformed claim" in proc.stdout or "lines" in proc.stdout


@needs_tendc
def test_a_crashing_engine_fails_the_run(tmp_path):
    proc = difftest(tmp_path, "--n", "5", *fake("crash"))
    assert proc.returncode == 1
    assert "engine exited 3" in proc.stdout


@needs_tendc
def test_ir_fuzz_agrees_with_tendc(tmp_path):
    proc = difftest(tmp_path, "--n", "1", "--no-fixtures", "--ir-fuzz", "150", "--tendc", str(TENDC))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "0 disagreements" in proc.stdout


def test_json_diff_is_type_strict():
    assert json_diff({"a": 1}, {"a": 1.0}) == [("$.a", 1, 1.0)]
    assert json_diff({"a": [1, 2]}, {"a": [1]}) == [("$.a[1]", 2, "<missing>")]
    assert json_diff({"a": True}, {"a": 1}) == [("$.a", True, 1)]


def test_compare_treats_text_that_is_not_json_by_error_code():
    ref = json.dumps({"error": {"code": "bad_input", "message": "invalid JSON: Expecting value"}})
    cmp, _, _ = compare(ref, b'{"error":{"code":"bad_input","message":"invalid JSON at byte 3: bad number"}}')
    assert not cmp and cmp.malformed
    cmp, _, _ = compare(ref, b'{"error":{"code":"vm_trap","message":"x"}}')
    assert cmp


def test_compare_wants_the_same_bytes_for_well_formed_claims():
    doc = {"error": {"code": "bad_input", "message": "items[0].unit: not a known unit"}}
    text = json.dumps(doc, separators=(",", ":"))
    cmp, _, _ = compare(text, text.encode())
    assert not cmp and cmp.byte_identical and cmp.refused == "bad_input"
    cmp, _, _ = compare(text, json.dumps(doc).encode())
    assert cmp and cmp.error == "same document, different bytes"
