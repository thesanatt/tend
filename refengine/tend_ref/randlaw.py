"""Random law IR documents (IR version 2) for the difftest.

The real corpus never combines some features (no automatic waivers, few count limits, no
tag-only exclusion next to a tagged one on the same expense), so random laws fill in every
combination the IR allows. `mutate_ir` breaks a law in the ways tendc must refuse, to check that
the reference refuses the same laws with the same words.
"""

from __future__ import annotations

import copy
import random

from .law import ANCHORS, RULE_EXPENSES, UNITS

KINDS = ("exam_no_bill", "exam_payment", "total_cap", "expense_cap", "expense_cap", "covered", "covered", "excluded",
         "excluded", "deadline", "reporting", "minimum_loss", "collateral", "info")
# A small set so rules and items collide often.
EXPENSES = ("medical", "forensic_exam", "counseling", "lost_wages", "transportation", "relocation", "security",
            "property_replacement", "dental", "other")
TAGS = ("phone", "purse", "cash", "pain_suffering", "vehicle")
ALTERNATIVES = ("forensic_exam", "protective_order", "advocate", "medical_provider", "other")


def _money(rng: random.Random) -> int:
    r = rng.randrange(6)
    if r == 0:
        return 0
    if r == 1:
        return rng.randint(1, 100)
    if r == 2:
        return rng.randint(100, 50_000)
    if r == 3:
        return rng.randint(50_000, 5_000_000)
    if r == 4:
        return rng.choice((100_000, 150_000, 250_000, 2_500_000))
    return rng.randint(0, 10**15)


def random_law(rng: random.Random, code: str) -> dict:
    rules, skipped = [], []
    tagged = 0  # tendc allows at most 6 tagged exclusions per expense
    for i in range(rng.randint(0, 32)):
        kind = rng.choice(KINDS)
        rid = f"{code}-{i}"
        rule = {"id": rid, "kind": kind}
        if kind == "total_cap":
            rule["cap_cents"] = _money(rng)
        elif kind == "expense_cap":
            rule["expense"] = rng.choice(EXPENSES)
            rule["cap_cents"] = _money(rng)
            if rng.random() < 0.4:
                rule["per"] = "unit"
                rule["unit"] = rng.choice(UNITS)
                if rng.random() < 0.45:
                    rule["count_limit"] = rng.randint(0, 12)
            else:
                rule["per"] = "claim"
                if rng.random() < 0.05:
                    rule["count_limit"] = rng.randint(0, 12)  # ignored on a per-claim cap
            if rng.random() < 0.2:
                alts = [f"{rid}-ALT{j}" for j in range(rng.randint(1, 2))]
                rule["alt_rule_ids"] = alts
                skipped += [{"id": a, "category": "expense_cap", "reason": f"less generous duplicate of {rid}"} for a in alts]
        elif kind == "covered":
            rule["expense"] = rng.choice(EXPENSES)
        elif kind == "excluded":
            with_expense = rng.random() < 0.7 or tagged >= 6
            if with_expense:
                rule["expense"] = rng.choice(EXPENSES)
            tags = [t for t in TAGS if rng.random() < 0.3]
            if not with_expense and not tags:
                tags = [rng.choice(TAGS)]
            if tags and tagged < 6 and (not with_expense or rng.random() < 0.5):
                rule["tags"] = tags
                tagged += 1
            elif not with_expense:
                rule["expense"] = rng.choice(EXPENSES)
        elif kind == "deadline":
            rule["days"] = rng.randint(0, 4000)
            if rng.random() < 0.85:
                rule["from"] = rng.choice(ANCHORS)
        elif kind == "reporting":
            if rng.random() < 0.85:
                rule["required"] = rng.random() < 0.6
            rule["alternatives"] = [a for a in ALTERNATIVES if rng.random() < 0.25]
            if rng.random() < 0.3:
                rule["within_days"] = rng.randint(1, 30)
        elif kind == "minimum_loss":
            if rng.random() < 0.8:
                rule["cap_cents"] = rng.randint(0, 30_000)
            if rng.random() < 0.35 or "cap_cents" not in rule:
                rule["days_lost"] = rng.randint(0, 14)
            rule["waiver"] = rng.choice(("none", "other", "discretionary", "automatic"))
            rule["waiver_for_sexual_assault"] = rng.random() < 0.5
        elif kind == "info":
            rule["category"] = rng.choice(("residency", "conduct_reduction", "submission", "excluded_expense",
                                           "collateral_source", "exam_payment", "filing_deadline"))
        rules.append(rule)
    if rng.random() < 0.2:
        # Periods counted from the report and from discovery in one law, in either rule order, so both
        # deadline flags (always in note order) get compared.
        for anchor in rng.sample(("report", "discovery"), 2):
            rules.append({"id": f"{code}-DL-{anchor}", "kind": "deadline", "days": rng.randint(0, 4000), "from": anchor})
    if rng.random() < 0.3:
        skipped.append({"id": f"{code}-SKIP", "category": "expense_cap", "reason": "applies_to family"})
    return {"ir_version": 2, "jurisdiction": code, "name": f"Random law {code} (fictional)", "rules": rules,
            "skipped": skipped}


