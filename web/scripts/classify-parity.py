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
from tend_api.bill import (  # noqa: E402
    BillRefused,
    balance_checks,
    extract_bill,
    match_expense,
    parse_text_bill,
    service_date,
)
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
    # With re.IGNORECASE Python's "i" also takes the dotless i (U+0131). A dotted capital I lowercases to
    # i plus a combining dot before any rule sees it, so that one matches nothing on either side.
    F("purchase", "Shop", "", "physıcıan visit"),
    F("purchase", "Shop", "", "urgent care clınıc"),
    F("purchase", "Rıverbend General Hospıtal", "", "x"),
    F("purchase", "Shop", "", "PHYSİCİAN"),
    F("purchase", "Shop", "", "ſane exam"),
    F("purchase", "Shop", "", "locKsmith"),
    F("purchase", "Shop", "", "grocıerıes"),
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
    ("elıgible for help", "counseling"),
    ("ELİGİBLE", "counseling"),
    ("Thıs ıs fıne", "security"),
    ("qualıfıes under the law", "medical"),
]

# (expense, kind, text) for item_shape: sessions by kind, the nights a lodging row names, and tags.
SHAPE_CASES = [
    ("counseling", "purchase", "Counseling session"),
    ("counseling", "withdrawal", ""),
    ("counseling", "bill_line", "Counseling session"),
    ("counseling", "bill", "Clearwater Counseling Group"),
    ("counseling", "deposit", ""),
    ("temporary_housing", "purchase", "Harbor Inn 3 nights"),
    ("temporary_housing", "purchase", "3-night stay"),
    ("temporary_housing", "purchase", "12 days"),
    ("temporary_housing", "purchase", "10 - NIGHTS"),
    ("temporary_housing", "purchase", "100 nights"),
    ("temporary_housing", "purchase", "room 7nights"),
    ("temporary_housing", "purchase", "night 2"),
    ("temporary_housing", "purchase", ""),
    # A letter beside the number or the word leaves no word boundary, whatever its script.
    ("temporary_housing", "purchase", "é12 days"),
    ("temporary_housing", "purchase", "99 nightsı"),
    ("temporary_housing", "purchase", "ſ2 nights"),
    # Only the digits 0 to 9 count; the letter i takes its dotted and dotless forms.
    ("temporary_housing", "purchase", "٣ nights"),
    ("temporary_housing", "purchase", "３ nights"),
    ("temporary_housing", "purchase", "2 NİGHTS"),
    ("temporary_housing", "purchase", "2 nıghts"),
    ("lost_wages", "deposit", "payroll"),
    ("property_replacement", "purchase", "new cell phone and wallet"),
    ("property_replacement", "purchase", "car seat"),
    ("property_replacement", "purchase", "cart"),
    ("property_replacement", "purchase", "[payee:phone] cash"),
    ("property_replacement", "purchase", "JEWELLERY box"),
    ("medical", "purchase", "phone, 3 nights"),
    ("transportation", "purchase", "cab"),
]


