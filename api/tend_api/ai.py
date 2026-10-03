"""Cloud AI for devices without on-device AI (docs/PRIVACY.md, "Cloud AI, only if you ask").

Every request must carry consent: true, or nothing is read and nothing is sent. Nothing is logged
or stored: no cache file, no database row. The deterministic rules run first, so a statement line a
rule can sort and a bill whose text layer adds up never reach the model. The model (Gemini, low
thinking, ten seconds, one fallback model) only fills a fixed schema: an expense label from the
enum, or a bill's lines copied as printed. Code parses every amount into integer cents and checks
that the lines add up to the bill's total; when they do not, the bill is marked unreliable.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .bill import BillRefused, balance_checks, extract_bill, match_expense
from .classify import (
    DEFAULT_CACHE_PATH,
    EXPENSES,
    FALLBACK_MODEL,
    MODEL_LABELS,
    MODEL_TIMEOUT_S,
    PRIMARY_MODEL,
    ClassificationCache,
    Classifier,
    ModelFn,
    classified_item,
    gemini_backend,
    label_statement,
    statement_facts,
)
from .errors import TendError
from .models import AiBillRequest, AiClassifyRequest
from .money import parse_cents, sha256_hex
from .share import b64decode_any

CONSENT_MESSAGE = "Cloud AI needs your clear yes first. Nothing was read or sent."
MAX_BILL_BYTES = 10 * 1024 * 1024
BillModel = Callable[[bytes, str], tuple[dict[str, Any], str]]

BILL_SYSTEM = """You read one bill for a tool that helps crime survivors recover costs. Copy what is printed.
Do not add, compute, or guess any amount. For each charge line, copy its description and the amount the
patient owes for that line, exactly as printed, for example "$325.00". Copy the provider's name and the
amount due exactly as printed. Use an empty string for anything you cannot read. Pick an expense type
for each line from the list. Never describe what happened to anyone."""

BILL_SCHEMA = {
    "type": "object",
    "properties": {
        "provider": {"type": "string"},
        "amount_due": {"type": "string"},
        "lines": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "description": {"type": "string"},
                    "amount": {"type": "string"},
                    "expense": {"type": "string", "enum": list(MODEL_LABELS)},
                },
                "required": ["description", "amount", "expense"],
            },
        },
    },
    "required": ["provider", "amount_due", "lines"],
}


class AiError(TendError):
    pass


def gemini_bill_reader(
    api_key: str, primary: str = PRIMARY_MODEL, fallback: str = FALLBACK_MODEL, timeout_s: float = MODEL_TIMEOUT_S, client: Any = None
) -> BillModel:
    from google import genai
    from google.genai import types

    client = client or genai.Client(
        api_key=api_key, http_options=types.HttpOptions(timeout=int(timeout_s * 1000), retry_options=types.HttpRetryOptions(attempts=1))
    )

    def call(model: str, data: bytes, mime: str, thinking: bool) -> dict[str, Any]:
        config = types.GenerateContentConfig(
            system_instruction=BILL_SYSTEM,
            response_mime_type="application/json",
            response_json_schema=BILL_SCHEMA,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW) if thinking else None,
        )
        parts = [types.Part.from_bytes(data=data, mime_type=mime), "Read this bill."]
        resp = client.models.generate_content(model=model, contents=parts, config=config)
        return json.loads(resp.text or "")

    def run(data: bytes, mime: str) -> tuple[dict[str, Any], str]:
        try:
            return call(primary, data, mime, True), primary
        except Exception:  # the primary is often busy at peak; one fallback, then give up
            return call(fallback, data, mime, False), fallback

    return run


def _cents(text: Any) -> int | None:
    try:
        return parse_cents(str(text))
    except ValueError:
        return None


class CloudAI:
    def __init__(
        self,
        api_key: str = "",
        classify_model: ModelFn | None = None,
        bill_model: BillModel | None = None,
        cache_path: Path | None = DEFAULT_CACHE_PATH,
    ):
        self.api_key = api_key
        self._classify_model = classify_model
        self._bill_model = bill_model
        self.cache_path = cache_path

    @property
    def available(self) -> bool:
        return bool(self.api_key) or self._classify_model is not None or self._bill_model is not None

    def status(self) -> dict[str, Any]:
        return {"available": self.available, "primary": PRIMARY_MODEL, "fallback": FALLBACK_MODEL, "timeout_s": MODEL_TIMEOUT_S}

    @staticmethod
    def _consent(consent: bool) -> None:
        if consent is not True:
            raise AiError(CONSENT_MESSAGE, 403)

    def _classifier(self) -> Classifier:
        model = self._classify_model or (gemini_backend(self.api_key) if self.api_key else None)
        # The committed answers for the fictional demo merchants, read-only: new answers stay in this
        # request's memory, are never written to the file, and are not carried to the next person.
        cache = ClassificationCache(self.cache_path)
        cache.path = None
        return Classifier(cache=cache, model=model, use_model=model is not None)

    def classify(self, req: AiClassifyRequest) -> dict[str, Any]:
        self._consent(req.consent)
        rows = [
            {
                "id": t.id,
                "date": t.date.isoformat() if t.date else "",
                "amount_cents": t.amount_cents,
                "description": t.description,
                "merchant": t.merchant or "",
                "category": t.category or "",
                **({"kind": t.kind} if t.kind else {}),
            }
            for t in req.txns
        ]
        classifier = self._classifier()
        incident = req.incident_date.isoformat() if req.incident_date else None
        labels, gaps = label_statement(rows, incident, classifier)
        models = sorted({r.model for r in labels if r.model})
        out_labels, items = [], []
        for f, r, row in zip(statement_facts(rows), labels, rows, strict=True):
            out_labels.append(
                {
                    "id": r.ref,
                    "expense": r.expense,
                    "candidate": r.candidate,
                    "confirmed": False if r.method not in ("registry", "keyword") else r.confirmed,
                    "confidence": r.confidence,
                    "method": r.method,
                    "source": "cloud_ai" if r.method == "model" else "rule",
                    "reason": r.reason,
                    "unit": r.unit,
                    "units": r.units,
                    "tags": list(r.tags),
                }
            )
            cents = row["amount_cents"]
            if r.candidate and isinstance(cents, int) and f.date:
                amount = gaps[r.ref].gap_cents if r.ref in gaps else abs(cents)
                description = " ".join(filter(None, [f.merchant_name, f.description]))
                items.append(classified_item(r.ref, f.date, amount, description, r))
        return {
            "source": "cloud_ai",
            "model": models[0] if models else None,
            "cloud_used": bool(models),
            "model_ok": not classifier.model_errors,
            "labels": out_labels,
            "items": items,
            "note": None if not classifier.model_errors else "Cloud AI did not answer, so the unclear lines are left for you to sort.",
        }

    def read_bill(self, req: AiBillRequest) -> dict[str, Any]:
        self._consent(req.consent)
        data = b64decode_any(req.file)
        if len(data) > MAX_BILL_BYTES:
            raise AiError("This file is too large. The limit is 10 MB.", 413)
        sha = sha256_hex(data)
        partial = None  # what the text layer showed, when its lines do not add up
        if req.mime in ("application/pdf", "text/plain"):
            try:
                bill = extract_bill(data, "pdf" if req.mime == "application/pdf" else "text")
            except Exception:  # no text layer, an unreadable amount, or a file the parser cannot open
                bill = None
            if bill is not None:
                try:
                    balance_checks(bill)
                    return self._from_text(bill, sha, ok=True)
                except BillRefused:
                    partial = self._from_text(bill, sha, ok=False)
        reader = self._bill_model or (gemini_bill_reader(self.api_key) if self.api_key else None)
        if reader is None:
            if partial is not None:
                return partial
            raise AiError("Cloud AI is not set up on this server, so Tend could not read this bill.", 503)
        try:
            answer, model = reader(data, req.mime)
        except Exception as exc:
            if partial is not None:
                return partial
            raise AiError("Cloud AI did not answer. Nothing was kept. Try again, or type the lines in.", 502) from exc
        reading = self._reading(answer, model, sha)
        return partial if partial is not None and reading["status"] != "ok" and not reading["lines"] else reading

    @staticmethod
    def _from_text(bill: Any, sha: str, ok: bool) -> dict[str, Any]:
        return {
            "status": "ok" if ok else "unreliable",
            "provider": bill.provider,
            "total_cents": bill.due_cents,
            "lines": [
                {"line_id": ln.item_id, "description": ln.description, "amount_cents": ln.amount_cents, "expense": ln.expense}
                for ln in bill.lines
            ],
            "adjustments": bill.adjustments,
            "sums_match": ok,
            "source": "rule",
            "model": None,
            "sha256": sha,
        }

    @staticmethod
    def _reading(answer: dict[str, Any], model: str, sha: str) -> dict[str, Any]:
        lines, adjustments, unreadable = [], [], 0
        for raw in answer.get("lines") or []:
            if not isinstance(raw, dict):
                unreadable += 1
                continue
            description = " ".join(str(raw.get("description") or "").split())[:200]
            cents = _cents(raw.get("amount"))
            if cents is None:
                unreadable += 1
                continue
            if cents < 0:
                adjustments.append({"label": description, "amount_cents": -cents})
                continue
            found, _ = match_expense(description)  # the deterministic match wins: an exam line must never be a guess
            guess = raw.get("expense")
            expense = found if found != "unknown" else (guess if guess in EXPENSES else "unknown")
            lines.append(
                {"line_id": f"bill:{sha[:16]}:{len(lines) + 1}", "description": description, "amount_cents": cents, "expense": expense}
            )
        total = _cents(answer.get("amount_due"))
        lines_sum = sum(ln["amount_cents"] for ln in lines) - sum(a["amount_cents"] for a in adjustments)
        sums_match = bool(lines) and unreadable == 0 and total is not None and lines_sum == total
        provider = " ".join(str(answer.get("provider") or "").split())[:120] or None
        return {
            "status": "ok" if sums_match else "unreliable",
            "provider": provider,
            "total_cents": total,
            "lines": lines,
            "adjustments": adjustments,
            "sums_match": sums_match,
            "source": "cloud_ai",
            "model": model,
            "sha256": sha,
        }
