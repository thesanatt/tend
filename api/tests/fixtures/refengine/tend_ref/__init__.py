"""Test double for refengine's tend_ref.evaluate. Follows docs/SPEC.md closely enough for API tests."""
import datetime as dt

INFO = ("collateral_source", "conduct_reduction", "emergency_award", "eligible_crime", "residency")
UNIT_PER = ("week", "session", "hour", "mile", "day")


def _expense(rule):
    return rule.get("expense") or (rule.get("params") or {}).get("expense")


def _add_years(d, years):
    try:
        return d.replace(year=d.year + years)
    except ValueError:
        return d.replace(year=d.year + years, day=28)


def evaluate(law, payload):
    rules = law["rules"]
    ctx = payload["context"]
    incident = dt.date.fromisoformat(ctx["incident_date"])
    as_of = dt.date.fromisoformat(ctx["as_of_date"])
    cat = lambda c: [r for r in rules if r["category"] == c]  # noqa: E731
    no_bill, payment, collateral = cat("exam_no_bill"), cat("exam_payment"), cat("collateral_source")
    lines, trace = [], []

    for it in sorted(payload["items"], key=lambda i: (i["date"], i["item_id"])):
        d = dt.date.fromisoformat(it["date"])
        expense = it["expense"]
        line = {"item_id": it["item_id"], "expense": expense, "status": None, "requested_cents": it["amount_cents"],
                "allowed_cents": 0, "rule_ids": [], "cap_rule_id": None, "flags": []}
        if d < incident or d > as_of:
            line["status"] = "out_of_window"
        elif expense == "forensic_exam" and (no_bill or payment):
            line["status"] = "held"
            line["rule_ids"] = [r["id"] for r in no_bill] + [r["id"] for r in payment]
        else:
            if expense == "forensic_exam":
                expense = line["expense"] = "medical"
            excluded = [r for r in cat("excluded_expense") if _expense(r) == expense]
            cover = [r for r in rules if r["category"] in ("covered_expense", "expense_cap") and _expense(r) == expense]
            if excluded:
                line["status"], line["rule_ids"] = "excluded", [excluded[0]["id"]]
            elif expense == "unknown" or not cover:
                line["status"] = "unknown_rule"
            elif not it["confirmed"]:
                line["status"], line["rule_ids"] = "needs_confirmation", [r["id"] for r in cover]
            else:
                line["status"], line["rule_ids"] = "eligible", [r["id"] for r in cover]
                line["allowed_cents"] = it["amount_cents"]
                if collateral:
                    line["allowed_cents"] = max(0, line["allowed_cents"] - it.get("insurance_paid_cents", 0))
                    line["rule_ids"].append(collateral[0]["id"])
                line["_units"] = it.get("units", 0)
        trace.append({"op": line["status"], "item_id": it["item_id"], "rule_id": (line["rule_ids"] or [None])[0], "delta_cents": 0})
        lines.append(line)

    eligible = [ln for ln in lines if ln["status"] == "eligible"]
    for cap in cat("expense_cap"):
        p = cap.get("params") or {}
        per, amount = p.get("per"), p.get("amount_cents")
        if amount is None:
            continue
        mine = [ln for ln in eligible if ln["expense"] == _expense(cap)]
        if per == "claim":
            used = 0
            for ln in mine:
                room = max(0, amount - used)
                if ln["allowed_cents"] > room:
                    trace.append({"op": "cap", "item_id": ln["item_id"], "rule_id": cap["id"], "delta_cents": room - ln["allowed_cents"]})
                    ln["allowed_cents"], ln["cap_rule_id"] = room, cap["id"]
                used += ln["allowed_cents"]
        elif per in UNIT_PER:
            for ln in mine:
                if ln["_units"] > 0:
                    limit = amount * ln["_units"]
                    if ln["allowed_cents"] > limit:
                        ln["allowed_cents"], ln["cap_rule_id"] = limit, cap["id"]
                elif f"rate_unverified:{cap['id']}" not in ln["flags"]:
                    ln["flags"].append(f"rate_unverified:{cap['id']}")
    totals_caps = [r for r in cat("total_cap") if (r.get("params") or {}).get("amount_cents") is not None]
    if totals_caps:
        cap = min(totals_caps, key=lambda r: r["params"]["amount_cents"])
        used = 0
        for ln in eligible:
            room = max(0, cap["params"]["amount_cents"] - used)
            if ln["allowed_cents"] > room:
                ln["allowed_cents"], ln["cap_rule_id"] = room, cap["id"]
            used += ln["allowed_cents"]
    for ln in lines:
        ln.pop("_units", None)

    allowed = sum(ln["allowed_cents"] for ln in eligible)
    by_expense = {}
    for ln in eligible:
        by_expense[ln["expense"]] = by_expense.get(ln["expense"], 0) + ln["allowed_cents"]

    deadline_rules = [r for r in cat("filing_deadline") if (r.get("params") or {}).get("years") or (r.get("params") or {}).get("days")]
    if deadline_rules:
        def end(r):
            p = r["params"]
            return _add_years(incident, p["years"]) if p.get("years") else incident + dt.timedelta(days=p["days"])
        last = max(end(r) for r in deadline_rules)
        deadline = {"status": "ok" if as_of <= last else "late", "deadline_date": last.isoformat(), "rule_ids": [r["id"] for r in deadline_rules]}
    else:
        deadline = {"status": "unknown", "deadline_date": None, "rule_ids": []}

    minimum = {"status": "met", "rule_ids": []}
    for r in cat("minimum_loss"):
        p = r.get("params") or {}
        minimum["rule_ids"].append(r["id"])
        if p.get("amount_cents") is None:
            minimum["status"] = "unknown"
        elif allowed < p["amount_cents"]:
            waived = ctx.get("forensic_exam") and any("sexual_assault" in w for w in p.get("waived_for") or [])
            minimum["status"] = "waived" if waived else "not_met"

    reporting_rules = cat("reporting_requirement")
    reporting = {"status": "unknown", "rule_ids": [r["id"] for r in reporting_rules]}
    if reporting_rules:
        alternative = ctx.get("forensic_exam") and any("forensic_exam" in ((r.get("params") or {}).get("alternatives") or []) for r in reporting_rules)
        if ctx.get("police_report") == "yes" or alternative:
            reporting["status"] = "satisfied"
        elif ctx.get("police_report") == "no":
            reporting["status"] = "required"

    return {
        "jurisdiction": payload["jurisdiction"],
        "law_image_sha256": "reference",
        "lines": lines,
        "totals": {
            "requested_cents": sum(ln["requested_cents"] for ln in lines if ln["status"] not in ("out_of_window",)),
            "allowed_cents": allowed,
            "held_cents": sum(ln["requested_cents"] for ln in lines if ln["status"] == "held"),
            "by_expense": by_expense,
        },
        "checks": {"deadline": deadline, "minimum_loss": minimum, "reporting": reporting},
        "info_rule_ids": [r["id"] for r in rules if r["category"] in INFO],
        "trace": trace,
    }
