"""Keep Rowan's fictional Nessie account at the demo start during judging, with no commands.

Every 15 s it asks seed/reset_demo.py --check whether a demo payment or payout is in Nessie. When one
is, it waits 90 s (the rest of that judge's demo never reads Nessie again) and then runs the reset, so
the next judge can pay the $118.00 again. Network errors (Wi-Fi off) are skipped.

    nohup uv run --project api python scripts/auto_reset.py > /tmp/tend-auto-reset.log 2>&1 &
"""

from __future__ import annotations

import subprocess
import time
from datetime import datetime
from pathlib import Path

SEED = Path(__file__).resolve().parents[1] / "seed"
WAIT_AFTER_PAYMENT_S = 90
POLL_S = 15


def run(args: list[str]) -> int:
    try:
        return subprocess.run(["uv", "run", "python", "reset_demo.py", *args], cwd=SEED,
                              capture_output=True, timeout=120).returncode
    except subprocess.TimeoutExpired:
        return -1


def log(msg: str) -> None:
    print(f"{datetime.now():%H:%M:%S} {msg}", flush=True)


def main() -> None:
    dirty_since: float | None = None
    log("watching Rowan's demo account")
    while True:
        code = run(["--check"])
        if code == 0:
            dirty_since = None
        elif code == 1:
            if dirty_since is None:
                dirty_since = time.monotonic()
                log("a demo payment is in Nessie; resetting in 90 s")
            elif time.monotonic() - dirty_since >= WAIT_AFTER_PAYMENT_S:
                log("reset " + ("done" if run([]) == 0 else "failed, will retry"))
                dirty_since = None
        else:
            log(f"check skipped (exit {code}, probably offline)")
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
