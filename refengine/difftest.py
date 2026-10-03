#!/usr/bin/env python3
"""Differential test: random claims through the Python reference and the C++ engine.

    python refengine/difftest.py --n 10000 --rules-dir rules/verified

Claim N of jurisdiction ST is generated from (seed, ST, N), so every failure can be replayed
with --replay ST:N. The C++ engine is found under engine/ (the shared library through its C ABI,
or the tendvm CLI), or given with --engine-lib, --engine-cli, or --engine-cmd. Without an engine
the claims still run through the reference and are checked against its invariants, and the run
says so. On a mismatch the input is shrunk to the fewest items that still disagree.
"""

from __future__ import annotations

import argparse
import copy
import ctypes
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

from tend_ref.engine import EngineInputError, Law, load_rules  # noqa: E402
from tend_ref.gen import claim_rng, generate  # noqa: E402
from tend_ref.invariants import invariant_errors  # noqa: E402

FIXTURES = sorted((HERE / "tests" / "fixtures").glob("*.json"))  # synthetic ZY and ZZ
LIB_NAMES = ("libtend.dylib", "libtend.so")
ENGINE_DIRS = ("engine/build", "engine/build/Release", "engine")
MISSING = "<missing>"
MAX_DIFF_LINES = 12


@dataclass(frozen=True)
class EngineSpec:
    kind: str  # "lib" or "cmd"
    label: str
    lib: str | None = None
    cmd: tuple[str, ...] = ()
    tendc: str | None = None

    @property
    def needs_image(self) -> bool:
        return self.kind == "lib" or any("{law}" in arg for arg in self.cmd)


class Engine:
    """The engine under test, called once per claim."""

    def __init__(self, spec: EngineSpec, timeout: float = 30.0):
        self.spec = spec
        self.timeout = timeout
        self.images: dict[str, bytes] = {}
        if spec.kind == "lib":
            lib = ctypes.CDLL(spec.lib)
            lib.tend_eval_json.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p]
            lib.tend_eval_json.restype = ctypes.c_void_p
            lib.tend_free.argtypes = [ctypes.c_void_p]
            lib.tend_free.restype = None
            self.lib = lib

    def run(self, law_path: str | None, rules_path: str, engine_input: dict) -> dict:
        text = json.dumps(engine_input, ensure_ascii=False)
        if self.spec.kind == "lib":
            image = self.images.get(law_path)
            if image is None:
                image = self.images[law_path] = Path(law_path).read_bytes()
            ptr = self.lib.tend_eval_json(image, len(image), text.encode("utf-8"))
            if not ptr:
                return {"error": "tend_eval_json returned NULL"}
            try:
                raw = ctypes.string_at(ptr).decode("utf-8", errors="replace")
            finally:
                self.lib.tend_free(ptr)
        else:
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
                f.write(text)
            try:
                args = [a.format(law=law_path or "", rules=rules_path, input=f.name, python=sys.executable)
                        for a in self.spec.cmd]
                proc = subprocess.run(args, capture_output=True, text=True, timeout=self.timeout)
            except subprocess.TimeoutExpired:
                return {"error": f"engine timed out after {self.timeout:.0f}s"}
            finally:
                os.unlink(f.name)
            if proc.returncode != 0:
                return {"error": f"engine exited {proc.returncode}: {proc.stderr.strip()[:300]}"}
            raw = proc.stdout
        try:
            out = json.loads(raw)
        except json.JSONDecodeError as e:
            return {"error": f"engine printed invalid JSON ({e}): {raw[:200]!r}"}
        return out if isinstance(out, dict) else {"error": f"engine printed {type(out).__name__}, not an object"}


