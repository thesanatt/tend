"""python -m tend_ref eval / gen"""

import hashlib
import json
import subprocess
import sys

from claims import FIXTURES, GOLDEN, zz
from tend_ref import evaluate

ZZ_PATH = FIXTURES / "ZZ.json"
GOLDEN_INPUT = GOLDEN / "zz_mixed.input.json"


def tend_ref(*args: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-m", "tend_ref", *args], input=stdin,
                          capture_output=True, text=True, timeout=60)


def test_eval_prints_the_engine_output():
    proc = tend_ref("eval", "--rules", str(ZZ_PATH), "--input", str(GOLDEN_INPUT))
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    expected = evaluate(zz(), json.loads(GOLDEN_INPUT.read_text()))
    assert out["law_image_sha256"] == hashlib.sha256(ZZ_PATH.read_bytes()).hexdigest()
    out.pop("law_image_sha256")
    expected.pop("law_image_sha256")
    assert out == expected


def test_eval_reads_stdin_and_prints_compact_json():
    proc = tend_ref("eval", "--rules", str(ZZ_PATH), "--input", "-", "--compact", stdin=GOLDEN_INPUT.read_text())
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.count("\n") == 1
    assert json.loads(proc.stdout)["totals"]["allowed_cents"] == 2_500_000


def test_eval_rejects_bad_input_with_exit_2(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"jurisdiction": "ZZ", "context": {}, "items": []}))
    proc = tend_ref("eval", "--rules", str(ZZ_PATH), "--input", str(bad))
    assert proc.returncode == 2
    assert proc.stderr.startswith("error: ")
    assert proc.stdout == ""


def test_eval_reports_a_missing_file():
    proc = tend_ref("eval", "--rules", str(FIXTURES / "nope.json"), "--input", str(GOLDEN_INPUT))
    assert proc.returncode == 2
    assert "error:" in proc.stderr


def test_gen_is_deterministic_and_evaluates_cleanly():
    first = tend_ref("gen", "--rules", str(ZZ_PATH), "--seed", "4", "--index", "9")
    again = tend_ref("gen", "--rules", str(ZZ_PATH), "--seed", "4", "--index", "9")
    other = tend_ref("gen", "--rules", str(ZZ_PATH), "--seed", "4", "--index", "10")
    assert first.returncode == 0, first.stderr
    assert first.stdout == again.stdout != other.stdout
    proc = tend_ref("eval", "--rules", str(ZZ_PATH), "--input", "-", stdin=first.stdout)
    assert proc.returncode == 0, proc.stderr
