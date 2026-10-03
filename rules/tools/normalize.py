"""Compile verified jurisdiction files into the canonical law IR both engines read (docs/SPEC.md v1.1).

usage: python3 rules/tools/normalize.py [ST ...]   (default: every file in rules/verified)
writes rules/ir/ST.json and prints a one-line summary per jurisdiction.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VICTIM_WORDS = ("victim", "claimant", "survivor", "applicant")
PER_CLAIM = {"claim", "residence", "crime_scene", "incident", "lifetime"}
PER_UNIT = {"week", "session", "hour", "mile", "day", "month", "item"}
TAG_WORDS = [
    (("cell phone", "mobile phone", "phone"), "phone"),
    (("purse", "wallet", "handbag"), "purse"),
    (("jewelry", "jewellery"), "jewelry"),
    (("cash", "money"), "cash"),
    (("vehicle", "car "), "vehicle"),
    (("pain and suffering",), "pain_suffering"),
]
SA_WORDS = ("sexual", "forensic", "criminal sexual conduct", "sexual_assault", "forensic_exam")
INFO_CATEGORIES = {"conduct_reduction", "emergency_award", "eligible_crime", "residency", "submission", "required_document", "processing_time"}


def applies_to_someone_else(params: dict) -> str | None:
    who = params.get("applies_to")
    if not who:
        return None
    text = json.dumps(who).lower()
    return None if any(w in text for w in VICTIM_WORDS) and "family" not in text and "parent" not in text else text


def tags_for(item: str) -> list[str]:
    t = f" {item.lower()} "
    return sorted({tag for words, tag in TAG_WORDS if any(w in t for w in words)})


def deadline_days(p: dict) -> int | None:
    if p.get("days"):
        return int(p["days"])
    if p.get("months"):
        return int(p["months"]) * 30
    if p.get("years"):
        y = int(p["years"])
        return y * 365 + y // 4
    return None


def waiver(rule: dict) -> tuple[str, bool]:
    p = rule.get("params") or {}
    wf = json.dumps(p.get("waived_for", "")).lower()
    sa = any(w in wf for w in SA_WORDS)
    if not sa:
        return ("none" if not p.get("waived_for") else "other"), False
    q = rule.get("quote", "").lower()
    automatic = ("shall not apply" in q or "does not apply" in q) and "sexual" in q
    return ("automatic" if automatic else "discretionary"), True


def normalize(st: str) -> dict:
    src = ROOT / "rules" / "verified" / f"{st}.json"
    raw = src.read_bytes()
    data = json.loads(raw)
    out, skipped = [], []

    def skip(r, why):
        skipped.append({"id": r["id"], "category": r["category"], "reason": why})

    for r in data["rules"]:
        p = r.get("params") or {}
        cat = r["category"]
        expense = r.get("expense") or p.get("expense")
        other = applies_to_someone_else(p)
        if other:
            skip(r, f"applies_to {other}")
            continue
        if p.get("scope") and cat in ("reporting_requirement", "expense_cap"):
            out.append({"id": r["id"], "kind": "info", "category": cat})
            continue
        if cat == "exam_no_bill":
            out.append({"id": r["id"], "kind": "exam_no_bill"})
        elif cat == "exam_payment":
            out.append({"id": r["id"], "kind": "exam_payment"})
        elif cat == "total_cap":
            if not p.get("amount_cents"):
                skip(r, "total_cap without amount")
            else:
                out.append({"id": r["id"], "kind": "total_cap", "cap_cents": int(p["amount_cents"])})
        elif cat == "expense_cap":
            per = (p.get("per") or "claim").lower()
            if not p.get("amount_cents") or not expense:
                skip(r, "expense_cap without amount or expense")
                continue
            if per in PER_CLAIM:
                ir = {"id": r["id"], "kind": "expense_cap", "expense": expense, "cap_cents": int(p["amount_cents"]), "per": "claim"}
            elif per in PER_UNIT:
                ir = {"id": r["id"], "kind": "expense_cap", "expense": expense, "cap_cents": int(p["amount_cents"]), "per": "unit", "unit": per}
            else:
                skip(r, f"unknown per '{per}'")
                continue
            if p.get("count_limit"):
                ir["count_limit"] = int(p["count_limit"])
            out.append(ir)
        elif cat == "covered_expense":
            if expense:
                out.append({"id": r["id"], "kind": "covered", "expense": expense})
            else:
                out.append({"id": r["id"], "kind": "info", "category": cat})
        elif cat == "excluded_expense":
            tags = tags_for(p.get("item", "")) if p.get("item") else []
            if expense or tags:
                ir = {"id": r["id"], "kind": "excluded"}
                if expense:
                    ir["expense"] = expense
                if tags:
                    ir["tags"] = tags
                out.append(ir)
            else:
                out.append({"id": r["id"], "kind": "info", "category": cat})
        elif cat == "filing_deadline":
            days = deadline_days(p)
            if days:
                out.append({"id": r["id"], "kind": "deadline", "days": days, "from": p.get("from", "crime")})
            else:
                out.append({"id": r["id"], "kind": "info", "category": cat})
        elif cat == "reporting_requirement":
            ir = {"id": r["id"], "kind": "reporting", "required": bool(p.get("required", True)), "alternatives": sorted(p.get("alternatives") or [])}
            if p.get("within_days"):
                ir["within_days"] = int(p["within_days"])
            elif p.get("within_hours"):
                ir["within_days"] = -(-int(p["within_hours"]) // 24)
            out.append(ir)
        elif cat == "minimum_loss":
            mode, sa = waiver(r)
            ir = {"id": r["id"], "kind": "minimum_loss", "waiver": mode, "waiver_for_sexual_assault": sa}
            if p.get("amount_cents"):
                ir["cap_cents"] = int(p["amount_cents"])
            if p.get("days_lost"):
                ir["days_lost"] = int(p["days_lost"])
            if "cap_cents" not in ir and "days_lost" not in ir:
                out.append({"id": r["id"], "kind": "info", "category": cat})
            else:
                out.append(ir)
        elif cat == "collateral_source":
            out.append({"id": r["id"], "kind": "collateral"})
        elif cat in INFO_CATEGORIES:
            out.append({"id": r["id"], "kind": "info", "category": cat})
        else:
            skip(r, f"unknown category {cat}")

    # Several caps on the same (expense, per, unit): keep the most generous one.
    best = {}
    for ir in out:
        if ir["kind"] != "expense_cap":
            continue
        key = (ir["expense"], ir["per"], ir.get("unit"))
        if key not in best or ir["cap_cents"] > best[key]["cap_cents"]:
            best[key] = ir
    final = []
    for ir in out:
        if ir["kind"] == "expense_cap":
            keep = best[(ir["expense"], ir["per"], ir.get("unit"))]
            if ir is not keep:
                keep.setdefault("alt_rule_ids", []).append(ir["id"])
                skipped.append({"id": ir["id"], "category": "expense_cap", "reason": f"less generous duplicate of {keep['id']}"})
                continue
        final.append(ir)
    return {
        "ir_version": 1,
        "jurisdiction": st,
        "name": data["name"],
        "program": data.get("program", {}),
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "rules": final,
        "skipped": skipped,
    }


def main():
    sts = [s.upper() for s in sys.argv[1:]] or sorted(p.stem for p in (ROOT / "rules" / "verified").glob("*.json"))
    outdir = ROOT / "rules" / "ir"
    outdir.mkdir(exist_ok=True)
    for st in sts:
        ir = normalize(st)
        (outdir / f"{st}.json").write_text(json.dumps(ir, indent=1, ensure_ascii=False))
        kinds = {}
        for r in ir["rules"]:
            kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
        print(f"{st}: {len(ir['rules'])} rules, {len(ir['skipped'])} skipped | " + " ".join(f"{k}={v}" for k, v in sorted(kinds.items())))


if __name__ == "__main__":
    main()
