#!/usr/bin/env python3
"""Differential test: random claims through the Python reference and the C++ engine.

    python3 refengine/difftest.py --n 2000

Every jurisdiction in rules/ir (IR version 2) is compiled with tendc, and claim N of
jurisdiction ST is generated from (seed, ST, N). The same claim bytes go to the C++ engine
(libtend through its C ABI, or the tendvm CLI) and to the reference, and the two result
documents must be equal, trace included. For well-formed JSON the outputs must also be equal
byte for byte (the reference is told the image's sha256); for malformed JSON both must refuse
with bad_input. Random laws (--random-laws) cover rule combinations the corpus lacks, and
--ir-fuzz checks that the reference refuses exactly the laws tendc refuses, with the same words.
On a mismatch the claim is shrunk to the fewest items that still disagree and can be replayed
with --replay ST:N.
"""

from __future__ import annotations

import argparse
import base64
import copy
import ctypes
import hashlib
import json
import os
import random
import re
import shlex
import subprocess
import sys
import tempfile
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

from tend_ref.claim import InvalidJson, loads  # noqa: E402
from tend_ref.engine import evaluate_json  # noqa: E402
from tend_ref.gen import claim_rng, generate_text  # noqa: E402
from tend_ref.invariants import invariant_errors  # noqa: E402
from tend_ref.law import Law, LawError, law_from_bytes  # noqa: E402
from tend_ref.randlaw import mutate_ir, random_law  # noqa: E402

FIXTURE_DIR = HERE / "tests" / "fixtures" / "ir"  # synthetic ZY and ZZ
LIB_NAMES = ("libtend.dylib", "libtend.so")
ENGINE_DIRS = ("engine/build", "engine/build/Release", "engine")
MISSING = "<missing>"
MAX_DIFF_LINES = 12


# The engine under test

@dataclass(frozen=True)
class EngineSpec:
    kind: str  # "lib" or "cmd"
    label: str
    lib: str | None = None
    cmd: tuple[str, ...] = ()
    tendc: str | None = None


class Engine:
    """Claim bytes in, result bytes out, through the C ABI or a command."""

    def __init__(self, spec: EngineSpec, timeout: float = 30.0):
        self.spec = spec
        self.timeout = timeout
        if spec.kind == "lib":
            lib = ctypes.CDLL(spec.lib)
            lib.tend_eval_json.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p]
            lib.tend_eval_json.restype = ctypes.c_void_p
            lib.tend_free.argtypes = [ctypes.c_void_p]
            lib.tend_free.restype = None
            self.lib = lib

    def run(self, image: bytes, law_path: str, raw: bytes) -> bytes:
        if self.spec.kind == "lib":
            ptr = self.lib.tend_eval_json(image, len(image), raw)
            if not ptr:
                return b'{"error":"tend_eval_json returned NULL"}'
            try:
                return ctypes.string_at(ptr)
            finally:
                self.lib.tend_free(ptr)
        with tempfile.NamedTemporaryFile("wb", suffix=".json", delete=False) as f:
            f.write(raw.split(b"\0", 1)[0])
        try:
            args = [a.format(law=law_path, input=f.name, python=sys.executable) for a in self.spec.cmd]
            proc = subprocess.run(args, capture_output=True, timeout=self.timeout)
        except subprocess.TimeoutExpired:
            return json.dumps({"error": f"engine timed out after {self.timeout:.0f}s"}).encode()
        finally:
            os.unlink(f.name)
        if proc.returncode not in (0, 1):
            return json.dumps({"error": f"engine exited {proc.returncode}: {proc.stderr.decode(errors='replace')[:300]}"}).encode()
        return proc.stdout.rstrip(b"\n")


def find_engine(args) -> tuple[EngineSpec | None, str]:
    root = Path(args.engine_root)
    tendc = args.tendc or next((str(root / d / "tendc") for d in ENGINE_DIRS if (root / d / "tendc").is_file()), None)
    looked = ", ".join(f"{d}/" for d in ENGINE_DIRS)
    if args.engine_cmd:
        return EngineSpec("cmd", f"command: {args.engine_cmd}", cmd=tuple(shlex.split(args.engine_cmd)), tendc=tendc), ""
    lib = args.engine_lib or next((str(root / d / n) for d in ENGINE_DIRS for n in LIB_NAMES if (root / d / n).is_file()), None)
    cli = args.engine_cli or next((str(root / d / "tendvm") for d in ENGINE_DIRS if (root / d / "tendvm").is_file()), None)
    if (lib or cli) and not tendc:
        return None, f"found {lib or cli} but no tendc to compile law images (looked in {looked})"
    if lib and not args.prefer_cli:
        return EngineSpec("lib", f"C++ engine via ctypes: {lib}", lib=lib, tendc=tendc), ""
    if cli:
        return EngineSpec("cmd", f"C++ engine CLI: {cli}", cmd=(cli, "eval", "--law", "{law}", "--input", "{input}"),
                          tendc=tendc), ""
    return None, f"no C++ engine found (looked for libtend and tendvm in {looked} under {root})"


