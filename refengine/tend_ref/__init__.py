"""Python reference implementation of the Tend law engine (docs/SPEC.md v1.3, law IR version 2)."""

from .claim import EngineInputError, InvalidJson
from .engine import STATUSES, evaluate, evaluate_json
from .law import Law, LawError, law_from_bytes, load_law

__version__ = "1.2.0"

__all__ = ["STATUSES", "EngineInputError", "InvalidJson", "Law", "LawError", "evaluate", "evaluate_json",
           "law_from_bytes", "load_law", "__version__"]
