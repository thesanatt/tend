from __future__ import annotations

import ctypes
import hashlib
import importlib
import inspect
import json
import os
import subprocess
import sys
import tempfile
import threading
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import Any, Protocol

from .rules import RulesStore

BUILD_HINT = "make -C engine && make -C engine laws"
# Engine error codes that mean this image or VM cannot serve the claim, so another engine should.
UNAVAILABLE_CODES = {"bad_image", "vm_trap"}
IR_META_KEY = b"ir_sha256"


class EngineError(Exception):
    """The engine ran but refused this input (bad law image, malformed request)."""


class EngineUnavailable(Exception):
    """No engine can serve the request right now (not built, not installed, no law image)."""


class Engine(Protocol):
    name: str

    def evaluate(self, payload: dict[str, Any]) -> dict[str, Any]: ...


class LawIR:
    """rules/ir/ST.json: the canonical law both engines read (SPEC v1.1), made by rules/tools/normalize.py."""

    def __init__(self, ir_dir: Path | None, rules: RulesStore):
        self.ir_dir = ir_dir
        self.rules = rules

    def path(self, st: str) -> Path | None:
        if self.ir_dir is None:
            return None
        path = self.ir_dir / f"{st}.json"
        return path if path.is_file() else None

    def load(self, st: str) -> dict[str, Any] | None:
        """The IR, or None when there is none. Refuses IR built from an older verified file."""
        path = self.path(st)
        if path is None:
            return None
        doc = json.loads(path.read_bytes())
        if doc.get("source_sha256") != self.rules.file_sha256(st):
            raise EngineUnavailable(f"The law IR for {st} is older than its verified rules. Run: python3 rules/tools/normalize.py {st}")
        return doc