def mutate_ir(rng: random.Random, ir: dict) -> dict:
    """One change a careless front end might make; tendc refuses most of them."""
    doc = copy.deepcopy(ir)
    rules = doc["rules"]
    r = rng.randrange(24)
    rule = rng.choice(rules) if rules else None
    if r == 0:
        doc["ir_version"] = rng.choice((1, 3, "2", None, 2.0, True))
    elif r == 1:
        doc["jurisdiction"] = rng.choice(("", "zz", "TOOLONGCODE", "Z Z", 5, "ÉÉÉÉÉ", "ABCDEFGH"))
    elif r == 2:
        doc["rules"] = rng.choice((None, {}, "rules"))
    elif r == 3:
        doc["skipped"] = rng.choice(({}, "x", [{"reason": "no id"}], [5]))
    elif r == 4 and rule:
        rule["kind"] = rng.choice(("mystery", "skipped", "", 5, "Covered"))
    elif r == 5 and rule:
        rule["id"] = rng.choice(("", None, 5))
    elif r == 6 and rules:
        rules.append(copy.deepcopy(rng.choice(rules)))  # a repeated id
    elif r == 7 and rule:
        rule["kind"] = "expense_cap"
        rule["expense"] = rng.choice(RULE_EXPENSES + ("unknown", "groceries"))
        rule["cap_cents"] = rng.choice((5, -1, 10**15, 10**15 + 1, 1.5, "5", None, 2**63, 2**64, -(2**63) - 1))
        rule["per"] = rng.choice(("claim", "unit", "week", None, 5))
        if rng.random() < 0.7:
            rule["unit"] = rng.choice(UNITS + ("fortnight", "", None, 5))
        if rng.random() < 0.3:
            rule["count_limit"] = rng.choice((0, 3, -1, 10**6, 10**6 + 1, 2.5))
        if rng.random() < 0.2:
            rule["alt_rule_ids"] = rng.choice((["nope"], "x", [5], [""]))
    elif r == 8 and rule:
        rule["kind"] = rng.choice(("covered", "excluded"))
        rule["expense"] = rng.choice(("medical", "unknown", "groceries", 5, None, ["medical"]))
        if rng.random() < 0.5:
            rule["tags"] = rng.choice(([], ["phone"], "phone", [""], [5], None))
    elif r == 9 and rule:
        rule["kind"] = "excluded"
        rule.pop("expense", None)
        rule["tags"] = [f"tag{k}" for k in range(rng.randint(20, 40))]
    elif r == 10:
        for k in range(rng.randint(7, 9)):
            rules.append({"id": f"MUT-X{k}", "kind": "excluded", "tags": [f"t{k}"],
                          **({"expense": "medical"} if rng.random() < 0.5 else {})})
    elif r == 11 and rule:
        rule["kind"] = "deadline"
        rule["days"] = rng.choice((10, -1, 4_000_000, 4_000_001, None, 1.5, "10"))
        rule["from"] = rng.choice(ANCHORS + ("age_18", "", None, 3, "Report"))
    elif r == 12 and rule:
        rule["kind"] = "reporting"
        rule["required"] = rng.choice((True, False, "yes", None, 1))
        rule["alternatives"] = rng.choice((["forensic_exam"], "forensic_exam", None, [5, "forensic_exam"], {}))
    elif r == 13 and rule:
        rule["kind"] = "minimum_loss"
        for key in ("cap_cents", "days_lost"):
            if rng.random() < 0.6:
                rule[key] = rng.choice((0, 100, -5, 10**16, 1.0, None, 4_000_001))
            else:
                rule.pop(key, None)
        rule["waiver"] = rng.choice(("none", "automatic", "discretionary", "other", "sometimes", 5, None, ""))
        rule["waiver_for_sexual_assault"] = rng.choice((True, False, None, "true", 1))
    elif r == 14 and rule:
        rule["kind"] = "total_cap"
        rule["cap_cents"] = rng.choice((0, None, -1, 10**15 + 1, "100", 2.0))
    elif r == 15:
        doc["source_sha256"] = rng.choice(("abc", "z" * 64, "A" * 64, 5, ""))
    elif r == 16 and rule:
        rule["kind"] = "info"
        rule["category"] = rng.choice(("collateral_source", "exam_payment", "residency", 5, None))
    elif r == 17:
        rules.insert(rng.randrange(len(rules) + 1), rng.choice((5, "rule", None, [])))
    else:
        # Leave the law valid: the engines must also agree on what they accept.
        pass
    return doc
