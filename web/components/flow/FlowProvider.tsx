"use client";

// Holds the survivor flow in memory, runs every claim through the law engine on the device, and,
// once the survivor chooses Save, keeps an encrypted copy in the vault. Nothing here writes to
// storage in the clear, and nothing leaves the device unless the survivor acts.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";
import { todayIso } from "@/lib/dates";
import { EngineUnavailableError, type Evaluation } from "@/lib/engine";
import type { StatementTxn } from "@/lib/contracts";
import { useI18n } from "@/lib/i18n";
import type { EngineInput } from "@/lib/types";
import { buildEngineInput, countingDate } from "./claim";
import { defaultServices, type FlowServices } from "./services";
import {
  findReplaced,
  hasProgress,
  initialState,
  isFlowState,
  reducer,
  type Action,
  type BillRecord,
  type FlowItem,
  type FlowState,
  type SentEvent,
  type SourceRecord,
} from "./state";

export const VAULT_KEY = "tend.flow";
export const IDLE_LOCK_MS = 10 * 60_000;

export type ClaimStatus = "idle" | "computing" | "ready" | "error" | "needs_consent";
export interface ClaimView {
  status: ClaimStatus;
  evaluation: Evaluation | null;
  error: string | null;
}

export type VaultStatus = "checking" | "none" | "locked" | "open";

interface Flow {
  state: FlowState;
  dispatch: Dispatch<Action>;
  services: FlowServices;
  today: string;
  input: EngineInput | null;
  claim: ClaimView;
  vault: { status: VaultStatus; idleLocked: boolean };
  readStatement(file: File, sample?: boolean): Promise<SourceRecord>;
  connectBank(): Promise<SourceRecord>;
  readBill(file: File, sample?: boolean): Promise<BillRecord>;
  preview(billId: string): string | null;
  allowServer(): void;
  logSent(event: Omit<SentEvent, "at">): void;
  save(opts: { passkey?: boolean; passphrase?: string }): Promise<void>;
  unlock(opts: { passkey?: boolean; passphrase?: string }): Promise<boolean>;
  lockNow(idle?: boolean): void;
  forget(): Promise<void>;
  endSession(): void;
}

const Ctx = createContext<Flow | null>(null);

function shortHash(sha: string) {
  return sha.slice(0, 10);
}

// Classifiers name items after the transaction they came from ("nessie:<id>", "csv:3", or
// "<origin>:<id>:<suffix>" for something inferred from it). Find that transaction again.
export function rawFinder(txns: StatementTxn[]): (itemId: string) => StatementTxn | undefined {
  const byKey = new Map<string, StatementTxn>();
  for (const t of txns) {
    byKey.set(t.id, t);
    byKey.set(`${t.origin}:${t.id}`, t);
  }
  return (itemId) => byKey.get(itemId) ?? byKey.get(itemId.split(":").slice(0, 2).join(":"));
}

