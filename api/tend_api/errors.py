from __future__ import annotations

from typing import Any


class TendError(Exception):
    """An error with an HTTP status and a message safe to show the person using Tend."""

    status_code = 400

    def __init__(self, message: str, status_code: int | None = None, detail: Any = None):
        super().__init__(message)
        if status_code is not None:
            self.status_code = status_code
        self.detail = message if detail is None else detail