def compile_law(tendc: str, ir_path: Path, verified: Path | None, out: Path) -> tuple[bool, str]:
    args = [tendc, "--quiet", str(ir_path), "-o", str(out)]
    args += ["--verified", str(verified)] if verified else ["--no-verified"]
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    if proc.returncode != 0 or not out.is_file():
        msg = (proc.stderr or proc.stdout).strip()
        # "tendc: <path>: <message>"
        prefix = f"tendc: {ir_path}: "
        return False, msg[len(prefix):] if msg.startswith(prefix) else msg
    return True, ""


# Comparison

def json_diff(a, b, path: str = "$") -> list[tuple[str, object, object]]:
    # Type-strict: 1 vs 1.0 vs true are different values.
    if type(a) is not type(b):
        return [(path, a, b)]
    if isinstance(a, dict):
        out = []
        for key in list(a) + [k for k in b if k not in a]:
            if key not in b:
                out.append((f"{path}.{key}", a[key], MISSING))
            elif key not in a:
                out.append((f"{path}.{key}", MISSING, b[key]))
            else:
                out += json_diff(a[key], b[key], f"{path}.{key}")
        return out
    if isinstance(a, list):
        out = []
        for i in range(max(len(a), len(b))):
            if i >= len(b):
                out.append((f"{path}[{i}]", a[i], MISSING))
            elif i >= len(a):
                out.append((f"{path}[{i}]", MISSING, b[i]))
            else:
                out += json_diff(a[i], b[i], f"{path}[{i}]")
        return out
    return [] if a == b else [(path, a, b)]


@dataclass
class Comparison:
    output: list = field(default_factory=list)  # differences outside the trace
    trace_index: int | None = None  # first trace entry that differs
    error: str = ""
    malformed: bool = False  # the claim text is not JSON; only the error code is compared
    refused: str | None = None  # the error code both engines gave, if any
    byte_identical: bool = False

    def __bool__(self) -> bool:
        return bool(self.output or self.trace_index is not None or self.error)


def is_error(doc) -> bool:
    return isinstance(doc, dict) and "error" in doc and "lines" not in doc


def compare(ref_text: str, got_bytes: bytes) -> tuple[Comparison, dict | None, dict | None]:
    ref = json.loads(ref_text)
    try:
        got = json.loads(got_bytes)
    except (ValueError, UnicodeDecodeError) as e:
        return Comparison(error=f"engine printed invalid JSON ({e}): {got_bytes[:200]!r}"), ref, None
    if not isinstance(got, dict):
        return Comparison(error=f"engine printed {type(got).__name__}, not an object"), ref, None
    if is_error(ref) and ref["error"]["message"].startswith("invalid JSON"):
        # Not JSON: both must refuse it as bad input. Messages differ (the C++ one has a byte offset).
        c = Comparison(malformed=True, refused="bad_input")
        if not (is_error(got) and isinstance(got["error"], dict) and got["error"].get("code") == "bad_input"):
            c.error = f"malformed claim: reference refused it with bad_input, engine returned {got_bytes[:200]!r}"
        return c, ref, got
    c = Comparison()
    ta = ref.pop("trace", []) if isinstance(ref, dict) else []
    tb = got.pop("trace", MISSING)
    c.output = json_diff(ref, got)
    if not is_error(ref):
        if not isinstance(tb, list):
            c.trace_index = 0
        else:
            for i in range(max(len(ta), len(tb))):
                if i >= len(ta) or i >= len(tb) or json_diff(ta[i], tb[i]):
                    c.trace_index = i
                    break
        ref["trace"] = ta
    if isinstance(tb, list):
        got["trace"] = tb
    if is_error(ref) and not c:
        c.refused = ref["error"]["code"]
    if not c:
        c.byte_identical = ref_text.encode("utf-8") == got_bytes
        if not c.byte_identical:
            c.error = "same document, different bytes"
    return c, ref, got


