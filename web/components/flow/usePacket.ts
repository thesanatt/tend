"use client";

import { useCallback, useEffect, useState } from "react";
import type { Packet, PacketBuilder } from "@/lib/contracts";
import { useFlow } from "./FlowProvider";

// One packet per claim content and builder, built on the device by lib/packet when a screen needs it.
let built = new WeakMap<PacketBuilder, Map<string, Promise<Packet>>>();

export function clearPacketCache() {
  built = new WeakMap();
}

function cacheFor(builder: PacketBuilder): Map<string, Promise<Packet>> {
  let cache = built.get(builder);
  if (!cache) {
    cache = new Map();
    built.set(builder, cache);
  }
  return cache;
}

export function usePacket(enabled: boolean): {
  packet: Packet | null;
  status: "idle" | "building" | "ready" | "error";
  error: string | null;
  retry(): void;
} {
  const { services, input, claim, state } = useFlow();
  const output = claim.evaluation?.output ?? null;
  const ready = Boolean(input && output && output.jurisdiction === input.jurisdiction && claim.status === "ready");
  const key = ready ? JSON.stringify([input, output!.totals, output!.lines.length]) : "";
  const [result, setResult] = useState<{ key: string; packet: Packet | null; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || !key || !input || !output) return;
    let live = true;
    const cache = cacheFor(services.packetBuilder);
    let pending = cache.get(key);
    if (!pending) {
      pending = services.packetBuilder.build(state.check.st, input, output);
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
    }
    pending
      .then((packet) => live && setResult({ key, packet, error: null }))
      .catch((err: Error) => live && setResult({ key, packet: null, error: err.message }));
    return () => {
      live = false;
    };
    // key carries input and output
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, attempt, services]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  if (!enabled || !key) return { packet: null, status: "idle", error: null, retry };
  if (!result || result.key !== key) return { packet: null, status: "building", error: null, retry };
  return result.packet
    ? { packet: result.packet, status: "ready", error: null, retry }
    : { packet: null, status: "error", error: result.error, retry };
}