async function fileSha(file: Blob): Promise<string> {
  const bytes = new Uint8Array(typeof file.arrayBuffer === "function" ? await file.arrayBuffer() : await new Response(file).arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function FlowProvider({
  children,
  services = defaultServices,
  today: fixedToday,
  initial,
}: {
  children: ReactNode;
  services?: FlowServices;
  today?: string;
  initial?: FlowState;
}) {
  const { lang, setLang } = useI18n();
  const [state, dispatch] = useReducer(reducer, initial ?? initialState(lang));
  const [claim, setClaim] = useState<ClaimView>({ status: "idle", evaluation: null, error: null });
  const [vaultStatus, setVaultStatus] = useState<VaultStatus>("checking");
  const [idleLocked, setIdleLocked] = useState(false);
  const [today] = useState(() => fixedToday ?? todayIso());
  const previews = useRef(new Map<string, string>());
  const run = useRef(0);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  // The language travels with the saved state.
  useEffect(() => {
    if (state.lang !== lang) dispatch({ type: "lang", lang });
  }, [lang, state.lang]);

  const input = useMemo(() => buildEngineInput(state, today), [state, today]);
  const inputKey = useMemo(() => (input ? JSON.stringify(input) : ""), [input]);

  const logSent = useCallback((event: Omit<SentEvent, "at">) => {
    dispatch({ type: "sent", event: { ...event, at: new Date().toISOString() } });
  }, []);

  useEffect(() => {
    if (!input) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setClaim({ status: "idle", evaluation: null, error: null });
      return;
    }
    const id = ++run.current;
    setClaim((c) => ({ ...c, status: "computing" }));
    services
      .evaluate(input, { allowApi: state.serverConsent })
      .then((evaluation) => {
        if (id !== run.current) return;
        setClaim({ status: "ready", evaluation, error: null });
        if (evaluation.backend === "api" && !stateRef.current.sent.some((e) => e.kind === "server_engine")) {
          logSent({ kind: "server_engine" });
        }
      })
      .catch((err: Error) => {
        if (id !== run.current) return;
        const consent = err instanceof EngineUnavailableError && err.serverAvailable && !stateRef.current.serverConsent;
        setClaim((c) => ({ status: consent ? "needs_consent" : "error", evaluation: c.evaluation, error: err.message }));
      });
    // inputKey carries the content of input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey, state.serverConsent, services, logSent]);

  // Vault: find out whether there is saved progress, keep it current, and lock it when the page goes.
  useEffect(() => {
    let live = true;
    services.vault
      .exists()
      .then((exists) => live && setVaultStatus(exists ? (services.vault.isUnlocked() ? "open" : "locked") : "none"))
      .catch(() => live && setVaultStatus("none"));
    const onHide = () => services.vault.lock();
    window.addEventListener("pagehide", onHide);
    return () => {
      live = false;
      window.removeEventListener("pagehide", onHide);
    };
  }, [services]);

  useEffect(() => {
    if (vaultStatus !== "open") return;
    const t = window.setTimeout(() => {
      services.vault.set(VAULT_KEY, stateRef.current).catch(() => {
        // A failed write keeps the last good copy; the next change tries again.
      });
    }, 250);
    return () => window.clearTimeout(t);
  }, [state, vaultStatus, services]);

  const lockNow = useCallback(
    (idle = false) => {
      services.vault.lock();
      for (const url of previews.current.values()) URL.revokeObjectURL(url);
      previews.current.clear();
      dispatch({ type: "reset", lang: stateRef.current.lang });
      setIdleLocked(idle);
      setVaultStatus("locked");
    },
    [services],
  );

  // On a shared device, an open vault locks itself after a quiet stretch.
  useEffect(() => {
    if (vaultStatus !== "open") return;
    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    const events = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    const timer = window.setInterval(() => {
      if (Date.now() - last >= IDLE_LOCK_MS) lockNow(true);
    }, 15_000);
    return () => {
      for (const e of events) window.removeEventListener(e, touch);
      window.clearInterval(timer);
    };
  }, [vaultStatus, lockNow]);

  const value = useMemo<Flow>(() => {
    const ctxFor = (s: FlowState, txDates: string[]) => {
      const dates = [...txDates].sort();
      const incident = s.check.date && !s.check.dateUnsure ? s.check.date : (dates[0] ?? countingDate(s, today));
      return { st: s.check.st, incident_date: incident };
    };

    return {
      state,
      dispatch,
      services,
      today,
      input,
      claim,
      vault: { status: vaultStatus, idleLocked },

      async readStatement(file, sample = false) {
        const sha = shortHash(await fileSha(file));
        const { txns, warnings } = await services.statementParser.parse(file);
        const s = stateRef.current;
        const classified = await services.classifier.classify(txns, ctxFor(s, txns.map((t) => t.date)));
        const raw = rawFinder(txns);
        const items: FlowItem[] = classified.map((c) => ({
          ...c,
          item_id: `stmt:${sha}:${c.item_id}`,
          origin: "statement",
          merchant: raw(c.item_id)?.merchant,
        }));
        const source: SourceRecord = {
          id: `stmt:${sha}`,
          kind: "statement",
          label: file.name,
          read: txns.length,
          found: items.length,
          warnings,
          sample,
        };
        dispatch({ type: "addSource", source, items });
        return source;
      },

      async connectBank() {
        const { txns, billIds, account } = await services.bank();
        const s = stateRef.current;
        const classified = await services.classifier.classify(txns, ctxFor(s, txns.map((t) => t.date)));
        const find = rawFinder(txns);
        const items: FlowItem[] = classified.map((c) => {
          const raw = find(c.item_id);
          // A pending bill in the bank is money owed, not money spent.
          const bankBill = Boolean(raw && billIds.includes(raw.id) && raw.amount_cents === c.amount_cents);
          return {
            ...c,
            item_id: `bank:${c.item_id}`,
            origin: "bank",
            merchant: raw?.merchant,
            is_bill: c.is_bill || bankBill,
            bill_id: bankBill ? raw!.id : undefined,
          };
        });
        const source: SourceRecord = {
          id: "bank",
          kind: "bank",
          label: account.nickname,
          read: txns.length,
          found: items.length,
          warnings: [],
          sample: true,
        };
        dispatch({ type: "addSource", source, items, account });
        return source;
      },

      async readBill(file, sample = false) {
        const sha = shortHash(await fileSha(file));
        const id = `bill-${sha}`;
        const existing = stateRef.current.bills.find((b) => b.id === id);
        if (existing) return existing;
        const reading = await services.billReader.read(file);
        const s = stateRef.current;
        const ok = reading.status === "ok" && reading.sums_match && reading.lines.length > 0;
        const date = s.check.date && !s.check.dateUnsure ? s.check.date : today;
        const items: FlowItem[] = ok
          ? reading.lines.map((line, i) => ({
              item_id: `bill:${sha}:${line.line_id}`,
              date,
              amount_cents: line.amount_cents,
              expense: line.expense,
              confirmed: true,
              insurance_paid_cents: 0,
              is_bill: true,
              units: 0,
              unit: null,
              tags: [],
              description: line.description,
              source: reading.source,
              reason: "",
              confidence: 1,
              origin: "bill",
              merchant: reading.provider ?? undefined,
              bill_id: id,
              line_no: i + 1,
            }))
          : [];
        if (typeof URL.createObjectURL === "function") previews.current.set(id, URL.createObjectURL(file));
        const bill: BillRecord = {
          id,
          label: file.name,
          reading: ok ? reading : { ...reading, status: "unreliable" },
          replaces: ok ? findReplaced(s, reading) : null,
          choice: null,
          sample,
        };
        dispatch({ type: "addBill", bill, items });
        return bill;
      },

      preview: (billId) => previews.current.get(billId) ?? null,

      allowServer() {
        dispatch({ type: "serverConsent" });
      },

      logSent,

      async save(opts) {
        if (await services.vault.exists()) await services.vault.destroy();
        await services.vault.create(opts);
        await services.vault.set(VAULT_KEY, stateRef.current);
        setIdleLocked(false);
        setVaultStatus("open");
      },

      async unlock(opts) {
        const ok = await services.vault.unlock(opts);
        if (!ok) return false;
        const saved = await services.vault.get<unknown>(VAULT_KEY);
        if (isFlowState(saved)) {
          dispatch({ type: "restore", state: saved });
          setLang(saved.lang);
        }
        setIdleLocked(false);
        setVaultStatus("open");
        return true;
      },

      lockNow,

      async forget() {
        await services.vault.destroy();
        dispatch({ type: "reset", lang: stateRef.current.lang });
        setIdleLocked(false);
        setVaultStatus("none");
      },

      endSession() {
        if (services.vault.isUnlocked()) services.vault.lock();
        dispatch({ type: "reset", lang: stateRef.current.lang });
        setVaultStatus((v) => (v === "open" ? "locked" : v));
      },
    };
  }, [state, services, today, input, claim, vaultStatus, idleLocked, logSent, lockNow, setLang]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFlow(): Flow {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useFlow needs FlowProvider");
  return ctx;
}

export function useOptionalFlow(): Flow | null {
  return useContext(Ctx);
}

export { hasProgress };