def describe(cmp: Comparison, ref: dict | None, got: dict | None) -> list[str]:
    if cmp.error and not cmp.output and cmp.trace_index is None:
        return [cmp.error]
    lines = []
    ids = [line.get("item_id") for line in (ref or {}).get("lines", [])]
    for path, a, b in cmp.output[:MAX_DIFF_LINES]:
        if path.startswith("$.lines[") and "]" in path:
            i = int(path[len("$.lines["):path.index("]")])
            if i < len(ids):
                path = f"{path[:path.index(']') + 1]} ({ids[i]}){path[path.index(']') + 1:]}"
        lines.append(f"{path[2:]}: reference {json.dumps(a)}, engine {json.dumps(b)}")
    if len(cmp.output) > MAX_DIFF_LINES:
        lines.append(f"... and {len(cmp.output) - MAX_DIFF_LINES} more differences")
    if cmp.trace_index is not None:
        i = cmp.trace_index
        ta, tb = (ref or {}).get("trace", []), (got or {}).get("trace")
        tb = tb if isinstance(tb, list) else []
        lines.append(f"trace[{i}] is the first trace difference:")
        lines.append(f"  reference {json.dumps(ta[i]) if i < len(ta) else MISSING}")
        lines.append(f"  engine    {json.dumps(tb[i]) if i < len(tb) else MISSING}")
    return lines


def differing_fields(cmp: Comparison) -> tuple[str, ...]:
    if cmp.error and not cmp.output and cmp.trace_index is None:
        return (re.sub(r"\(.*", "", cmp.error).strip()[:40],)
    fields = {re.sub(r"by_expense\.\w+", "by_expense.*", re.sub(r"\[\d+\]", "[*]", p))[2:] for p, _, _ in cmp.output}
    if cmp.trace_index is not None:
        fields.add("trace")
    return tuple(sorted(fields))


# Running claims

@dataclass
class Target:
    """One law to test: a jurisdiction, a fixture, or a random law."""

    code: str
    ir_path: str
    verified_path: str | None
    law_path: str | None  # compiled .tlaw; None when no tendc is around (reference only)
    n: int


@dataclass
class Failure:
    code: str
    index: int
    kind: str  # "mismatch", "invariant", "reference_error"
    raw: bytes
    details: list[str]
    fields: tuple[str, ...] = ()


@dataclass
class JobResult:
    code: str
    claims: int = 0
    agreed: int = 0
    byte_identical: int = 0
    malformed: int = 0
    refused: Counter = field(default_factory=Counter)
    statuses: Counter = field(default_factory=Counter)
    ops: Counter = field(default_factory=Counter)
    checks: Counter = field(default_factory=Counter)
    flags: Counter = field(default_factory=Counter)
    features: Counter = field(default_factory=Counter)
    failed: int = 0
    failures: list[Failure] = field(default_factory=list)
    failure_counts: Counter = field(default_factory=Counter)
    seconds: float = 0.0
    corpus: list[str] = field(default_factory=list)


@dataclass
class Job:
    target: Target
    seed: int
    spec: EngineSpec | None
    keep_going: bool
    corpus: bool


def load_target_law(target: Target, image: bytes | None) -> Law:
    verified = Path(target.verified_path).read_bytes() if target.verified_path else None
    sha = hashlib.sha256(image).hexdigest() if image else None
    return law_from_bytes(Path(target.ir_path).read_bytes(), verified, law_sha256=sha)


def check_claim(law: Law, engine: Engine | None, image: bytes, law_path: str, raw: bytes, doc: dict | None,
                rng: random.Random) -> tuple[str | None, list[str], Comparison | None, dict | None, bytes | None]:
    """(failure kind or None, details, comparison, reference output, engine output)."""
    ref_text = evaluate_json(law, raw)
    ref = json.loads(ref_text)
    if doc is not None:
        if is_error(ref):
            return "reference_error", [f"the reference refused a generated claim: {ref['error']}"], None, ref, None
        problems = invariant_errors(law, doc, ref)
        shuffled = copy.deepcopy(doc)
        rng.shuffle(shuffled["items"])
        if evaluate_json(law, json.dumps(shuffled, ensure_ascii=False).encode()) != ref_text:
            problems.append("output changes when the input items are reordered")
        if problems:
            return "invariant", problems, None, ref, None
    if engine is None:
        return None, [], None, ref, None
    got = engine.run(image, law_path, raw)
    cmp, ref_doc, got_doc = compare(ref_text, got)
    if cmp:
        return "mismatch", describe(cmp, ref_doc, got_doc), cmp, ref, got
    return None, [], cmp, ref, got