def find_engine(args) -> tuple[EngineSpec | None, str]:
    """Pick the engine to test; returns (spec, note). spec is None for a reference-only run."""
    engine_root = Path(args.engine_root)
    tendc = args.tendc or next((str(engine_root / d / "tendc") for d in ENGINE_DIRS
                                if (engine_root / d / "tendc").is_file()), None)
    if args.engine_cmd:
        spec = EngineSpec("cmd", f"command: {args.engine_cmd}", cmd=tuple(shlex.split(args.engine_cmd)), tendc=tendc)
        return spec, ""
    lib = args.engine_lib or next((str(engine_root / d / name) for d in ENGINE_DIRS for name in LIB_NAMES
                                   if (engine_root / d / name).is_file()), None)
    cli = args.engine_cli or next((str(engine_root / d / "tendvm") for d in ENGINE_DIRS
                                   if (engine_root / d / "tendvm").is_file()), None)
    looked = ", ".join(f"{d}/" for d in ENGINE_DIRS)
    if (lib or cli) and not tendc:
        return None, f"found {lib or cli} but no tendc to compile law images (looked in {looked})"
    if lib and not args.prefer_cli:
        return EngineSpec("lib", f"C++ engine via ctypes: {lib}", lib=lib, tendc=tendc), ""
    if cli:
        cmd = (cli, "eval", "--law", "{law}", "--input", "{input}")
        return EngineSpec("cmd", f"C++ engine CLI: {cli}", cmd=cmd, tendc=tendc), ""
    return None, f"no C++ engine found (looked for libtend and tendvm in {looked} under {engine_root})"


