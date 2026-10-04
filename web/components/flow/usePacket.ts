"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Packet, PacketBuilder, PacketLineInfo } from "@/lib/contracts";
import { paidLines } from "./claim";
import { useFlow } from "./FlowProvider";
import type { FlowState } from "./state";

// What the packet should say about lines beyond the engine input: who sent each bill line (the
// provider the survivor's own bill names, for the billing letter's To line) and which lines were
// paid through Tend, when, from where, and to whom.
export function packetLineInfo(state: Pick<FlowState, "items" | "bills" | "payments">): Record<string, PacketLineInfo> {
  const out: Record<string, PacketLineInfo> = {};
  const providers = new Map(state.bills.map((b) => [b.id, b.reading.provider]));
  for (const it of state.items) {
    if (it.origin !== "bill") continue;
    const provider = (it.bill_id ? providers.get(it.bill_id) : null) ?? it.merchant;
    if (provider) out[it.item_id] = { provider };
  }
  for (const [id, paid] of paidLines(state)) out[id] = { ...out[id], paid };
  return out;
}

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
  const lines = useMemo(
    () => packetLineInfo(state),
    // Only bills, their lines, and payments change what the packet says about lines.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.items, state.bills, state.payments],
  );
  const key = ready ? JSON.stringify([input, output!.totals, output!.lines.length, lines]) : "";
  const [result, setResult] = useState<{ key: string; packet: Packet | null; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || !key || !input || !output) return;
    let live = true;
    const cache = cacheFor(services.packetBuilder);
    let pending = cache.get(key);
    if (!pending) {
      pending = services.packetBuilder.build(state.check.st, input, output, { lines });
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
