// Locks the vault after a stretch with no taps or keys. Saving in the background does not count as
// activity, so an open page left alone still locks.

export const DEFAULT_IDLE_MS = 5 * 60_000;
const EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

export interface IdleWatch {
  touch(): void;
  expired(): boolean;
  stop(): void;
}

export interface IdleOptions {
  idleMs: number;
  onIdle: () => void;
  // Where activity is heard; defaults to document in a browser. null listens to nothing.
  target?: EventTarget | null;
  now?: () => number;
}

export function watchIdle({ idleMs, onIdle, target, now = Date.now }: IdleOptions): IdleWatch {
  const on: EventTarget | null =
    target === undefined ? (typeof document === "undefined" ? null : document) : target;
  let last = now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const expired = () => !stopped && idleMs > 0 && now() - last >= idleMs;
  const touch = () => {
    last = now();
  };
  const fire = () => {
    stop();
    onIdle();
  };
  // Timers sleep in background tabs, so the check also runs when the page comes back into view.
  const check = () => {
    if (stopped) return;
    if (expired()) fire();
    else arm();
  };
  function arm() {
    if (timer) clearTimeout(timer);
    timer = idleMs > 0 ? setTimeout(check, Math.max(250, idleMs - (now() - last))) : null;
  }
  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    for (const e of EVENTS) on?.removeEventListener(e, touch, true);
    on?.removeEventListener("visibilitychange", check);
  }

  for (const e of EVENTS) on?.addEventListener(e, touch, { capture: true, passive: true });
  on?.addEventListener("visibilitychange", check);
  arm();
  return { touch, expired, stop };
}