def compile_law(tendc: str, rules_path: Path, out_dir: Path) -> tuple[str | None, str]:
    out = out_dir / f"{rules_path.stem}.tlaw"
    try:
        proc = subprocess.run([tendc, str(rules_path), "-o", str(out)], capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        return None, str(e)
    if proc.returncode != 0 or not out.is_file():
        return None, (proc.stderr or proc.stdout).strip()[:500] or f"tendc exited {proc.returncode}"
    return str(out), ""


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

    def __bool__(self) -> bool:
        return bool(self.output or self.trace_index is not None or self.error)


def compare(ref: dict, got: dict, *, check_trace: bool, check_sha: bool) -> Comparison:
    if "error" in got and "lines" not in got:
        return Comparison(error=f"engine error: {got['error']}")
    a, b = dict(ref), dict(got)
    if not check_sha:
        a.pop("law_image_sha256", None)
        b.pop("law_image_sha256", None)
    ta, tb = a.pop("trace", []), b.pop("trace", MISSING)
    result = Comparison(output=json_diff(a, b))
    if check_trace:
        if not isinstance(tb, list):
            result.trace_index = 0
        else:
            for i in range(max(len(ta), len(tb))):
                if i >= len(ta) or i >= len(tb) or json_diff(ta[i], tb[i]):
                    result.trace_index = i
                    break
    return result


def describe(cmp: Comparison, ref: dict, got: dict) -> list[str]:
    if cmp.error:
        return [cmp.error]
    lines = []
    ids = [line.get("item_id") for line in ref.get("lines", [])]
    for path, a, b in cmp.output[:MAX_DIFF_LINES]:
        # Name the item next to a line index so the diff reads without the input open.
        if path.startswith("$.lines[") and "]" in path:
            i = int(path[len("$.lines["):path.index("]")])
            if i < len(ids):
                path = f"{path[:path.index(']') + 1]} ({ids[i]}){path[path.index(']') + 1:]}"
        lines.append(f"{path[2:]}: reference {json.dumps(a)}, engine {json.dumps(b)}")
    if len(cmp.output) > MAX_DIFF_LINES:
        lines.append(f"... and {len(cmp.output) - MAX_DIFF_LINES} more differences")
    if cmp.trace_index is not None:
        i = cmp.trace_index
        ta, tb = ref.get("trace", []), got.get("trace")
        tb = tb if isinstance(tb, list) else []
        ea = json.dumps(ta[i]) if i < len(ta) else MISSING
        eb = json.dumps(tb[i]) if i < len(tb) else MISSING
        lines.append(f"trace[{i}] is the first trace difference:")
        lines.append(f"  reference {ea}")
        lines.append(f"  engine    {eb}")
    return lines


# Running claims

@dataclass
class Failure:
    jurisdiction: str
    index: int
    kind: str  # "mismatch", "invariant", "reference_error"
    engine_input: dict
    details: list[str]
    fields: tuple[str, ...] = ()  # which output fields differ, line indexes folded to [*]


def differing_fields(cmp: Comparison) -> tuple[str, ...]:
    if cmp.error:
        return ("engine error",)
    fields = {re.sub(r"by_expense\.\w+", "by_expense.*", re.sub(r"\[\d+\]", "[*]", path))[2:]
              for path, _, _ in cmp.output}
    if cmp.trace_index is not None:
        fields.add("trace")
    return tuple(sorted(fields))


@dataclass
class Job:
    jurisdiction: str
    rules_path: str
    law_path: str | None
    n: int
    seed: int
    spec: EngineSpec | None
    check_trace: bool
    check_sha: bool
    keep_going: bool


@dataclass
class JobResult:
    jurisdiction: str
    claims: int = 0
    agreed: int = 0
    statuses: Counter = field(default_factory=Counter)
    ops: Counter = field(default_factory=Counter)
    checks: Counter = field(default_factory=Counter)
    failed: int = 0
    failures: list[Failure] = field(default_factory=list)  # the first failure to show each field
    failure_counts: Counter = field(default_factory=Counter)  # failing claims per differing field
    seconds: float = 0.0


def run_job(job: Job) -> JobResult:
    started = time.monotonic()
    rules, sha = load_rules(job.rules_path)
    law = Law(rules, sha)
    engine = Engine(job.spec) if job.spec else None
    result = JobResult(job.jurisdiction)
    for index in range(job.n):
        rng = claim_rng(job.seed, job.jurisdiction, index)
        engine_input = generate(rules, rng)
        result.claims += 1
        failure, ref = check_claim(job, law, engine, engine_input, index, rng)
        if ref is not None:
            result.statuses.update(line["status"] for line in ref["lines"])
            result.ops.update(entry["op"] for entry in ref["trace"])
            exams = {it["item_id"] for it in engine_input["items"] if it["expense"] == "forensic_exam"}
            result.ops["exam_as_medical"] += sum(line["item_id"] in exams and line["expense"] == "medical"
                                                 for line in ref["lines"])
            result.checks.update(f"{name}:{c['status']}" for name, c in ref["checks"].items())
        if failure:
            # Keep inputs only for failures that show a new field, so long runs stay small.
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


def check_claim(job: Job, law: Law, engine: Engine | None, engine_input: dict, index: int,
                rng: random.Random) -> tuple[Failure | None, dict | None]:
    def fail(kind: str, details: list[str]) -> Failure:
        return Failure(job.jurisdiction, index, kind, engine_input, details, (kind.replace("_", " "),))

    try:
        ref = law.evaluate(engine_input)
    except EngineInputError as e:
        return fail("reference_error", [f"the reference rejected a generated input: {e}"]), None
    problems = invariant_errors(law, engine_input, ref)
    shuffled = copy.deepcopy(engine_input)
    rng.shuffle(shuffled["items"])
    if law.evaluate(shuffled) != ref:
        problems.append("output changes when the input items are reordered")
    if problems:
        return fail("invariant", problems), ref
    if engine:
        got = engine.run(job.law_path, job.rules_path, engine_input)
        cmp = compare(ref, got, check_trace=job.check_trace, check_sha=job.check_sha)
        if cmp:
            failure = fail("mismatch", describe(cmp, ref, got))
            failure.fields = differing_fields(cmp)
            return failure, ref
    return None, ref


def shrink(job: Job, law: Law, engine: Engine, engine_input: dict, budget: int = 1500) -> dict:
    """Smallest input found that still makes the engines disagree."""
    calls = 0

    def disagrees(candidate: dict) -> bool:
        nonlocal calls
        calls += 1
        try:
            ref = law.evaluate(candidate)
        except EngineInputError:
            return False
        got = engine.run(job.law_path, job.rules_path, candidate)
        return bool(compare(ref, got, check_trace=job.check_trace, check_sha=job.check_sha))

    current = copy.deepcopy(engine_input)
    progress = True
    while progress and calls < budget:
        progress = False
        for i in range(len(current["items"])):
            candidate = copy.deepcopy(current)
            del candidate["items"][i]
            if disagrees(candidate):
                current, progress = candidate, True
                break

    simpler = (("insurance_paid_cents", 0), ("units", 0), ("confirmed", True), ("is_bill", False), ("description", ""))
    for i in range(len(current["items"])):
        for key, value in simpler:
            if calls >= budget or current["items"][i].get(key) == value:
                continue
            candidate = copy.deepcopy(current)
            candidate["items"][i][key] = value
            if disagrees(candidate):
                current = candidate
    for key, value in (("police_report", "yes"), ("forensic_exam", False)):
        if calls < budget and current["context"].get(key) != value:
            candidate = copy.deepcopy(current)
            candidate["context"][key] = value
            if disagrees(candidate):
                current = candidate
    return current


# Command line

def jurisdiction_files(args) -> list[tuple[str, Path]]:
    rules_dir = Path(args.rules_dir)
    files = sorted(rules_dir.glob("*.json")) if rules_dir.is_dir() else []
    if args.include_fixtures:
        files += [f for f in FIXTURES if f.resolve() not in {p.resolve() for p in files}]
    found, seen = [], set()
    for path in files:
        try:
            st = Law(*load_rules(path)).jurisdiction
        except (OSError, ValueError) as e:  # ValueError includes EngineInputError
            print(f"skip {path}: not a verified jurisdiction file ({e})")
            continue
        if st in seen:
            print(f"skip {path}: {st} already loaded")
            continue
        seen.add(st)
        found.append((st, path))
    if args.only:
        wanted = {s.strip().upper() for s in args.only.split(",")}
        found = [(st, p) for st, p in found if st.upper() in wanted]
    return found


def engine_flags(args) -> str:
    # The options a replay needs to reach the same engine the same way.
    flags = []
    for name in ("engine_root", "engine_lib", "engine_cli", "tendc", "engine_cmd"):
        value = getattr(args, name)
        if value and not (name == "engine_root" and Path(value).resolve() == ROOT):
            flags.append(f"--{name.replace('_', '-')} {shlex.quote(value)}")
    flags += [flag for flag, on in (("--prefer-cli", args.prefer_cli), ("--no-trace", not args.check_trace),
                                    ("--compare-sha", args.compare_sha)) if on]
    return "".join(f" {flag}" for flag in flags)


def report_failure(failure: Failure, job: Job, law: Law, engine: Engine | None, out_dir: Path, shrink_on: bool,
                   replay_flags: str = "") -> None:
    st, index = failure.jurisdiction, failure.index
    title = {"mismatch": "MISMATCH", "invariant": "REFERENCE INVARIANT BROKEN",
             "reference_error": "REFERENCE ERROR"}[failure.kind]
    print(f"\n{title}: {st} claim {index} (seed {job.seed})")
    engine_input = failure.engine_input
    details = failure.details
    if failure.kind == "mismatch" and engine and shrink_on:
        small = shrink(job, law, engine, engine_input)
        if len(small["items"]) < len(engine_input["items"]) or small != engine_input:
            ref = law.evaluate(small)
            got = engine.run(job.law_path, job.rules_path, small)
            details = describe(compare(ref, got, check_trace=job.check_trace, check_sha=job.check_sha), ref, got)
            print(f"shrunk from {len(engine_input['items'])} items to {len(small['items'])}")
            engine_input = small
    for line in details:
        print(f"  {line}")
    out_dir.mkdir(parents=True, exist_ok=True)
    saved = out_dir / f"{st}-{index}.input.json"
    saved.write_text(json.dumps(engine_input, indent=2) + "\n", encoding="utf-8")
    print(f"input saved to {saved}")
    here = os.path.relpath(HERE)
    print(f"regenerate the full claim: PYTHONPATH={here} python3 -m tend_ref gen --rules {job.rules_path} "
          f"--seed {job.seed} --index {index}")
    print(f"replay: python3 {os.path.join(here, 'difftest.py')} --replay {st}:{index} --seed {job.seed} "
          f"--rules-dir {Path(job.rules_path).parent}{replay_flags}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run random claims through the Python reference and the C++ engine and compare.")
    parser.add_argument("--n", type=int, default=1000, help="claims per jurisdiction (default 1000)")
    parser.add_argument("--rules-dir", default=str(ROOT / "rules" / "verified"), help="directory of verified ST.json files")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--only", help="comma-separated jurisdictions, e.g. MI,NY")
    parser.add_argument("--no-fixtures", dest="include_fixtures", action="store_false",
                        help="skip the synthetic ZY and ZZ fixtures (included by default; they reach cases real rules do not)")
    parser.add_argument("--engine-root", default=str(ROOT), help="repo root to search for engine/ builds")
    parser.add_argument("--engine-lib", help="path to libtend (.dylib or .so), called through ctypes")
    parser.add_argument("--engine-cli", help="path to the tendvm CLI")
    parser.add_argument("--prefer-cli", action="store_true", help="use tendvm even when libtend is found (isolates crashes)")
    parser.add_argument("--tendc", help="path to the tendc compiler")
    parser.add_argument("--engine-cmd", help="any engine command; {law} {rules} {input} {python} are filled in per claim")
    parser.add_argument("--no-trace", dest="check_trace", action="store_false", help="ignore trace differences")
    parser.add_argument("--compare-sha", action="store_true", help="also compare law_image_sha256 (off: the reference has no image)")
    parser.add_argument("--keep-going", action="store_true", help="count every failure instead of stopping at the first")
    parser.add_argument("--no-shrink", dest="shrink", action="store_false", help="report the generated input as is")
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 1, help="worker processes (default: all cores)")
    parser.add_argument("--replay", metavar="ST:N", help="rerun one claim and print the full comparison")
    parser.add_argument("--out", default=str(Path(tempfile.gettempdir()) / "tend-difftest"), help="where failing inputs are saved")
    args = parser.parse_args(argv)

    files = jurisdiction_files(args)
    if not files:
        print(f"error: no verified jurisdiction files in {args.rules_dir}", file=sys.stderr)
        return 2
    if not any(Path(path).resolve() not in {f.resolve() for f in FIXTURES} for _, path in files):
        print(f"NOTICE: no verified rules in {args.rules_dir}; only the synthetic fixtures will run.")
    spec, note = find_engine(args)
    if spec is None and (args.engine_lib or args.engine_cli):
        print(f"error: {note}; pass --tendc", file=sys.stderr)
        return 2

    work = Path(tempfile.mkdtemp(prefix="tend-laws-"))
    laws: dict[str, str | None] = {}
    tendc_failures = []
    if spec and spec.needs_image:
        if not spec.tendc:
            print("error: this engine needs compiled law images but no tendc was found; pass --tendc", file=sys.stderr)
            return 2
        for st, path in files:
            law_path, err = compile_law(spec.tendc, path, work)
            if law_path:
                laws[st] = law_path
            else:
                tendc_failures.append(st)
                print(f"TENDC FAILED for {st} ({path}): {err}")
        files = [(st, p) for st, p in files if st in laws]

    def job_for(st: str, path: Path, n: int) -> Job:
        return Job(st, str(path), laws.get(st), n, args.seed, spec, args.check_trace, args.compare_sha, args.keep_going)

    if args.replay:
        st, _, index = args.replay.partition(":")
        match = [(s, p) for s, p in files if s.upper() == st.upper()]
        if not match or not index.isdigit():
            print(f"error: --replay wants ST:N with ST in {', '.join(s for s, _ in files)}", file=sys.stderr)
            return 2
        job = job_for(match[0][0], match[0][1], 0)
        rules, sha = load_rules(job.rules_path)
        law = Law(rules, sha)
        engine = Engine(spec) if spec else None
        rng = claim_rng(args.seed, job.jurisdiction, int(index))
        engine_input = generate(rules, rng)
        failure, _ = check_claim(job, law, engine, engine_input, int(index), rng)
        if failure:
            report_failure(failure, job, law, engine, Path(args.out), args.shrink, engine_flags(args))
            return 1
        print(f"{job.jurisdiction} claim {index}: {'engines agree' if engine else 'reference invariants hold'}")
        return 0

    print(f"tend difftest: {args.n} claims per jurisdiction, seed {args.seed}, {len(files)} jurisdictions")
    if spec:
        print(f"engine: {spec.label}" + (f" (law images from {spec.tendc})" if spec.needs_image else ""))
    else:
        print(f"NOTICE: {note}.")
        print("NOTICE: running the reference only. Each claim is checked against the reference's own")
        print("        invariants; nothing is compared until the C++ engine is built.")

    jobs = [job_for(st, path, args.n) for st, path in files]
    if not jobs:
        print("\nFAILED: tendc compiled no jurisdiction, so nothing ran")
        return 1
    started = time.monotonic()
    try:
        if args.jobs > 1 and len(jobs) > 1:
            with ProcessPoolExecutor(max_workers=min(args.jobs, len(jobs))) as pool:
                results = list(pool.map(run_job, jobs))
        else:
            results = [run_job(job) for job in jobs]
    except BrokenProcessPool:
        print("\nERROR: a worker process died, most likely a crash inside the engine library.")
        print("Rerun with --prefer-cli (one tendvm process per claim) to find the claim that crashes it.")
        return 1

    width = max(len(r.jurisdiction) for r in results)
    for r in results:
        status = "FAIL" if r.failures else ("agree" if spec else "ok")
        top = ", ".join(f"{k} {v}" for k, v in r.statuses.most_common())
        print(f"{r.jurisdiction:<{width}}  {r.claims:>6} claims  {status:<5}  {r.seconds:5.1f}s  {top}")

    totals = Counter()
    for r in results:
        totals.update(r.ops)
    expected_ops = ["out_of_window", "held", "exam_as_medical", "excluded", "unknown_rule", "needs_confirmation",
                    "eligible", "collateral", "unit_cap", "rate_unverified", "expense_cap", "total_cap"]
    print("decisions seen: " + ", ".join(f"{op} {totals[op]}" for op in expected_ops))
    never = [op for op in expected_ops if not totals[op]]
    if never:
        print("never reached in this run: " + ", ".join(never))
    check_totals = Counter()
    for r in results:
        check_totals.update(r.checks)
    print("checks seen: " + ", ".join(f"{k} {v}" for k, v in sorted(check_totals.items())))

    failures = [f for r in results for f in r.failures]
    failure_count = sum(r.failed for r in results)
    claims = sum(r.claims for r in results)
    elapsed = time.monotonic() - started
    if args.keep_going and failures:
        # Failing claims per differing field, so each kind of disagreement shows up once.
        by_field: dict[str, Counter] = {}
        examples: dict[str, Failure] = {}
        for r in results:
            for name, count in r.failure_counts.items():
                by_field.setdefault(name, Counter())[r.jurisdiction] += count
            for f in r.failures:
                for name in f.fields:
                    examples.setdefault(name, f)
        print("\nfailing claims by differing field (count, jurisdictions, example for --replay):")
        for name, states in sorted(by_field.items(), key=lambda kv: (-sum(kv[1].values()), kv[0])):
            names = sorted(states)
            shown = ", ".join(names[:10]) + (f" +{len(names) - 10}" if len(names) > 10 else "")
            example = examples[name]
            print(f"  {sum(states.values()):>7}  {name:<34} [{shown}]  e.g. {example.jurisdiction}:{example.index}")
    if failures:
        first = failures[0]
        job = next(j for j in jobs if j.jurisdiction == first.jurisdiction)
        rules, sha = load_rules(job.rules_path)
        report_failure(first, job, Law(rules, sha), Engine(spec) if spec else None, Path(args.out), args.shrink,
                       engine_flags(args))
        if failure_count > 1:
            print(f"({failure_count - 1} more failures not shown"
                  + ("" if args.keep_going else "; --keep-going counts them all") + ")")
    verdict = "FAILED" if failures or tendc_failures else "OK"
    compared = ("reference only, not compared" if not spec
                else "compared with --engine-cmd" if args.engine_cmd else "compared with the C++ engine")
    print(f"\n{verdict}: {claims} claims in {elapsed:.1f}s, {failure_count} failures"
          + (f", tendc failed for {', '.join(tendc_failures)}" if tendc_failures else "") + f" ({compared})")
    return 1 if failures or tendc_failures else 0


if __name__ == "__main__":
    sys.exit(main())