class NativeEngine:
    """The C++ VM through its C ABI: tend_eval_json, tend_disasm, tend_version, tend_free."""

    name = "native"

    def __init__(
        self, lib_path: Path, law_dirs: tuple[Path, ...], tendc: Path, rules: RulesStore, cache_dir: Path, ir: LawIR | None = None
    ):
        self.lib_path = lib_path
        self.law_dirs = law_dirs
        self.tendc = tendc
        self.rules = rules
        self.ir = ir or LawIR(None, rules)
        self.compiled_dir = cache_dir / "laws"
        self._lib: ctypes.CDLL | None = None
        self._images: dict[Path, tuple[float, bytes]] = {}
        self._lock = threading.Lock()

    def _library(self) -> ctypes.CDLL:
        if self._lib is not None:
            return self._lib
        with self._lock:
            if self._lib is not None:
                return self._lib
            if not self.lib_path.is_file():
                raise EngineUnavailable(f"The native engine is not built ({self.lib_path} is missing). Build it with: {BUILD_HINT}")
            try:
                lib = ctypes.CDLL(str(self.lib_path))
            except OSError as exc:
                raise EngineUnavailable(f"Could not load {self.lib_path}: {exc}") from exc
            missing = [s for s in ("tend_eval_json", "tend_disasm", "tend_version", "tend_free") if not hasattr(lib, s)]
            if missing:
                raise EngineUnavailable(f"{self.lib_path} does not export {', '.join(missing)}")
            lib.tend_eval_json.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p]
            lib.tend_eval_json.restype = ctypes.c_void_p
            lib.tend_disasm.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
            lib.tend_disasm.restype = ctypes.c_void_p
            lib.tend_version.argtypes = []
            lib.tend_version.restype = ctypes.c_char_p
            lib.tend_free.argtypes = [ctypes.c_void_p]
            lib.tend_free.restype = None
            if hasattr(lib, "tend_inspect_json"):
                lib.tend_inspect_json.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
                lib.tend_inspect_json.restype = ctypes.c_void_p
            self._lib = lib
            return lib

    def _take(self, lib: ctypes.CDLL, ptr: int | None) -> str:
        if not ptr:
            raise EngineError("the native engine returned no result")
        try:
            return ctypes.string_at(ptr).decode("utf-8")
        finally:
            lib.tend_free(ptr)

    def version(self) -> str:
        return self._library().tend_version().decode("utf-8")

    def law_image(self, st: str) -> tuple[bytes, Path]:
        rules_path = self.rules.path(st)
        if not rules_path.is_file():
            raise EngineError(f"no verified rules for {st}")
        rules_bytes = rules_path.read_bytes()
        ir_path = self.ir.path(st)
        ir_hex = hashlib.sha256(ir_path.read_bytes()).hexdigest() if ir_path is not None else None
        candidates = [d / f"{st}.tlaw" for d in self.law_dirs] + [self.compiled_dir / f"{st}.tlaw"]
        for path in candidates:
            image = self._read_image(path)
            if image is not None and _image_matches(image, path, rules_path, rules_bytes, ir_hex):
                return image, path
        if not self.tendc.is_file():
            raise EngineUnavailable(f"No up-to-date law image for {st} and no compiler at {self.tendc}. Build it with: {BUILD_HINT}")
        out = self.compiled_dir / f"{st}.tlaw"
        self._compile(st, rules_path, out)
        image = self._read_image(out)
        if image is None:
            raise EngineUnavailable(f"tendc did not write {out}")
        return image, out

    def _read_image(self, path: Path) -> bytes | None:
        try:
            mtime = path.stat().st_mtime
        except FileNotFoundError:
            return None
        cached = self._images.get(path)
        if cached and cached[0] == mtime:
            return cached[1]
        image = path.read_bytes()
        self._images[path] = (mtime, image)
        return image

    def _compile(self, st: str, rules_path: Path, out: Path) -> None:
        ir_path = self.ir.path(st)
        if ir_path is not None:
            self.ir.load(st)  # say how to fix stale IR before tendc refuses it
            args = [str(self.tendc), "--quiet", str(ir_path), "--verified", str(rules_path)]
        else:
            args = [str(self.tendc), "--quiet", str(rules_path)]  # compilers before the IR read the verified file
        out.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=out.parent, suffix=".tlaw.tmp")
        os.close(fd)
        try:
            try:
                proc = subprocess.run([*args, "-o", tmp], capture_output=True, text=True, timeout=60)
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise EngineUnavailable(f"could not run tendc: {exc}") from exc
            if proc.returncode != 0:
                raise EngineUnavailable(f"tendc failed on {st}: {(proc.stderr or proc.stdout).strip()[:500]}")
            os.replace(tmp, out)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    # The C ABI is reentrant with no global state, so calls need no lock.
    def evaluate(self, payload: dict[str, Any]) -> dict[str, Any]:
        lib = self._library()
        image, _ = self.law_image(payload["jurisdiction"])
        request = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        return _parse_result(self._take(lib, lib.tend_eval_json(image, len(image), request)))

    def disasm(self, st: str) -> str:
        lib = self._library()
        image, _ = self.law_image(st)
        listing = self._take(lib, lib.tend_disasm(image, len(image)))
        if listing.startswith("error: "):
            raise EngineUnavailable(f"the native engine could not read the {st} law image ({listing[7:].strip()})")
        return listing

    def inspect(self, st: str) -> dict[str, Any] | None:
        lib = self._library()
        if not hasattr(lib, "tend_inspect_json"):
            return None
        image, _ = self.law_image(st)
        return _parse_result(self._take(lib, lib.tend_inspect_json(image, len(image))))

    def status(self) -> dict[str, Any]:
        try:
            return {"available": True, "version": self.version(), "library": str(self.lib_path)}
        except EngineUnavailable as exc:
            return {"available": False, "reason": str(exc)}


def _image_matches(image: bytes, image_path: Path, rules_path: Path, rules_bytes: bytes, ir_hex: str | None = None) -> bool:
    # An image compiled from the IR names that IR's sha256 in its META section. When the IR is
    # normalized again (same verified file, new IR), the old image is stale and gets recompiled.
    if ir_hex is not None and IR_META_KEY in image and ir_hex.encode() not in image:
        return False
    # The image header carries the sha256 of the verified JSON; fall back to mtimes if the layout hides it.
    digest = hashlib.sha256(rules_bytes)
    if digest.digest() in image or digest.hexdigest().encode() in image:
        return True
    return image_path.stat().st_mtime >= rules_path.stat().st_mtime


def _parse_result(text: str | bytes) -> dict[str, Any]:
    try:
        result = json.loads(text)
    except json.JSONDecodeError as exc:
        raise EngineError(f"engine returned invalid JSON: {exc}") from exc
    if not isinstance(result, dict):
        raise EngineError("engine returned a non-object result")
    error = result.get("error") if "lines" not in result else None
    if error is not None:
        code = error.get("code") if isinstance(error, dict) else None
        message = error.get("message", "") if isinstance(error, dict) else str(error)
        detail = f"{code}: {message}" if code else message
        if code in UNAVAILABLE_CODES:
            raise EngineUnavailable(f"the native engine could not run this claim ({detail})")
        raise EngineError(detail)
    return result


