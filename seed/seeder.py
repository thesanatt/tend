"""Seed the fictional personas into Nessie and keep offline snapshots of them.

usage (run from seed/):
  uv run python seeder.py plan [PERSONA]          summarize the planned history; no network
  uv run python seeder.py seed PERSONA|all        create or converge in Nessie, then snapshot
  uv run python seeder.py reset PERSONA|all       same as seed: undoes demo writes such as a payment
  uv run python seeder.py snapshot PERSONA|all    rebuild snapshots/PERSONA.json from live Nessie
  uv run python seeder.py pdf PERSONA|all         write bills/PERSONA-riverbend.pdf
  uv run python seeder.py classify PERSONA|all    classify a snapshot and score it against the plan
  uv run python seeder.py items PERSONA|all       write classified/PERSONA.json: the statement's ClassifiedItems

Seeding converges rather than appends. Records are matched by content (date, amount, description,
merchant), missing ones are created, and anything else on the persona's accounts is deleted.
Customers and merchants cannot be deleted in Nessie, so they are found and reused.
Keys come from the nearest .env above this folder and override the shell; TEND_ENV_FILE picks
another file.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

SEED_DIR = Path(__file__).resolve().parent
REPO = SEED_DIR.parent
sys.path.insert(0, str(REPO / "api"))  # run as a script, the api package is not on the path

from bill_pdf import bill_pdf_path, money, write_bill_pdf  # noqa: E402
from history import (ACCOUNTS, AS_OF_DATE, EXPECTED, HISTORY_SEED, INCIDENT_DATE, MERCHANTS,  # noqa: E402
                     RIVERBEND_BILL, PlannedTxn, build_history, fingerprint, merchant_location)
from personas import PERSONAS, Persona, get_persona  # noqa: E402
from tend_api.nessie import (TXN_KINDS, Account, Address, BankSnapshot, Bill, Merchant,  # noqa: E402
                             NessieClient, Txn)

MANIFEST_DIR = SEED_DIR / ".manifest"
SNAPSHOT_DIR = SEED_DIR / "snapshots"
CLASSIFIED_DIR = SEED_DIR / "classified"
CLASSIFIED_FORMAT = "tend-classified/1"
NOTICE = ("Fictional demo data on Capital One's Nessie mock bank. No real person, account, merchant, "
          "or hospital. Nessie stores whole dollars; amount_cents is dollars times 100.")


def load_env() -> Path | None:
    # The project .env wins over the shell: a stale GEMINI_API_KEY exported in a shell profile
    # once shadowed the working key here and every model call failed with "API key not valid".
    explicit = os.environ.get("TEND_ENV_FILE")
    for candidate in ([Path(explicit)] if explicit else [p / ".env" for p in SEED_DIR.parents]):
        if candidate.is_file():
            for line in candidate.read_text().splitlines():
                line = line.strip()
                if line.startswith("export "):
                    line = line[len("export "):].lstrip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    os.environ[key.strip()] = value.strip().strip("'\"")
            return candidate
    return None


@dataclass
class Stats:
    kept: int = 0
    created: int = 0
    updated: int = 0
    deleted: int = 0

    def __str__(self) -> str:
        return f"kept {self.kept}, created {self.created}, updated {self.updated}, deleted {self.deleted}"


@dataclass
class Seeder:
    client: NessieClient
    persona: Persona
    log: Callable[[str], None] = print
    history: list[PlannedTxn] = field(default_factory=build_history)
    stats: Stats = field(default_factory=Stats)
    # Bill ids the committed snapshot (and the web's sample) already point at; kept over any other copy.
    known_bill_ids: frozenset[str] = frozenset()
    # What a run changed, in words, for reset_demo.py to print.
    changes: list[str] = field(default_factory=list)

    def run(self) -> dict:
        started = time.monotonic()
        customer = self._customer()
        accounts = self._accounts(customer.id)
        merchants = self._merchants()
        records = self._txns(accounts, merchants)
        bill = self._bill(accounts)
        self.log(f"{self.persona.id}: {self.stats} in {time.monotonic() - started:.1f}s")
        return {
            "persona": self.persona.id,
            "base_url": self.client.base_url,
            "history_fingerprint": fingerprint(),
            "customer_id": customer.id,
            "accounts": {k: a.id for k, a in accounts.items()},
            "merchants": {k: m.id for k, m in merchants.items()},
            "bill": {RIVERBEND_BILL.key: bill.id},
            "records": records,
            "seeded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

    def _customer(self):
        p = self.persona
        address = Address(**p.address)
        found = self.client.find_customer(p.first_name, p.last_name, address)
        if found:
            self.stats.kept += 1
            return found
        self.stats.created += 1
        return self.client.create_customer(p.first_name, p.last_name, address)

    def _accounts(self, customer_id: str) -> dict[str, Account]:
        existing = self.client.list_accounts(customer_id)
        chosen: dict[str, Account] = {}
        for spec in ACCOUNTS:
            same = [a for a in existing if a.type == spec.type and a.nickname == spec.nickname]
            # The opening balance cannot be edited, so a wrong one means a fresh account.
            keep = next((a for a in same if a.opening_balance_cents == spec.opening_cents), None)
            if keep:
                self.stats.kept += 1
            else:
                keep = self.client.create_account(customer_id, spec.type, spec.nickname, spec.opening_cents)
                self.stats.created += 1
            chosen[spec.key] = keep
        for account in existing:
            if account.id not in {a.id for a in chosen.values()}:
                self._drop_account(account)
        return chosen

    def _drop_account(self, account: Account) -> None:
        # Deleting an account leaves its records readable, so clear them first.
        for kind in TXN_KINDS:
            for t in self.client.list_txns(account.id, kind):
                self.client.delete_txn(kind, t.id)
                self.stats.deleted += 1
        for b in self.client.list_bills(account.id):
            self.client.delete_bill(b.id)
            self.stats.deleted += 1
        self.client.delete_account(account.id)
        self.stats.deleted += 1

    def _merchants(self) -> dict[str, Merchant]:
        existing = self.client.list_merchants()
        chosen: dict[str, Merchant] = {}
        for index, spec in enumerate(MERCHANTS):
            raw_address, lat, lng = merchant_location(self.persona, index)
            address = Address(**raw_address)
            found = next((m for m in existing if m.name == spec.name and m.address == address), None)
            if found is None:
                found = self.client.create_merchant(spec.name, spec.category, address, lat, lng)
                self.stats.created += 1
            elif (found.category, found.lat, found.lng) != (spec.category, lat, lng):
                found = self.client.update_merchant(found.id, category=spec.category, geocode={"lat": lat, "lng": lng})
                self.stats.updated += 1
            else:
                self.stats.kept += 1
            chosen[spec.key] = found
        return chosen

    def _txns(self, accounts: dict[str, Account], merchants: dict[str, Merchant]) -> dict[str, str]:
        records: dict[str, str] = {}
        for spec in ACCOUNTS:
            account = accounts[spec.key]
            for kind in TXN_KINDS:
                pool: dict[tuple, list[Txn]] = {}
                for t in self.client.list_txns(account.id, kind):
                    pool.setdefault(existing_signature(t), []).append(t)
                missing = []
                for p in (p for p in self.history if p.account == spec.key and p.kind == kind):
                    matches = pool.get(planned_signature(p, accounts, merchants))
                    if matches:
                        records[p.key] = matches.pop().id
                        self.stats.kept += 1
                    else:
                        missing.append(p)
                for leftover in (t for group in pool.values() for t in group):
                    self.client.delete_txn(kind, leftover.id)
                    self.stats.deleted += 1
                    self.changes.append(f"deleted {kind} {leftover.id} {money(leftover.amount_cents)} {leftover.description!r}")
                for p in missing:
                    records[p.key] = self._create(p, account, accounts, merchants).id
                    self.stats.created += 1
                    self.changes.append(f"created {kind} {records[p.key]} {money(p.amount_cents)} {p.description!r} (new id)")
        return records

    def _create(self, p: PlannedTxn, account: Account, accounts: dict[str, Account],
                merchants: dict[str, Merchant]) -> Txn:
        c = self.client
        if p.kind == "purchase":
            return c.create_purchase(account.id, merchant_id=merchants[p.merchant].id, amount_cents=p.amount_cents,
                                     date=p.date, description=p.description)
        if p.kind == "deposit":
            return c.create_deposit(account.id, amount_cents=p.amount_cents, date=p.date, description=p.description)
        if p.kind == "withdrawal":
            return c.create_withdrawal(account.id, amount_cents=p.amount_cents, date=p.date, description=p.description)
        return c.create_transfer(account.id, payee_account_id=accounts[p.payee_account].id,
                                 amount_cents=p.amount_cents, date=p.date, description=p.description)

    def _bill(self, accounts: dict[str, Account]) -> Bill:
        plan = RIVERBEND_BILL
        candidates = []
        for key, account in accounts.items():
            for bill in self.client.list_bills(account.id):
                usable = bill.recurring_date == plan.recurring_date and bill.upcoming_payment_date
                # Matched by payee, not nickname: a demo payment writes the held amount into the nickname,
                # and the bill must keep its id through a reset (snapshots and the web's sample name it).
                planned = key == plan.account and bill.payee == plan.payee and usable
                candidates.append((not planned, bill.id not in self.known_bill_ids, bill.nickname != plan.nickname, bill))
        candidates.sort(key=lambda c: c[:3])
        keep = candidates[0][3] if candidates and not candidates[0][0] else None
        for *_, bill in candidates:
            if bill is not keep:
                self.client.delete_bill(bill.id)
                self.stats.deleted += 1
                self.changes.append(f"deleted bill {bill.id} {money(bill.amount_cents)} to {bill.payee!r}")
        if keep is None:
            self.stats.created += 1
            created = self.client.create_bill(accounts[plan.account].id, payee=plan.payee, nickname=plan.nickname,
                                              amount_cents=plan.amount_cents, payment_date=plan.payment_date,
                                              recurring_date=plan.recurring_date, status=plan.status)
            self.changes.append(f"created bill {created.id} {money(plan.amount_cents)} (new id)")
            return created
        planned = (plan.status, plan.amount_cents, plan.payment_date, plan.nickname)
        if (keep.status, keep.amount_cents, keep.payment_date, keep.nickname) != planned:
            # Restores the bill after a demo payment left only the held amount on it, or marked it paid.
            self.stats.updated += 1
            self.changes.append(f"restored bill {keep.id}: {keep.status} {money(keep.amount_cents)} -> "
                                f"{plan.status} {money(plan.amount_cents)}, nickname {plan.nickname!r}")
            return self.client.update_bill(keep.id, status=plan.status, amount_cents=plan.amount_cents,
                                           payment_date=plan.payment_date, nickname=plan.nickname)
        self.stats.kept += 1
        return keep


def existing_signature(t: Txn) -> tuple:
    return (t.date, t.amount_cents, t.description, t.merchant_id if t.kind == "purchase" else None, t.status,
            None if t.kind == "transfer" else t.medium)


def planned_signature(p: PlannedTxn, accounts: dict[str, Account], merchants: dict[str, Merchant]) -> tuple:
    description = p.description
    if p.kind == "transfer" and p.payee_account:
        description = f"{p.description} [payee:{accounts[p.payee_account].id}]"
    merchant_id = merchants[p.merchant].id if p.kind == "purchase" else None
    return (p.date, p.amount_cents, description, merchant_id, "completed", None if p.kind == "transfer" else "balance")


def labels_for(snapshot: BankSnapshot) -> dict[str, str]:
    """Map each snapshot transaction id to its story label by content, the way the seeder matches."""
    accounts = {spec.key: snapshot.account_by_type(spec.type) for spec in ACCOUNTS}
    by_name = {m.name: m for m in snapshot.merchants}
    merchants = {spec.key: by_name[spec.name] for spec in MERCHANTS if spec.name in by_name}
    pool: dict[tuple, list[str]] = {}
    for p in build_history():
        if p.merchant and p.merchant not in merchants:
            continue
        pool.setdefault(planned_signature(p, accounts, merchants), []).append(p.label)
    labels = {}
    for t in snapshot.txns:
        group = pool.get(existing_signature(t))
        if group:
            labels[t.id] = group.pop()
    return labels


def snapshot_meta(persona: Persona, accounts: dict[str, str], bill_id: str, pdf_sha: str) -> dict:
    return {
        "persona_id": persona.id,
        "display_name": persona.display_name,
        "jurisdiction": persona.jurisdiction,
        "state_name": persona.state_name,
        "fictional": True,
        "notice": NOTICE,
        "demo_inputs": {"incident_date": INCIDENT_DATE.isoformat(), "as_of_date": AS_OF_DATE.isoformat()},
        "history_seed": HISTORY_SEED,
        "history_fingerprint": fingerprint(),
        "account_keys": accounts,
        "documents": [{
            "kind": "itemized_bill",
            "bill_id": bill_id,
            "path": bill_pdf_path(Path("seed"), persona).as_posix(),  # relative to the repo root
            "sha256": pdf_sha,
            "statement_date": RIVERBEND_BILL.statement_date,
            "service_date": RIVERBEND_BILL.service_date,
            "due_date": RIVERBEND_BILL.payment_date,
            "total_cents": RIVERBEND_BILL.amount_cents,
            "fictional": True,
        }],
    }


def verify_against_plan(snapshot: BankSnapshot) -> list[str]:
    problems = []
    plan = Counter((p.account, p.kind) for p in build_history())
    keys = {snapshot.account_by_type(spec.type).id: spec.key for spec in ACCOUNTS}
    seen = Counter((keys.get(t.account_id), t.kind) for t in snapshot.txns)
    if seen != plan:
        problems.append(f"record counts differ: plan {dict(plan)} vs Nessie {dict(seen)}")
    labels = labels_for(snapshot)
    if len(labels) != len(snapshot.txns):
        problems.append(f"{len(snapshot.txns) - len(labels)} records do not match the plan by content")
    bills = [(b.payee, b.amount_cents, b.status) for b in snapshot.bills]
    want = [(RIVERBEND_BILL.payee, RIVERBEND_BILL.amount_cents, RIVERBEND_BILL.status)]
    if bills != want:
        problems.append(f"bills differ: {bills} vs {want}")
    return problems


def write_pdf(persona: Persona, root: Path = SEED_DIR) -> str:
    return write_bill_pdf(persona, RIVERBEND_BILL, bill_pdf_path(root, persona))


def take_snapshot(client: NessieClient, persona: Persona, root: Path = SEED_DIR) -> BankSnapshot:
    customer = client.find_customer(persona.first_name, persona.last_name, Address(**persona.address))
    if customer is None:
        raise SystemExit(f"{persona.id} is not in Nessie yet; run: seeder.py seed {persona.id}")
    snapshot = client.snapshot(customer.id)
    accounts = {spec.key: snapshot.account_by_type(spec.type).id for spec in ACCOUNTS}
    bill_id = snapshot.bills[0].id if snapshot.bills else ""
    snapshot.meta = snapshot_meta(persona, accounts, bill_id, write_pdf(persona, root))
    problems = verify_against_plan(snapshot)
    if problems:
        raise SystemExit(f"{persona.id}: live Nessie does not match the plan: " + "; ".join(problems))
    snapshot.save(root / "snapshots" / f"{persona.id}.json")
    return snapshot


def write_manifest(manifest: dict) -> None:
    MANIFEST_DIR.mkdir(exist_ok=True)
    (MANIFEST_DIR / f"{manifest['persona']}.json").write_text(json.dumps(manifest, indent=1) + "\n")


def cmd_plan(persona_ids: list[str]) -> None:
    history = build_history()
    kinds = Counter(p.kind for p in history)
    print(f"history {HISTORY_SEED} ({fingerprint()[:12]}): {len(history)} records {dict(kinds)}, "
          f"{len(MERCHANTS)} merchants, 1 bill of ${RIVERBEND_BILL.amount_cents // 100}")
    for label, n in sorted(Counter(p.label for p in history).items()):
        total = sum(p.amount_cents for p in history if p.label == label)
        print(f"  {label:20} {n:4}  {money(total):>10}")
    print("personas:", ", ".join(f"{p.id} ({p.city}, {p.jurisdiction})" for p in map(get_persona, persona_ids)))


def classified_doc(snapshot: BankSnapshot, classifier=None) -> dict:
    """What the classifier makes of the persona's checking statement, as the device would see it: the
    StatementTxn rows the bank relay serves, turned into ClassifiedItems (web/lib/contracts.ts)."""
    from tend_api.classify import PROMPT_VERSION, Classifier, classify_statement

    checking = snapshot.account_by_type("Checking")
    rows = snapshot.statement(checking.id)
    incident = snapshot.meta["demo_inputs"]["incident_date"]
    # The itemized bill's service date is care on that day, as in the scan.
    anchors = [(d["service_date"], d["bill_id"], "medical") for d in snapshot.meta.get("documents", [])
               if d.get("service_date") and d.get("bill_id")]
    items = classify_statement(rows, incident, classifier or Classifier(use_model=False), anchors)
    return {
        "format": CLASSIFIED_FORMAT,
        "persona_id": snapshot.meta["persona_id"],
        "jurisdiction": snapshot.meta["jurisdiction"],
        "fictional": True,
        "notice": NOTICE,
        "history_fingerprint": fingerprint(),
        "prompt_version": PROMPT_VERSION,
        "incident_date": incident,
        "account_id": checking.id,
        "statement_rows": len(rows),
        "by_expense": dict(sorted(Counter(i["expense"] for i in items).items())),
        "items": items,
    }


def write_classified(persona_id: str) -> dict:
    doc = classified_doc(BankSnapshot.load(SNAPSHOT_DIR / f"{persona_id}.json"))
    CLASSIFIED_DIR.mkdir(exist_ok=True)
    (CLASSIFIED_DIR / f"{persona_id}.json").write_text(json.dumps(doc, indent=1) + "\n")
    return doc


def cmd_classify(persona_ids: list[str], use_model: bool) -> int:
    from tend_api.classify import DEFAULT_CACHE_PATH, ClassificationCache, Classifier, classify_snapshot

    # Fictional data only, so the committed cache keeps the text next to each answer for review.
    classifier = Classifier(cache=ClassificationCache(DEFAULT_CACHE_PATH, record_text=True), use_model=use_model)
    failures = 0
    for pid in persona_ids:
        snapshot = BankSnapshot.load(SNAPSHOT_DIR / f"{pid}.json")
        labels = labels_for(snapshot)
        results = classify_snapshot(snapshot, classifier)
        right = 0
        misses = Counter()
        for txn_id, label in labels.items():
            want_expense, want_candidate = EXPECTED[label]
            got = results[txn_id]
            ok = got.candidate == want_candidate and (not want_candidate or got.expense == want_expense)
            right += ok
            if not ok:
                misses[(label, got.expense, got.candidate, got.method)] += 1
        methods = Counter(r.method for r in results.values())
        print(f"{pid}: {right}/{len(labels)} transactions match the plan's labels; methods {dict(methods)}")
        for (label, expense, candidate, method), n in sorted(misses.items()):
            print(f"  miss x{n}: {label} -> {expense} candidate={candidate} via {method}")
        failures += len(labels) - right
    if classifier.model_errors:
        print("model errors:", *classifier.model_errors, sep="\n  ")
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["plan", "seed", "reset", "snapshot", "pdf", "classify", "items"])
    parser.add_argument("persona", nargs="?", default="all", help="persona id, or all")
    parser.add_argument("--no-model", action="store_true", help="classify: skip Gemini, use rules and cache only")
    args = parser.parse_args(argv)
    persona_ids = list(PERSONAS) if args.persona == "all" else [get_persona(args.persona).id]

    if args.command == "plan":
        cmd_plan(persona_ids)
        return 0
    if args.command == "pdf":
        for pid in persona_ids:
            print(pid, write_pdf(get_persona(pid)))
        return 0
    if args.command == "items":
        # Offline on purpose: the committed cache holds every model answer, so no key and no network.
        for pid in persona_ids:
            doc = write_classified(pid)
            print(f"{pid}: {len(doc['items'])} items from {doc['statement_rows']} statement rows {doc['by_expense']}")
        return 0
    load_env()
    if args.command == "classify":
        return cmd_classify(persona_ids, use_model=not args.no_model)

    with NessieClient.from_env() as client:
        for pid in persona_ids:
            persona = get_persona(pid)
            if args.command in ("seed", "reset"):
                write_manifest(Seeder(client, persona).run())
            snapshot = take_snapshot(client, persona)
            balance = snapshot.balance_cents(snapshot.account_by_type("Checking").id)
            bill = snapshot.bills[0]
            print(f"{pid}: snapshot has {len(snapshot.txns)} records; checking {money(balance)} computed; "
                  f"bill {bill.status} {money(bill.amount_cents)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
