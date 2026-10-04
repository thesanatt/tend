"""Vercel's entrypoint for the API (docs/DEPLOY.md). Locally the API runs with `uvicorn tend_api.main:app`.

The tend-api Vercel project deploys from the repository root (vercel.json there), finds this file, and serves
`app` as one function. Settings come from the project's environment variables; the defaults below are only the
ones a read-only serverless bundle needs.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))  # import tend_api from this checkout, never from an installed copy

os.environ.setdefault("TEND_DEPLOYED", "1")  # no file paths in health or errors; /audit shows the chain head only
os.environ.setdefault("TEND_ENV_FILE", "")  # a deployment reads its environment, never a .env file
os.environ.setdefault("TEND_CACHE_DIR", "/tmp/tend")  # the bundle is read-only; /tmp is the only writable place
# The compiled law images the browser runs ship with this function (vercel.json includeFiles), so when the
# reference engine answers, it labels its output with the same image sha256 as the engine on the device.
_laws = HERE.parent / "web" / "public" / "engine" / "laws"
if _laws.is_dir():
    os.environ.setdefault("TEND_LAW_DIR", str(_laws))

from tend_api.main import app  # noqa: E402

__all__ = ["app"]