class ReferenceEngine:
    """The Python reference (refengine/, package tend_ref). Same semantics, used when native is unavailable."""

    name = "reference"

    def __init__(self, refengine_dir: Path, rules: RulesStore, evaluate: Callable[..., Any] | None = None, ir: LawIR | None = None):
        self.refengine_dir = refengine_dir
        self.rules = rules
        self.ir = ir or LawIR(None, rules)
        self._fn = evaluate
        self._reads: str | None = None  # "ir" or "verified": which law document this tend_ref accepted

    def _function(self) -> Callable[..., Any]:
        if self._fn is None:
            self._fn = load_reference(self.refengine_dir)
        return self._fn

    def evaluate(self, payload: dict[str, Any]) -> dict[str, Any]:
        fn = self._function()
        st = payload["jurisdiction"]
        verified = self.rules.get(st)
        if verified is None:
            raise EngineError(f"no verified rules for {st}")
        # SPEC v1.1 references read the IR and v1.0 ones the verified file; offer the IR first and remember
        # which one this tend_ref takes. Stale IR is never offered.
        ir, ir_problem = None, None
        if self._reads != "verified":
            try:
                ir = self.ir.load(st)
            except EngineUnavailable as exc:
                ir_problem = exc
        attempts = ([("ir", ir)] if ir is not None else []) + ([("verified", verified)] if self._reads != "ir" else [])
        if not attempts:
            raise ir_problem or EngineUnavailable(f"No law IR for {st}. Run: python3 rules/tools/normalize.py {st}")
        for i, (kind, doc) in enumerate(attempts):
            try:
                result = call_reference(fn, doc, payload, law_sha256=self.rules.file_sha256(st))
            except ValueError as exc:
                if self._reads is None and i + 1 < len(attempts):
                    continue
                if self._reads is None and ir_problem is not None:
                    raise ir_problem from exc
                raise EngineError(f"reference engine rejected the input: {exc}") from exc
            if self._reads is None and len(attempts) > 1:
                self._reads = kind
            if isinstance(result, dict):
                return _parse_result(json.dumps(result, default=str))
            return _parse_result(result)
        raise AssertionError("unreachable")

    def status(self) -> dict[str, Any]:
        try:
            self._function()
            return {"available": True}
        except EngineUnavailable as exc:
            return {"available": False, "reason": str(exc)}


def load_reference(refengine_dir: Path) -> Callable[..., Any]:
    for candidate in (refengine_dir, refengine_dir / "src"):
        if (candidate / "tend_ref").is_dir() and str(candidate) not in sys.path:
            sys.path.append(str(candidate))
    importlib.invalidate_caches()
    try:
        module = importlib.import_module("tend_ref")
    except ImportError as exc:
        raise EngineUnavailable(f"The Python reference engine is not installed (import tend_ref failed: {exc})") from exc
    fn = getattr(module, "evaluate", None)
    if fn is None or isinstance(fn, ModuleType):
        try:
            fn = getattr(importlib.import_module("tend_ref.evaluate"), "evaluate", None)
        except ImportError:
            fn = None
    if not callable(fn):
        raise EngineUnavailable("tend_ref does not provide an evaluate() function")
    return fn


_LAW_PARAM_WORDS = ("law", "rule", "verified", "jurisdiction_doc", "spec")


def call_reference(fn: Callable[..., Any], law: dict[str, Any], payload: dict[str, Any], law_sha256: str | None = None) -> Any:
    # Accepts evaluate(law, input), evaluate(input, law), or evaluate(input) that loads rules itself.
    params = inspect.signature(fn).parameters
    positional = [p for p in params.values() if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)]
    required = [p for p in positional if p.default is inspect.Parameter.empty]
    # tend_ref labels its output with the rules file's sha256 when given one, instead of hashing canonical JSON.
    kwargs = {"law_sha256": law_sha256} if law_sha256 and "law_sha256" in params else {}
    if len(required) >= 2:
        if any(word in required[0].name.lower() for word in _LAW_PARAM_WORDS):
            return fn(law, payload, **kwargs)
        return fn(payload, law, **kwargs)
    return fn(payload, **kwargs)


class EngineRouter:
    def __init__(self, native: NativeEngine, reference: ReferenceEngine):
        self.native = native
        self.reference = reference

    def evaluate(self, payload: dict[str, Any], prefer: str = "auto") -> tuple[dict[str, Any], str]:
        native_reason = "not requested"
        if prefer in ("auto", "native"):
            try:
                return self.native.evaluate(payload), "native"
            except EngineUnavailable as exc:
                if prefer == "native":
                    raise
                native_reason = str(exc)
        try:
            return self.reference.evaluate(payload), "reference"
        except EngineUnavailable as exc:
            raise EngineUnavailable(f"No law engine is available. Native: {native_reason} Reference: {exc}") from exc

    def status(self) -> dict[str, Any]:
        return {"native": self.native.status(), "reference": self.reference.status()}
