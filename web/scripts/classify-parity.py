"""Reference outputs for the on-device classifier and bill reader (web/lib/local).

Runs the Python classifier (api/tend_api/classify.py, SPEC v1.2) and bill parser (api/tend_api/bill.py)
on the fictional seed snapshots, bill PDFs and a table of edge cases, and writes what they answered to
web/tests/local/fixtures/classify-parity.json. The TypeScript port must give the same answers,
including the lost pay read from short paychecks after the incident date (estimated workdays).

usage (from the repo root):
    uv run --project api python web/scripts/classify-parity.py
"""
from __future__ import annotations

import copy
import hashlib
import json
import shutil
import sys
import tempfile
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "api"))

from tend_api import classify as C  # noqa: E402
from tend_api.bill import BillRefused, extract_bill, service_date  # noqa: E402
from tend_api.nessie import BankSnapshot, Txn  # noqa: E402

OUT = ROOT / "web" / "tests" / "local" / "fixtures" / "classify-parity.json"
SNAPSHOTS = sorted((ROOT / "seed" / "snapshots").glob("*.json"))
BILL_PDFS = sorted((ROOT / "seed" / "bills").glob("*.pdf")) + sorted(
    (ROOT / "web" / "tests" / "local" / "fixtures").glob("bill-*.pdf"))


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def plain(c: C.Classification) -> dict:
    return {"expense": c.expense, "candidate": c.candidate, "confidence": c.confidence, "method": c.method,
            "reason": c.reason, "confirmed": c.confirmed, "linked_refs": list(c.linked_refs)}


def offline(cache_path: Path | None) -> C.Classifier:
    return C.Classifier(cache=C.ClassificationCache(cache_path), use_model=False)


ITEM_KEYS = ("item_id", "date", "amount_cents", "expense", "confirmed", "is_bill", "units", "unit", "tags",
             "description", "confidence", "reason", "method", "linked_item_ids")


def snapshot_engine_items(snapshot: BankSnapshot, results: dict[str, C.Classification], incident: str | None) -> list[dict]:
    """The scan's items (api/tend_api/scan.py items_from_snapshot): classify.snapshot_items plus the
    method and links each label came from."""
    out = []
    for item in C.snapshot_items(snapshot, results, incident):
        r = results[item["item_id"].removeprefix("nessie:")]
        out.append({**item, "method": r.method, "linked_item_ids": [f"nessie:{x}" for x in r.linked_refs]})
    return out


def run(snapshot: BankSnapshot, cache_path: Path | None, base: dict | None = None) -> dict:
    """Every record's classification and the engine items, pay gaps after the snapshot's incident
    date included. With base, only the records whose answer differs from base are written
    (results_delta); the test lays them over base."""
    incident = C.snapshot_incident_date(snapshot)
    results = C.classify_snapshot(snapshot, offline(cache_path), incident_date=incident)
    items = snapshot_engine_items(snapshot, results, incident)
    keep = ITEM_KEYS
    full = {ref: plain(c) for ref, c in sorted(results.items())}
    out = {"items": [{k: i.get(k) for k in keep} for i in items]}
    if base is None:
        out["results"] = full
    else:
        out["results_delta"] = {ref: r for ref, r in full.items() if base.get(ref) != r}
        out["count"] = len(full)
    return out


def ride_merchant(snapshot: BankSnapshot) -> str:
    return next(m.id for m in snapshot.merchants if m.name == "Wayfare Rides")


def scenarios(snapshot: BankSnapshot, base: dict) -> list[dict]:
    """Small edits of a persona that exercise the set-aside and ride-link paths."""
    checking = snapshot.account_by_type("Checking").id
    rides = ride_merchant(snapshot)
    tend_payment = Txn("pay-1", "withdrawal", checking, "2026-10-03", 118_00, "completed",
                       "Riverbend General Hospital payment [tend:act-7]")
    ride_same_day = Txn("ride-1", "purchase", checking, "2026-10-03", 12_00, "completed", "trip", merchant_id=rides)
    ride_service_day = Txn("ride-14", "purchase", checking, "2026-06-14", 15_00, "completed", "trip",
                           merchant_id=rides)
    out = []
    for name, add, drop_docs in (
        ("tend-payment", [tend_payment, ride_same_day], False),
        ("ride-on-service-date", [ride_service_day], False),
        ("bill-without-document", [ride_service_day], True),
    ):
        edited = replace(snapshot, txns=[*snapshot.txns, *add],
                         meta={**snapshot.meta, "documents": []} if drop_docs else copy.deepcopy(snapshot.meta))
        out.append({"name": name, "add_transactions": [t.__dict__ for t in add], "drop_documents": drop_docs,
                    **run(edited, None, base)})
    return out