def feature_counts(law: Law, doc: dict, ref: dict) -> Counter:
    """SPEC v1.2 and v1.3 paths this claim took, so a run can show it reached each one."""
    c = Counter()
    items = {it["item_id"]: it for it in doc["items"]}
    lines = {line["item_id"]: line for line in ref["lines"]}
    for t in ref["trace"]:
        line = lines.get(t["item_id"]) if t["item_id"] else None
        if t["op"] == "unit_cap":
            rule = law.by_id[t["rule_id"]]
            c["unit cap applied"] += 1
            if rule.count_limit is not None and line and line["allowed_cents"] == 0 and line["cap_rule_id"] == rule.id:
                c["count limit used up"] += 1
        elif t["op"] == "rate_unverified":
            rule, it = law.by_id[t["rule_id"]], items[t["item_id"]]
            unit, units = it.get("unit"), it.get("units") or 0
            c["unit mismatch flagged" if unit and unit != rule.unit and units > 0
              else "no unit or no units flagged"] += 1
    for line in ref["lines"]:
        it = items[line["item_id"]]
        if it.get("expense") == "forensic_exam" and line["expense"] == "medical":
            c["exam treated as medical"] += 1
        if line["status"] == "excluded" and any(law.by_id[r].tags for r in line["rule_ids"]):
            c["excluded by tag"] += 1
    deadline = ref["checks"]["deadline"]
    if "deadline_from_report" in deadline["flags"]:
        c["deadline from report"] += 1
    if "deadline_from_discovery" in deadline["flags"]:
        c["deadline from discovery"] += 1
        if deadline["status"] == "late":
            c["late deadline flagged from discovery"] += 1
    if any(r.kind == "exam_payment" for r in law.rules) and not law.exam_no_bill:
        c["exam payment listed as info"] += 1
    for rule in law.minimum_loss:
        if rule.days_lost is not None and rule.cap is not None:
            c["minimum loss with amount and days"] += 1
    if law.minimum_loss and ref["checks"]["minimum_loss"]["status"] == "met":
        total = ref["totals"]["allowed_cents"]
        if any(r.cap is not None and total < r.cap for r in law.minimum_loss):
            c["minimum loss met by lost-wage days"] += 1
    return c


def run_job(job: Job) -> JobResult:
    started = time.monotonic()
    t = job.target
    image = Path(t.law_path).read_bytes() if t.law_path else b""
    law = load_target_law(t, image or None)
    engine = Engine(job.spec) if job.spec else None
    result = JobResult(t.code)
    for index in range(t.n):
        rng = claim_rng(job.seed, t.code, index)
        raw, doc = generate_text(law, rng)
        result.claims += 1
        kind, details, cmp, ref, got = check_claim(law, engine, image, t.law_path, raw, doc, rng)
        if ref is not None and not is_error(ref):
            result.statuses.update(line["status"] for line in ref["lines"])
            result.ops.update(entry["op"] for entry in ref["trace"])
            result.checks.update(f"{name}:{c['status']}" for name, c in ref["checks"].items())
            result.flags.update(f.split(":")[0] for line in ref["lines"] for f in line["flags"])
            result.flags.update(ref["checks"]["deadline"]["flags"])
            if doc is not None:
                result.features.update(feature_counts(law, doc, ref))
        if cmp is not None:
            result.malformed += cmp.malformed
            result.byte_identical += cmp.byte_identical
            if cmp.refused:
                result.refused[cmp.refused] += 1
        if job.corpus and got is not None and kind is None:
            result.corpus.append(json.dumps({"law": f"{t.code}.tlaw", "index": index,
                                             "input": base64.b64encode(raw).decode(),
                                             "sha256": hashlib.sha256(got).hexdigest()}))
        if kind:
            failure = Failure(t.code, index, kind, raw, details,
                              differing_fields(cmp) if cmp is not None else (kind.replace("_", " "),))
            if any(f not in result.failure_counts for f in failure.fields):
                result.failures.append(failure)
            result.failure_counts.update(failure.fields)
            result.failed += 1
            if not job.keep_going:
                break
        elif engine:
            result.agreed += 1
    result.seconds = time.monotonic() - started
    return result


