from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .actions import ActionService
from .agent import AgentService
from .bank import Bank, DryRunBank, NessieBank
from .claims import ClaimService
from .clock import Clock, utcnow
from .config import Settings
from .engine import EngineRouter, NativeEngine, ReferenceEngine
from .rules import RulesStore
from .scan import Classifier, ScanService
from .share import ShareService
from .storage import Repository, SQLiteRepository


@dataclass
class Services:
    settings: Settings
    clock: Clock
    rules: RulesStore
    repo: Repository
    engines: EngineRouter
    claims: ClaimService
    scans: ScanService
    actions: ActionService
    shares: ShareService
    agent: AgentService


def build_services(
    settings: Settings,
    *,
    repo: Repository | None = None,
    clock: Clock = utcnow,
    classifier: Classifier | None = None,
    banks: dict[str, Bank] | None = None,
    reference_evaluate: Callable[..., Any] | None = None,
    nessie_client_factory: Callable[[], Any] | None = None,
) -> Services:
    rules = RulesStore(settings.rules_dir)
    repo = repo or SQLiteRepository(settings.db_path)
    secret = bytes.fromhex(settings.secret_hex) if settings.secret_hex else repo.secret()
    engines = EngineRouter(
        NativeEngine(settings.engine_lib, settings.law_dirs, settings.tendc, rules, settings.cache_dir),
        ReferenceEngine(settings.refengine_dir, rules, reference_evaluate),
    )
    banks = banks or {"dry_run": DryRunBank(), "nessie": NessieBank()}
    claims = ClaimService(repo, rules, engines, settings.seed_dir, clock)
    actions = ActionService(repo, banks, settings.bank_mode, secret, clock)
    shares = ShareService(repo, clock, settings.public_url)
    return Services(
        settings=settings,
        clock=clock,
        rules=rules,
        repo=repo,
        engines=engines,
        claims=claims,
        scans=ScanService(repo, settings.seed_dir, clock, classifier, settings.live_scan, nessie_client_factory),
        actions=actions,
        shares=shares,
        agent=AgentService(repo, rules, engines, claims, actions, shares, settings.seed_dir, clock),
    )
