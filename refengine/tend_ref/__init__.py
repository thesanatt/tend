"""Python reference implementation of the Tend law engine (docs/SPEC.md)."""

from .engine import (
    STATUSES,
    EngineInputError,
    Law,
    evaluate,
    load_rules,
)

__version__ = "0.1.0"

__all__ = ["STATUSES", "EngineInputError", "Law", "evaluate", "load_rules", "__version__"]