def F(kind, merchant="", category="", description="", date=""):
    return C.TxnFacts("x", kind, merchant, category, description, date)


# Every keyword rule, every registry entry, and the places where Python's Unicode-aware \b, \s and
# lower() could differ from a naive JavaScript port.
FACT_CASES = [
    F("purchase", "Clearwater Counseling Group", "health care", "session"),
    F("purchase", "  CLEARWATER   counseling group ", "", "anything"),
    F("bill_line", "Clearwater Counseling Group", "", "intake"),
    F("purchase", "Riverbend General Hospital", "", "visit"),
    F("bill", "Riverbend General Hospital", "", "Riverbend General statement"),
    F("bill", "Riverbend General Hospital", "", "SANE exam"),
    F("bill_line", "Riverbend General Hospital", "", "Medical forensic exam, deductible applied"),
    F("bill_line", "Riverbend General Hospital", "", "Emergency department visit, copay"),
    F("bill_line", "Riverbend General Hospital", "", "Laboratory services, coinsurance"),
    F("bill_line", "Riverbend General Hospital", "", "Facility fee"),
    F("purchase", "Larkfield Market", "groceries", "groceries"),
    F("purchase", "Lumen Streaming", "entertainment", "monthly subscription"),
    F("purchase", "Odd Shop", "", "Sexual assault medical forensic exam"),
    F("purchase", "Odd Shop", "", "forensic examination"),
    F("purchase", "Elm Court Apartments", "property management", "security deposit"),
    F("purchase", "Landlord", "", "first month's rent"),
    F("purchase", "Landlord", "", "first months rent"),
    F("purchase", "City Power", "", "utility setup"),
    F("purchase", "City Power", "", "utilities connection"),
    F("purchase", "Two Rivers Truck Rental", "truck rental", "10 ft truck, 1 day"),
    F("purchase", "Ace", "", "moving van"),
    F("purchase", "Swift Movers", "", "deposit"),
    F("purchase", "Keyline Lock & Safe", "home services", "rekey and deadbolt install"),
    F("purchase", "Lock and Key Co", "", "service"),
    F("purchase", "Home", "", "alarm system"),
    F("purchase", "Home", "", "security camera kit"),
    F("purchase", "Calm Mind", "", "therapist visit"),
    F("purchase", "Calm Mind", "", "counselling"),
    F("purchase", "Calm Mind", "", "behavioral health"),
    F("purchase", "Calm Mind", "", "psychologist"),
    F("purchase", "Hearthstone Pharmacy", "pharmacy", "Rx copay"),
    F("purchase", "Hearthstone Pharmacy", "pharmacy", "prescription pickup"),
    F("purchase", "Hearthstone Pharmacy", "pharmacy", "allergy relief"),
    F("purchase", "Bright Smile", "", "dentist"),
    F("purchase", "Bright Smile", "", "orthodontic"),
    F("purchase", "North Clinic", "", "copay"),
    F("purchase", "Fast", "", "urgent care"),
    F("purchase", "City", "", "ambulance"),
    F("purchase", "Downtown Hotel", "", "1 night"),
    F("purchase", "Extended Stay", "", ""),
    F("purchase", "Little Ones", "", "daycare"),
    F("purchase", "Sitter", "", "babysitting"),
    F("purchase", "Oak", "", "funeral home"),
    F("purchase", "Oak", "", "cremation"),
    F("purchase", "Smith", "", "attorney fee"),
    F("purchase", "Smith", "", "legal aid"),
    F("purchase", "State U", "", "tuition"),
    F("purchase", "Brightline Wireless", "telecom", "new phone"),
    F("purchase", "Brightline Wireless", "telecom", "monthly plan"),
    F("purchase", "Shop", "", "new laptop"),
    F("purchase", "Linen & Loom", "home goods", "sheet set, pillows"),
    F("purchase", "Linen & Loom", "home goods", "comforter"),
    F("purchase", "Store", "", "apparel"),
    F("purchase", "Wayfare Rides", "rideshare", "trip"),
    F("purchase", "Metro", "", "bus fare"),
    F("purchase", "Garage", "", "parking"),
    F("purchase", "Copper Kettle Coffee", "coffee shop", "coffee"),
    F("purchase", "Juniper Noodle House", "restaurant", "takeout"),
    F("withdrawal", "", "", "ATM withdrawal"),
    F("deposit", "", "", "Fernway Books payroll"),
    F("transfer", "", "", "Save to Cushion [payee:abc]"),
    F("purchase", "Northside Hardware", "hardware", "door chain, motion sensor light"),
    F("purchase", "Northside Hardware", "hardware", "light bulbs, tape"),
    F("purchase", "", "", ""),
    F("purchase", "Odd Shop", "", "mystery item"),
    # Python's \b counts letters like é as word characters; JavaScript's plain \b does not.
    F("purchase", "Shop", "", "éclinic visit"),
    F("purchase", "Shop", "", "clinicé"),
    F("purchase", "Café Luna", "", "latte"),
    F("purchase", "Shop", "", "therapyé"),
    F("purchase", "Shop", "", "naïve therapy"),
    # Unicode spaces: Python's \s matches U+2007 and U+001F; JavaScript's \s matches U+FEFF.
    F("purchase", "Shop", "", "urgent care"),
    F("purchase", "Shop", "", "urgent\u001fcare"),
    F("purchase", "Shop", "", "urgent﻿care"),
    F("purchase", "Shop", "", "urgent care"),
    F("purchase", "CLEARWATER COUNSELING GROUP", "", "x"),
    F("purchase", "Shop", "", "THERAPY [tend:abc] [payee:zzz]"),
    F("purchase", "Shop", "", "[payee:x]atm"),
    F("purchase", "Shop", "", "bus\tfare"),
    F("purchase", "İstanbul Kebab", "", "takeout"),
]

