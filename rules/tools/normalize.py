"""Compile verified jurisdiction files into the canonical law IR both engines read (docs/SPEC.md v1.1 to v1.3).

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
# People other than the survivor, even when the words sit next to "victim": "secondary victims",
# "associated victims" (WY), "derivative victims", "family members of the victim".
OTHER_PERSON_WORDS = ("family", "parent", "secondary", "associated", "derivative")
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
INFO_CATEGORIES = {"conduct_reduction", "emergency_award", "eligible_crime", "residency", "submission", "required_document", "processing_time", "address_confidentiality", "record_confidentiality"}

# Deadlines the researcher dated from the crime whose own quote also lets the period start at
# discovery ("after the occurrence or discovery of the crime", "whichever is later"). Discovery is
# never before the crime, so these count from discovery: the engines date them from the incident
# (the earliest discovery can be) and flag deadline_from_discovery, so a late date is never shown as
# plainly late (docs/SPEC.md v1.3). The words must still be in the quote, or normalize stops.
DISCOVERY_ALTERNATIVES = {
    "CA-DEADLINE-1": "could have discovered that an injury or death had been sustained as a direct result of crime, whichever is later",
    "IA-DEADLINE-1": "the date of the crime, the discovery of the crime",
    "MN-DEADLINE-1": "within three years of the time when the injury or death is reasonably discoverable",
    "MO-DEAD-1": "the occurrence of the crime or the discovery of the crime",
    "NY-DEADLINE-1": "three years after the occurrence or discovery of the crime",
    # Discovery by law enforcement that the occurrence was a crime; the latest event starts the 180 days.
    "SC-DEAD-1": "the discovery by the law enforcement agency that the occurrence was the result of crime",
}
# Deadline quotes that speak of discovery for a different period than the rule's own (reviewed).
DISCOVERY_ELSEWHERE = {
    "ME-DEAD-1": "its 3 years run from the injury; the 60 days from discovery in the same quote are ME-DEAD-2",
}

# Caps whose own quote describes something other than the program's limit on the survivor's cost:
# an expedited approval, an emergency payment made apart from the award, or an initial award.
# "info" lists the rule without applying it; "no_count_limit" keeps the rate but not the count.
# The words must still be in the quote, or normalize stops.
NOT_PROGRAM_CAPS = {
    # Work interruption claims (State Plan 400.7): a Compensation Officer may approve up to 10
    # working days, $700 at $70 a day, on their own. Longer absences are paid under 400.8, which
    # NV-CAP-WAGE-1 and -2 carry ($350 a week, 52 weeks, $18,200). As a cap it cut a 15-day claim to $700.
    "NV-CAP-WAGE-3": ("info", "A Compensation Officer may approve lost wage or income reimbursement claims"),
    # Emergency medical care (art. 56A.305): the Attorney General's own payment for care given at the
    # exam, made apart from the award. It is not a limit on the survivor's medical costs, which only
    # the $50,000 total (TX-CAP-1) limits.
    "TX-EXAM-3": ("info", "A payment made under Subsection (a) may not exceed $25,000."),
    # An initial award: more therapy is considered with a treatment plan (the same page, "If
    # Requesting Additional Therapy Above Initial Award"). The $200 a session rate stays.
    "AK-COUNSEL-1": ("no_count_limit", "Initial maximum award is 24 sessions."),
}


def quote_says(rule: dict, words: str) -> None:
    if words not in rule.get("quote", ""):
        raise ValueError(f"{rule['id']}: the quote no longer says {words!r}; review this rule in rules/tools/normalize.py")


def applies_to_someone_else(params: dict) -> str | None:
    who = params.get("applies_to")
    if not who:
        return None
    text = json.dumps(who).lower()
    names_survivor = any(w in text for w in VICTIM_WORDS) and not any(w in text for w in OTHER_PERSON_WORDS)
    return None if names_survivor else text


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
        how = NOT_PROGRAM_CAPS.get(r["id"])
        if how:
            quote_says(r, how[1])
            if how[0] == "info":
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
            if p.get("count_limit") and not (how and how[0] == "no_count_limit"):
                ir["count_limit"] = int(p["count_limit"])
            out.append(ir)
        elif cat == "covered_expense":
            if expense:
                out.append({"id": r["id"], "kind": "covered", "expense": expense})
            else:
                out.append({"id": r["id"], "kind": "info", "category": cat})
        elif cat == "excluded_expense":
            tags = tags_for(p.get("item", "")) if p.get("item") else []
            if expense and p.get("item") and not tags:
                out.append({"id": r["id"], "kind": "info", "category": cat})
                continue
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
            start = str(p.get("from") or "crime").lower()
            if r["id"] in DISCOVERY_ALTERNATIVES:
                quote_says(r, DISCOVERY_ALTERNATIVES[r["id"]])
                start = "discovery"
            if days and start in ("crime", "incident", "discovery", "injury", "offense", "report"):
                out.append({"id": r["id"], "kind": "deadline", "days": days, "from": start})
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
            if "cap_cents" not in ir and "days_lost" not in ir and "no minimum" in r.get("quote", "").lower():
                ir["cap_cents"] = 0
                out.append(ir)
            elif "cap_cents" not in ir and "days_lost" not in ir:
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
        "ir_version": 2,
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