def shrink(law: Law, engine: Engine, image: bytes, law_path: str, doc: dict, budget: int = 1500) -> dict:
    """Smallest claim found that still makes the engines disagree."""
    calls = 0

    def disagrees(candidate: dict) -> bool:
        nonlocal calls
        calls += 1
        raw = json.dumps(candidate, ensure_ascii=False).encode()
        cmp, _, _ = compare(evaluate_json(law, raw), engine.run(image, law_path, raw))
        return bool(cmp)

    current = copy.deepcopy(doc)
    progress = True
    while progress and calls < budget and isinstance(current.get("items"), list):
        progress = False
        for i in range(len(current["items"])):
            candidate = copy.deepcopy(current)
            del candidate["items"][i]
            if disagrees(candidate):
                current, progress = candidate, True
                break
    simpler = (("insurance_paid_cents", 0), ("units", 0), ("unit", None), ("tags", []), ("confirmed", True),
               ("is_bill", False), ("description", ""))
    for i in range(len(current.get("items") or [])):
        for key, value in simpler:
            item = current["items"][i]
            if calls >= budget or not isinstance(item, dict) or item.get(key) == value:
                continue
            candidate = copy.deepcopy(current)
            candidate["items"][i][key] = value
            if disagrees(candidate):
                current = candidate
    return current


# Malformed laws: the reference must refuse exactly what tendc refuses

def ir_fuzz(tendc: str, count: int, seed: int, work: Path) -> tuple[int, int, int, list[str]]:
    """(laws tried, accepted by both, refused by both with the same message, problems)."""
    problems, accepted, refused = [], 0, 0
    for i in range(count):
        rng = random.Random(f"tend-irfuzz:{seed}:{i}")
        doc = mutate_ir(rng, random_law(rng, f"F{i % 1000}"))
        path = work / f"irfuzz-{i}.json"
        path.write_text(json.dumps(doc, ensure_ascii=False))
        ok, message = compile_law(tendc, path, None, work / "irfuzz.tlaw")
        try:
            law_from_bytes(path.read_bytes())
            ref_ok, ref_message = True, ""
        except LawError as e:
            ref_ok, ref_message = False, str(e)
        if ok != ref_ok or message != ref_message:
            problems.append(f"irfuzz {i}: tendc {'accepted' if ok else repr(message)}, reference "
                            f"{'accepted' if ref_ok else repr(ref_message)}")
        elif ok:
            accepted += 1
        else:
            refused += 1
    return count, accepted, refused, problems


# Command line

def targets_from_dir(ir_dir: Path, verified_dir: Path | None) -> list[tuple[str, Path, Path | None]]:
    out = []
    for path in sorted(ir_dir.glob("*.json")) if ir_dir.is_dir() else []:
        try:
            code = json.loads(path.read_bytes()).get("jurisdiction")
        except (OSError, ValueError):
            print(f"skip {path}: not JSON")
            continue
        verified = verified_dir / path.name if verified_dir else None
        out.append((code, path, verified if verified and verified.is_file() else None))
    return out


def replay_flags(args) -> str:
    # The options a replay needs to reach the same laws and the same engine the same way.
    flags = []
    for name in ("ir_dir", "verified_dir"):
        value = getattr(args, name)
        default = ROOT / "rules" / ("ir" if name == "ir_dir" else "verified")
        if Path(value).resolve() != default.resolve():
            flags.append(f"--{name.replace('_', '-')} {shlex.quote(value)}")
    for name in ("engine_root", "engine_lib", "engine_cli", "tendc", "engine_cmd"):
        value = getattr(args, name)
        if value and not (name == "engine_root" and Path(value).resolve() == ROOT):
            flags.append(f"--{name.replace('_', '-')} {shlex.quote(value)}")
    if args.random_laws:
        flags.append(f"--random-laws {args.random_laws}")
    if not args.include_fixtures:
        flags.append("--no-fixtures")
    if args.prefer_cli:
        flags.append("--prefer-cli")
    return "".join(f" {flag}" for flag in flags)


