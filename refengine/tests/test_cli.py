"""python -m tend_ref eval / gen / check"""

import json
import subprocess
import sys

from claims import FIXTURES, GOLDEN

ZZ_IR = FIXTURES / "ir" / "ZZ.json"
GOLDEN_INPUT = GOLDEN / "zz_mixed.input.json"


def tend_ref(*args: str, stdin: bytes | None = None) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-m", "tend_ref", *args], input=stdin, capture_output=True, timeout=60)


def test_eval_prints_the_result():
    proc = tend_ref("eval", "--ir", str(ZZ_IR), "--input", str(GOLDEN_INPUT))
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out["totals"]["allowed_cents"] == 2_500_000
    assert proc.stdout.count(b"\n") > 10  # pretty by default


def test_eval_matches_the_golden_bytes_when_given_the_image_sha():
    expected = (GOLDEN / "zz_mixed.expected.json").read_bytes()
    sha = json.loads(expected)["law_image_sha256"]
    proc = tend_ref("eval", "--ir", str(ZZ_IR), "--input", "-", "--compact", "--law-sha256", sha,
                    stdin=GOLDEN_INPUT.read_bytes())
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == expected


def test_eval_prints_the_error_document_and_exits_1():
    proc = tend_ref("eval", "--ir", str(ZZ_IR), "--input", "-", "--compact",
                    stdin=b'{"context":{"incident_date":"2026-06-14","as_of_date":"2026-10-03"},'
                          b'"items":[{"item_id":"a","date":"2026-07-01","amount_cents":-5}]}')
    assert proc.returncode == 1
    assert json.loads(proc.stdout) == {"error": {"code": "bad_input",
                                                 "message": "items[0].amount_cents: must not be negative"}}


def test_a_law_tendc_would_refuse_exits_2(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"ir_version": 1, "jurisdiction": "ZZ", "rules": []}))
    proc = tend_ref("eval", "--ir", str(bad), "--input", str(GOLDEN_INPUT))
    assert proc.returncode == 2
    assert proc.stderr.decode().strip() == "error: IR: ir_version must be 2"


def test_gen_is_deterministic_and_valid():
    a = tend_ref("gen", "--ir", str(ZZ_IR), "--seed", "3", "--index", "7", "--compact")
    b = tend_ref("gen", "--ir", str(ZZ_IR), "--seed", "3", "--index", "7", "--compact")
    assert a.returncode == 0 and a.stdout == b.stdout
    proc = tend_ref("eval", "--ir", str(ZZ_IR), "--input", "-", stdin=a.stdout)
    assert proc.returncode == 0, proc.stdout


def test_check_summarizes_the_law():
    proc = tend_ref("check", "--ir", str(ZZ_IR))
    assert proc.returncode == 0
    assert proc.stdout.decode().startswith("ZZ: 39 rules, 1 set aside")