REASON_CASES = [
    ("Door chain — adds a lock, 2 pieces for $64", "security"),
    ("This is eligible", "security"),
    ("", "unknown"),
    ("", "made_up_label"),
    ("  bed sheets and pillows purchase.  ", "clothing_bedding"),
    (" ".join(f"word{chr(97 + i % 26)}" for i in range(40)), "security"),
    ("“Smart” lock – front door", "security"),
    ("Costs €20 or £15 at the shop", "unknown"),
    ("It qualifies", "medical"),
    ("Coverage note", "medical"),
    ("Reimbursable item", "medical"),
    ("compensable thing", "medical"),
    ("discovered later", "medical"),
    ("ßharp tool", "security"),
    ("- , ; : . ", "security"),
    ("rideshare to clinic", "transportation"),
    ("café purchase", "unknown"),
    ("x", "other"),
]


def bill_reference(path: Path) -> dict:
    try:
        bill = extract_bill(path.read_bytes(), "pdf")
    except BillRefused as exc:
        return {"file": rel(path), "sha256": sha(path), "refused": str(exc)}
    return {
        "file": rel(path),
        "sha256": sha(path),
        "provider": bill.provider,
        "statement_date": bill.statement_date,
        "total_cents": bill.total_cents,
        "amount_due_cents": bill.amount_due_cents,
        "adjustments": bill.adjustments,
        "service_date": service_date(bill, None),
        "lines": [{"item_id": line.item_id, "date": line.date.isoformat(), "description": line.description,
                   "amount_cents": line.amount_cents, "columns_cents": line.columns_cents, "expense": line.expense}
                  for line in bill.lines],
    }


def main() -> None:
    tmp = Path(tempfile.mkdtemp())
    cache_copy = tmp / "cache.json"
    shutil.copy(C.DEFAULT_CACHE_PATH, cache_copy)
    cache = json.loads(cache_copy.read_text())
    personas = []
    for path in SNAPSHOTS:
        snapshot = BankSnapshot.load(path)
        rules_only = run(snapshot, None)
        personas.append({
            "persona_id": path.stem,
            "file": rel(path),
            "sha256": sha(path),
            "rules_only": rules_only,
            "with_cache": run(snapshot, cache_copy, rules_only["results"]),
            "scenarios": scenarios(snapshot, rules_only["results"]),
        })
    facts = []
    for f in FACT_CASES:
        got = C.classify_deterministic(f)
        facts.append({"kind": f.kind, "merchant": f.merchant_name, "category": f.merchant_category,
                      "description": f.description, "result": plain(got) if got else None})
    body = {
        "generated_by": "web/scripts/classify-parity.py",
        "notice": "Fictional demo data only. Reference answers from api/tend_api/classify.py and bill.py.",
        "prompt_version": C.PROMPT_VERSION,
        "model_answers": [{"kind": e.get("kind"), "merchant": e.get("merchant"), "category": e.get("category"),
                           "description": e.get("description"), "expense": e["expense"], "reason": e["reason"]}
                          for e in cache.get("entries", {}).values()],
        "personas": personas,
        "facts": facts,
        "reasons": [{"text": t, "label": label, "out": C.clean_reason(t, label)} for t, label in REASON_CASES],
        "bills": [bill_reference(p) for p in BILL_PDFS],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(body, separators=(",", ":"), ensure_ascii=True) + "\n")
    print(f"wrote {rel(OUT)}: {len(personas)} personas, {len(facts)} fact cases, "
          f"{len(REASON_CASES)} reason cases, {len(body['bills'])} bills")


if __name__ == "__main__":
    main()