def report_failure(failure: Failure, target: Target, law: Law, engine: Engine | None, out_dir: Path, shrink_on: bool,
                   seed: int, replay_flags: str) -> None:
    title = {"mismatch": "MISMATCH", "invariant": "REFERENCE INVARIANT BROKEN",
             "reference_error": "REFERENCE ERROR"}[failure.kind]
    print(f"\n{title}: {failure.code} claim {failure.index} (seed {seed})")
    raw, details = failure.raw, failure.details
    if failure.kind == "mismatch" and engine and shrink_on:
        try:
            doc = loads(raw)
        except InvalidJson:
            doc = None
        if isinstance(doc, dict):
            image = Path(target.law_path).read_bytes()
            small = shrink(law, engine, image, target.law_path, json.loads(json.dumps(doc)))
            small_raw = json.dumps(small, ensure_ascii=False).encode()
            cmp, a, b = compare(evaluate_json(law, small_raw), engine.run(image, target.law_path, small_raw))
            if cmp and len(small_raw) < len(raw):
                print(f"shrunk from {len(raw)} bytes to {len(small_raw)}")
                raw, details = small_raw, describe(cmp, a, b)
    for line in details:
        print(f"  {line}")
    out_dir.mkdir(parents=True, exist_ok=True)
    saved = out_dir / f"{failure.code}-{failure.index}.input.json"
    saved.write_bytes(raw)
    print(f"input saved to {saved}")
    here = os.path.relpath(HERE)
    print(f"replay: python3 {os.path.join(here, 'difftest.py')} --replay {failure.code}:{failure.index} --seed {seed}{replay_flags}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Compare the Python reference with the C++ engine on random claims.")
    parser.add_argument("--n", type=int, default=1000, help="claims per jurisdiction (default 1000)")
    parser.add_argument("--ir-dir", default=str(ROOT / "rules" / "ir"), help="law IR files (default rules/ir)")
    parser.add_argument("--verified-dir", default=str(ROOT / "rules" / "verified"), help="verified files (quotes only)")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--only", help="comma-separated jurisdictions, e.g. MI,NY")
    parser.add_argument("--no-fixtures", dest="include_fixtures", action="store_false",
                        help="skip the synthetic ZY and ZZ fixtures (they reach cases real rules do not)")
    parser.add_argument("--random-laws", type=int, default=0, help="also test this many random laws")
    parser.add_argument("--random-claims", type=int, default=50, help="claims per random law (default 50)")
    parser.add_argument("--ir-fuzz", type=int, default=0, help="malformed laws checked against tendc's refusals")
    parser.add_argument("--engine-root", default=str(ROOT), help="repo root to search for engine/ builds")
    parser.add_argument("--engine-lib", help="path to libtend (.dylib or .so), called through ctypes")
    parser.add_argument("--engine-cli", help="path to the tendvm CLI")
    parser.add_argument("--prefer-cli", action="store_true", help="use tendvm even when libtend is found (isolates crashes)")
    parser.add_argument("--tendc", help="path to the tendc compiler")
    parser.add_argument("--engine-cmd", help="any engine command; {law} {input} {python} are filled in per claim")
    parser.add_argument("--keep-going", action="store_true", help="count every failure instead of stopping at the first")
    parser.add_argument("--no-shrink", dest="shrink", action="store_false", help="report the generated claim as is")
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 1, help="worker processes (default: all cores)")
    parser.add_argument("--replay", metavar="ST:N", help="rerun one claim and print the full comparison")
    parser.add_argument("--corpus", metavar="DIR", help="write every agreed claim and the native output's sha256 to "
                                                         "DIR/ST.jsonl and the images to DIR/laws (for the WASM check)")
    parser.add_argument("--out", default=str(Path(tempfile.gettempdir()) / "tend-difftest"), help="where failing inputs go")
    args = parser.parse_args(argv)

    spec, note = find_engine(args)
    if spec is None and (args.engine_lib or args.engine_cli):
        print(f"error: {note}; pass --tendc", file=sys.stderr)
        return 2
    tendc = spec.tendc if spec else (args.tendc or next((str(Path(args.engine_root) / d / "tendc") for d in ENGINE_DIRS
                                                          if (Path(args.engine_root) / d / "tendc").is_file()), None))
    if not tendc and (spec or args.ir_fuzz or args.corpus):
        print("error: no tendc found to compile law images; build engine/ (make -C engine) or pass --tendc", file=sys.stderr)
        return 2

    work = Path(tempfile.mkdtemp(prefix="tend-difftest-"))
    found = targets_from_dir(Path(args.ir_dir), Path(args.verified_dir))
    if args.include_fixtures:
        found += targets_from_dir(FIXTURE_DIR, HERE / "tests" / "fixtures" / "verified")
    if args.only:
        wanted = {s.strip().upper() for s in args.only.split(",")}
        found = [t for t in found if t[0] in wanted]
    for i in range(args.random_laws):
        code = f"R{i:04d}"
        path = work / f"{code}.json"
        path.write_text(json.dumps(random_law(random.Random(f"tend-law:{args.seed}:{code}"), code), indent=1))
        found.append((code, path, None))

    targets: list[Target] = []
    law_problems: list[str] = []
    for code, path, verified in found:
        out = work / f"{code}.tlaw"
        ok, message = compile_law(tendc, path, verified, out) if tendc else (True, "")
        try:
            load_target_law(Target(code, str(path), str(verified) if verified else None, None, 0), None)
            ref_ok, ref_message = True, ""
        except LawError as e:
            ref_ok, ref_message = False, str(e)
        if not ok or not ref_ok:
            if ok != ref_ok or message != ref_message:
                law_problems.append(f"{code}: tendc {'compiled it' if ok else repr(message)}, reference "
                                    f"{'loaded it' if ref_ok else repr(ref_message)}")
            else:
                print(f"skip {code}: both engines refuse the law ({message})")
            continue
        n = args.random_claims if code.startswith("R") and path.parent == work else args.n
        targets.append(Target(code, str(path), str(verified) if verified else None, str(out) if tendc else None, n))

    if args.replay:
        st, _, index = args.replay.partition(":")
        match = [t for t in targets if t.code.upper() == st.upper()]
        if not match or not index.isdigit():
            print(f"error: --replay wants ST:N with ST in {', '.join(t.code for t in targets)}", file=sys.stderr)
            return 2
        t = match[0]
        image = Path(t.law_path).read_bytes() if t.law_path else b""
        law = load_target_law(t, image or None)
        engine = Engine(spec) if spec else None
        rng = claim_rng(args.seed, t.code, int(index))
        raw, doc = generate_text(law, rng)
        kind, details, cmp, _, _ = check_claim(law, engine, image, t.law_path, raw, doc, rng)
        print(f"claim: {raw.decode('utf-8', errors='replace')}")
        if kind:
            report_failure(Failure(t.code, int(index), kind, raw, details), t, law, engine, Path(args.out), args.shrink,
                           args.seed, replay_flags(args))
            return 1
        print(f"{t.code} claim {index}: {'engines agree' if engine else 'reference invariants hold'}"
              + (f" ({'byte-identical' if cmp.byte_identical else 'malformed JSON, both refuse' if cmp.malformed else ''})" if cmp else ""))
        return 0

    real = sum(1 for t in targets if not (t.code.startswith("R") and Path(t.ir_path).parent == work))
    print(f"tend difftest: {args.n} claims per jurisdiction, seed {args.seed}, {real} laws"
          + (f" + {args.random_laws} random laws x {args.random_claims} claims" if args.random_laws else ""))
    if spec:
        print(f"engine: {spec.label} (law images from {tendc})")
    else:
        print(f"NOTICE: {note or 'no engine requested'}.")
        print("NOTICE: running the reference only; each claim is checked against the reference's own invariants.")

    corpus_dir = Path(args.corpus) if args.corpus else None
    if corpus_dir:
        (corpus_dir / "laws").mkdir(parents=True, exist_ok=True)
        for t in targets:
            (corpus_dir / "laws" / f"{t.code}.tlaw").write_bytes(Path(t.law_path).read_bytes())

    jobs = [Job(t, args.seed, spec, args.keep_going, corpus_dir is not None) for t in targets]
    started = time.monotonic()
    try:
        if args.jobs > 1 and len(jobs) > 1:
            with ProcessPoolExecutor(max_workers=min(args.jobs, len(jobs))) as pool:
                results = list(pool.map(run_job, sorted(jobs, key=lambda j: -j.target.n), chunksize=1))
        else:
            results = [run_job(job) for job in jobs]
    except BrokenProcessPool:
        print("\nERROR: a worker process died, most likely a crash inside the engine library.")
        print("Rerun with --prefer-cli (one tendvm process per claim) to find the claim that crashes it.")
        return 1
    results.sort(key=lambda r: (r.code.startswith("R") and r.code[1:].isdigit(), r.code))
    if corpus_dir:
        for r in results:
            (corpus_dir / f"{r.code}.jsonl").write_text("\n".join(r.corpus) + "\n")

    for r in results:
        if r.code.startswith("R") and r.code[1:].isdigit() and not r.failures:
            continue  # random laws are summed up below
        status = "FAIL" if r.failures else ("agree" if spec else "ok")
        top = ", ".join(f"{k} {v}" for k, v in r.statuses.most_common(6))
        print(f"{r.code:<6} {r.claims:>6} claims  {status:<5} {r.seconds:5.1f}s  {top}")
    randoms = [r for r in results if r.code.startswith("R") and r.code[1:].isdigit()]
    if randoms:
        print(f"random laws: {len(randoms)} laws, {sum(r.claims for r in randoms)} claims, "
              f"{sum(1 for r in randoms if r.failures)} with failures")

    def total(attr):
        c = Counter()
        for r in results:
            c.update(getattr(r, attr))
        return c

    ops, checks, flags, refused = total("ops"), total("checks"), total("flags"), total("refused")
    features = total("features")
    expected_ops = ["out_of_window", "held", "excluded", "unknown_rule", "needs_confirmation", "eligible", "collateral",
                    "unit_cap", "rate_unverified", "expense_cap", "total_cap"]
    print("decisions seen: " + ", ".join(f"{op} {ops[op]}" for op in expected_ops))
    never = [op for op in expected_ops if not ops[op]]
    if never:
        print("never reached in this run: " + ", ".join(never))
    print("checks seen: " + ", ".join(f"{k} {v}" for k, v in sorted(checks.items())))
    print("flags seen: " + ", ".join(f"{k} {v}" for k, v in sorted(flags.items())))
    print("v1.2 and v1.3 paths seen: " + ", ".join(f"{k} {v}" for k, v in sorted(features.items())))
    claims = sum(r.claims for r in results)
    malformed = sum(r.malformed for r in results)
    identical = sum(r.byte_identical for r in results)
    print(f"claims refused by both engines: " + (", ".join(f"{k} {v}" for k, v in sorted(refused.items())) or "none")
          + f" (of these, {malformed} were not JSON and are compared by error code only)")
    if spec:
        print(f"byte-identical results: {identical} of {claims - malformed} well-formed claims")

    ir_problems: list[str] = []
    if args.ir_fuzz:
        tried, accepted, refused_laws, ir_problems = ir_fuzz(tendc, args.ir_fuzz, args.seed, work)
        print(f"ir fuzz: {tried} laws, {accepted} accepted by both, {refused_laws} refused by both with the same "
              f"message, {len(ir_problems)} disagreements")
        for p in ir_problems[:10]:
            print(f"  {p}")
    for p in law_problems:
        print(f"LAW MISMATCH {p}")

    failures = [f for r in results for f in r.failures]
    failure_count = sum(r.failed for r in results)
    if args.keep_going and failures:
        by_field: dict[str, Counter] = {}
        examples: dict[str, Failure] = {}
        for r in results:
            for name, count in r.failure_counts.items():
                by_field.setdefault(name, Counter())[r.code] += count
            for f in r.failures:
                for name in f.fields:
                    examples.setdefault(name, f)
        print("\nfailing claims by differing field (count, laws, example):")
        for name, states in sorted(by_field.items(), key=lambda kv: (-sum(kv[1].values()), kv[0])):
            names = sorted(states)
            shown = ", ".join(names[:10]) + (f" +{len(names) - 10}" if len(names) > 10 else "")
            ex = examples[name]
            print(f"  {sum(states.values()):>7}  {name:<34} [{shown}]  e.g. {ex.code}:{ex.index}")
    if failures:
        first = failures[0]
        t = next(t for t in targets if t.code == first.code)
        law = load_target_law(t, Path(t.law_path).read_bytes() if t.law_path else None)
        report_failure(first, t, law, Engine(spec) if spec else None, Path(args.out), args.shrink, args.seed,
                       replay_flags(args))
        if failure_count > 1:
            print(f"({failure_count - 1} more failures not shown" + ("" if args.keep_going else "; --keep-going counts them all") + ")")
    bad = failures or law_problems or ir_problems
    verdict = "FAILED" if bad else "OK"
    compared = "reference only, not compared" if not spec else "compared with the C++ engine"
    print(f"\n{verdict}: {claims} claims in {time.monotonic() - started:.1f}s, {failure_count} mismatches"
          + (f", {len(law_problems)} law disagreements" if law_problems else "") + f" ({compared})")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