# Bill text where a port could drift from parse_text_bill: date forms and the years it takes, the
# shapes of an amount and the largest one a browser holds exactly, credits, the lines that carry a
# provider or a total, and the spaces and line breaks Python and JavaScript count differently.
BILL_TEXT_CASES = [
    ("Riverbend General Hospital\n06/14/2026  Emergency department visit  325.00\n06/14/2026  Laboratory panel  43.00\n"
     "Total  368.00\n"),
    "Clinic\n6/14/26  Counseling session  $120.00\n6/21/26  Counseling session  $120.00\nAmount due  $240.00\n",
    "Clinic\n1 2026-06-14  Forensic exam  $1,171.75\n2 2026-06-14  Pharmacy  $12.50\nTotal charges  $1,184.25\n",
    "Clinic\n06/14/2026  X-ray   443.00   400.00   43.00\n06/14/2026  Lab   80.00   0.00   80.00\nBalance due  123.00\n",
    "Clinic\n06/14/2026  Lab  43.00\n06/20/2026  Payment received  -20.00\nTotal  43.00\nAmount due  23.00\n",
    "Clinic\n06/14/2026  Lab  43.00\n06/20/2026  Payment received  (20.00)\nInsurance payment  -$5.00\nYou owe  18.00\n",
    "Clinic\n06/14/2026  Lab  43.00\nAdjustment  ($5.00)\nDiscount  5.00\nTotal  43.00\nPlease pay  33.00\n",
    ("Provider: Lakeside Clinic\nStatement date: 06/20/2026\nBill ID # LC-77\nAccount number: 4471\n"
     "06/14/2026  Dental exam  95.00\nTotal  95.00\n"),
    ("Statement    Facility : Northside Urgent Care\nAccount: 12-A\n06/14/2026  Urgent care visit  150.00\n"
     "Patient responsibility  150.00\n"),
    "FICTIONAL DEMO, not a real bill\nClinic\n06/14/2026  Lab  43.00\nTotal  43.00\n",
    "Clinic\n06/14/2026  Lab ........ 43.00\n06/14/2026 - CT scan - $900\nSubtotal 943.00\nTotal 943.00\n",
    "Clinic\n06/14/2026  Lab  43.00\n06/15/2026  Lab  43.00\nTotal  80.00\n",
    "Clinic\n06/14/2026  Lab  43.00\n",
    "Clinic\nTotal  43.00\n",
    "Clinic\n06/14/2026  Lab  43\nTotal  43.00\n",
    "Clinic\n06/14/2026  Lab  12.5\nTotal  12.50\n",
    "Clinic\n06/14/2026  Lab  1,17.75\nTotal  117.75\n",
    "Clinic\n06/14/2026 43.00\nTotal  43.00\n",
    "Clinic\n06/14/2026x  Lab  43.00\nTotal  43.00\n",
    "Clinic\n06/31/2026  Lab  43.00\nTotal  43.00\n",
    "Clinic\n2/29/24  Lab  43.00\nTotal  43.00\n",
    "Clinic\n2/29/25  Lab  43.00\nTotal  43.00\n",
    "Clinic\n13/01/2026  Lab  43.00\nTotal  43.00\n",
    "Clinic\n6/14/202  Lab  43.00\nTotal  43.00\n",
    "Clinic\n0001-06-14  Lab  43.00\nTotal  43.00\n",
    "Clinic\n06/14/2201  Lab  43.00\nTotal  43.00\n",
    "Clinic\n12/31/1900  Lab  43.00\nTotal  43.00\n",
    "Clinic\n06/14/2026  Lab  (43.00\nTotal  43.00\n",
    "Clinic\n06/14/2026  Lab  90071992547409.91\nTotal  90071992547409.91\n",
    "Clinic\n06/14/2026  Lab  90071992547409.92\nTotal  43.00\n",
    "Clinic\n06/14/2026  Lab  43.00\nTotal  $99999999999999999999\n",
    "Clinic\r\n06/14/2026  Lab  43.00\r06/14/2026  Pharmacy  7.00\x0cTotal  50.00\x0b",
    "Clinic\x8506/14/2026  Lab  43.00 06/14/2026  Pharmacy  7.00 Total  50.00\x1c\x1d\x1e",
    "Clinic\n06/14/2026  Lab  43.00\nTotal  43.00\n",
    "Clinic\n\t06/14/2026\tLab\t43.00\t\n\tTotal\t43.00\n",
    "Café Santé Clinic\n06/14/2026  éclinic visit  43.00\n06/14/2026  naïve therapy  60.00\nTotal  103.00\n",
    "Clinic\n06/14/2026  SANE exam  0.00\n06/14/2026  Lab  43.00\nTotal  43.00\n",
    "Clinic\n06/14/2026  Lab  43.00\n٦/14/2026  Lab  ٣.٥٠\n06/14/2026  Lab  ４３.００\nTotal  43.00\n",
    "Clinic\n06/14/2026  Lab  43.00\nTotal  ٤٣.٠٠\n",
    # Bill text is matched as printed, so "i" in a pattern also takes the dotted capital I and the dotless i.
    "Clınıc\n06/14/2026  PHYSİCİAN VİSİT  43.00\n06/14/2026  Forensıc exam  0.00\nTotal  43.00\n",
    "Clinic\n06/14/2026  Lab  43.00\nİnsurance payment  -$5.00\nPatıent responsıbılıty  38.00\n",
    "FİCTİONAL DEMO\nClinic\n06/14/2026  Lab  43.00\nTotal  43.00\n",
    # A header key that only matches by case folding names no field.
    ("Facılıty : Northside\nſtatement date: 06/20/2026\nBİLL İD # 9\nAccount: 7\n"
     "06/14/2026  Lab  43.00\nAmount due  43.00\n"),
    "",
    "\n\n  \n",
]


def shape(expense: str, kind: str, text: str) -> tuple[str | None, int, list[str]]:
    unit, units, tags = C.item_shape(expense, kind, text)
    return unit, units, list(tags)


def bill_text_reference(text: str) -> dict:
    """What parse_text_bill reads from text, with each line's expense and whether the bill adds up."""
    try:
        bill = parse_text_bill(text, "0" * 64)
    except BillRefused:
        return {"text": text, "refused": True}
    try:
        balance_checks(bill)
        balanced = True
    except BillRefused:
        balanced = False
    return {
        "text": text,
        "refused": False,
        "lines": [{"line_no": ln.line_no, "date": ln.date.isoformat(), "description": ln.description,
                   "amount_cents": ln.amount_cents, "columns_cents": ln.columns_cents,
                   "expense": match_expense(ln.description)[0]} for ln in bill.lines],
        "provider": bill.provider,
        "statement_date": bill.statement_date,
        "bill_id": bill.bill_id,
        "account_ref": bill.account_ref,
        "fictional": bill.fictional,
        "total_cents": bill.total_cents,
        "amount_due_cents": bill.amount_due_cents,
        "adjustments": bill.adjustments,
        "balanced": balanced,
    }


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
        "shapes": [dict(zip(("expense", "kind", "text", "unit", "units", "tags"),
                            (e, k, t, *shape(e, k, t)), strict=True)) for e, k, t in SHAPE_CASES],
        "bills": [bill_reference(p) for p in BILL_PDFS],
        "bill_texts": [bill_text_reference(t) for t in BILL_TEXT_CASES],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(body, separators=(",", ":"), ensure_ascii=True) + "\n")
    print(f"wrote {rel(OUT)}: {len(personas)} personas, {len(facts)} fact cases, "
          f"{len(REASON_CASES)} reason cases, {len(SHAPE_CASES)} shape cases, {len(body['bills'])} bills, "
          f"{len(BILL_TEXT_CASES)} bill texts")


if __name__ == "__main__":
    main()
