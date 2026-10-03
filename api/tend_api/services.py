from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .actions import ActionService
from .agent import AgentService
from .ai import BillModel, CloudAI
from .bank import Bank, DryRunBank, NessieBank
from .claims import ClaimService
from .classify import ModelFn
from .clock import Clock, utcnow
from .config import Settings
from .db import Repository, open_repository
from .engine import EngineError, EngineRouter, EngineUnavailable, LawIR, NativeEngine, ReferenceEngine
from .money import sha256_hex
from .relay import BankRelay
from .rulebook import ImageFn, Rulebook
from .rules import RulesStore
from .scan import Classifier, ScanService
from .share import ShareService
from .sweep import SweepSchedule

log = logging.getLogger("tend")


@dataclass
class Services:
    settings: Settings
    clock: Clock
    rules: RulesStore
    ir: LawIR
    repo: Repository
    engines: EngineRouter
    claims: ClaimService
    scans: ScanService
    actions: ActionService
    shares: ShareService
    relay: BankRelay
    ai: CloudAI
    rulebook: Rulebook
    agent: AgentService
    sweeps: SweepSchedule


def law_image_info(native: NativeEngine, problems: list[str] | None = None) -> ImageFn:
    """For the loader: the sha256 and size of each state's compiled image, from the native engine build.
    A state the build cannot compile gets no row; its reason goes into problems."""

    def images(st: str) -> list[dict[str, Any]]:
        try:
            image, _ = native.law_image(st)
            return [{"image_sha256": sha256_hex(image), "engine_version": native.version(), "bytes": len(image)}]
        except (EngineUnavailable, EngineError, OSError) as exc:
            if problems is not None:
                problems.append(f"{st}: {exc}")
            return []

    return images


def build_services(
    settings: Settings,
    *,
    repo: Repository | None = None,
    clock: Clock = utcnow,
    classifier: Classifier | None = None,
    banks: dict[str, Bank] | None = None,
    reference_evaluate: Callable[..., Any] | None = None,
    nessie_client_factory: Callable[[], Any] | None = None,
    relay_client_factory: Callable[[], Any] | None = None,
    classify_model: ModelFn | None = None,
    bill_model: BillModel | None = None,
) -> Services:
    rules = RulesStore(settings.rules_dir)
    repo = repo or open_repository(settings.database_url, schema=settings.db_schema, migrate_url=settings.migrate_url)
    secret = bytes.fromhex(settings.secret_hex) if settings.secret_hex else repo.secret()
    ir = LawIR(settings.ir_dir, rules)
    native = NativeEngine(settings.engine_lib, settings.law_dirs, settings.tendc, rules, settings.cache_dir, ir)
    engines = EngineRouter(native, ReferenceEngine(settings.refengine_dir, rules, reference_evaluate, ir))
    banks = banks or {"dry_run": DryRunBank(), "nessie": NessieBank()}
    claims = ClaimService(rules, engines, settings.seed_dir, clock)
    scans = ScanService(settings.seed_dir, clock, classifier, settings.live_scan, nessie_client_factory)
    sweeps = SweepSchedule()
    actions = ActionService(repo, banks, settings.bank_mode, secret, clock, claims.bill_review, scans.persona_accounts, sweeps)
    rulebook = Rulebook(repo, rules, ir)
    if settings.autoload_corpus:
        autoload(rulebook, repo)
    return Services(
        settings=settings,
        clock=clock,
        rules=rules,
        ir=ir,
        repo=repo,
        engines=engines,
        claims=claims,
        scans=scans,
        actions=actions,
        shares=ShareService(repo, clock, settings.public_url, sweeps),
        relay=BankRelay(settings.seed_dir, settings.relay_live, relay_client_factory),
        ai=CloudAI(settings.gemini_api_key, classify_model, bill_model),
        rulebook=rulebook,
        agent=AgentService(rules, ir, engines, rulebook, actions, scans, clock),
        sweeps=sweeps,
    )


def autoload(rulebook: Rulebook, repo: Repository) -> None:
    """SQLite follows rules/ on disk at every start. Neon is loaded by the loader command, and only an empty
    Neon database is filled here, so a first deploy can answer questions before anyone runs it."""
    try:
        if repo.backend == "sqlite":
            rulebook.ensure_loaded()
        elif repo.corpus_counts()["jurisdictions"] == 0:
            rulebook.load()
    except Exception as exc:  # a corpus problem must not keep payments and shares from starting
        log.warning("could not load the rules corpus: %s", type(exc).__name__)
