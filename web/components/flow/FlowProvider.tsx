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
import { EngineUnavailableError, type Evaluation } from "@/lib/engine";
import type { StatementTxn } from "@/lib/contracts";
import { useI18n } from "@/lib/i18n";
import { installNetLog, onNetSend } from "@/lib/netlog";
import { stateToday } from "@/lib/stateTime";
import type { EngineInput } from "@/lib/types";
import { buildEngineInput, countingDate, knowsDate, offered } from "./claim";
import { defaultServices, type FlowServices } from "./services";
import {
  findReplaced,
  hasProgress,
  initialState,
  isFlowState,
  newCosts,
  reducer,
  type Action,
  type BillRecord,
  type FlowItem,
  type FlowState,
  type SentEvent,
  type SourceRecord,
} from "./state";

export const VAULT_KEY = "tend.flow";
// Used only with a vault that has no idle lock of its own (lib/vault locks itself after 5 minutes).
export const IDLE_LOCK_MS = 5 * 60_000;

// How a record is sorted: on-device AI is used when ready unless deviceAi is false; cloud AI only
// with cloudConsent (the survivor's yes on the consent screen).
type SortOptions = { cloudConsent?: boolean; deviceAi?: boolean };

export type ClaimStatus = "idle" | "computing" | "ready" | "error" | "needs_consent";
export interface ClaimView {
  status: ClaimStatus;
  evaluation: Evaluation | null;
  error: string | null;
}

export type VaultStatus = "checking" | "none" | "locked" | "open";

// What a record's preview shows: the file the survivor chose (or a sample), and the rows Tend read
// from it. In memory only, for this session.
export interface PreviewSource {
  file?: File;
  rows?: StatementTxn[];
}
export type VaultMethods = { passphrase: boolean; passkey: boolean };

interface VaultView {
  status: VaultStatus;
  idleLocked: boolean;
  // How the saved progress opens; null until known, or when the vault cannot say.
  methods: VaultMethods | null;
  // Whether this device can lock the vault with a passkey; null while checking.
  passkey: boolean | null;
}

interface Flow {
  state: FlowState;
  dispatch: Dispatch<Action>;
  services: FlowServices;
  today: string;
  input: EngineInput | null;
  claim: ClaimView;
  vault: VaultView;
  readStatement(file: File, sample?: boolean): Promise<SourceRecord>;
  connectBank(): Promise<SourceRecord>;
  readBill(file: File, sample?: boolean): Promise<BillRecord>;
  // Whether a record's file is still in memory, so it can be read again with cloud AI.
  canReread(id: string): boolean;
  // Records whose rows on-device AI is still sorting, after the rules' reading showed.
  refining: string[];
  // After the survivor's yes on the consent screen: sort a statement's unsorted rows with cloud AI.
  // Returns how many rows cloud AI sorted.
  cloudSort(sourceId: string): Promise<number>;
  // After the survivor's yes: read an unreliable bill again with cloud AI.
  cloudReadBill(billId: string): Promise<BillRecord | null>;
  preview(billId: string): string | null;
  // A record's file and rows for its preview, while they are still in memory.
  previewDoc(id: string): PreviewSource | null;
  // Exit this page: revoke the object URLs and drop the files and rows held in memory.
  releaseFiles(): void;
  allowServer(): void;
  logSent(event: Omit<SentEvent, "at"> & { at?: string }): void;
  save(opts: { passkey?: boolean; passphrase?: string }): Promise<void>;
  openSaved(opts: { passkey?: boolean; passphrase?: string }): Promise<boolean>;
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
  const bytes = new Uint8Array(
    typeof file.arrayBuffer === "function" ? await file.arrayBuffer() : await new Response(file).arrayBuffer(),
  );
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
  const [methods, setMethods] = useState<VaultMethods | null>(null);
  const [passkey, setPasskey] = useState<boolean | null>(null);
  const [openedAt] = useState(() => new Date());
  // Today in the chosen state's own time, the engine's as_of_date (docs/SPEC.md v1.3), so a late night
  // somewhere else never counts a deadline a day early. The device's date until a state is chosen.
  const today = useMemo(
    () => fixedToday ?? stateToday(state.check.st, openedAt),
    [fixedToday, state.check.st, openedAt],
  );
  const previews = useRef(new Map<string, string>());
  // The files read this session, in memory only, so the survivor can say yes to cloud AI for one of
  // them without choosing it again. Never stored; cleared with everything else on lock and exit.
  const files = useRef(new Map<string, File>());
  // Each record's file and rows for its preview; never stored, cleared with the files.
  const docs = useRef(new Map<string, PreviewSource>());
  // How to read a record's rows again (the parsed rows stay in memory only, like the files).
  const rereads = useRef(new Map<string, (opts: SortOptions) => Promise<FlowItem[]>>());
  const [refining, setRefining] = useState<string[]>([]);
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

  const logSent = useCallback((event: Omit<SentEvent, "at"> & { at?: string }) => {
    dispatch({ type: "sent", event: { ...event, at: event.at ?? new Date().toISOString() } });
  }, []);

  // Every request the page makes passes lib/netlog, so the privacy line hears about each send,
  // including any no screen announced. A screen's own report of the same send is merged by ref.
  useEffect(() => {
    if (typeof window === "undefined") return;
    installNetLog(window);
    return onNetSend((s) =>
      logSent({
        kind: s.kind,
        at: s.at,
        amount_cents: s.amount_cents,
        to: s.to,
        action_id: s.action_id,
        ref: s.ref,
        dry_run: s.dry_run,
        path: s.kind === "other" ? `${s.method} ${s.path}` : undefined,
      }),
    );
  }, [logSent]);

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
          logSent({ kind: "server_engine", ref: "server_engine" });
        }
      })
      .catch((err: Error) => {
        if (id !== run.current) return;
        const consent = err instanceof EngineUnavailableError && err.serverAvailable && !stateRef.current.serverConsent;
        setClaim((c) => ({
          status: consent ? "needs_consent" : "error",
          evaluation: c.evaluation,
          error: err.message,
        }));
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
    services
      .passkeySupported()
      .then((ok) => live && setPasskey(ok))
      .catch(() => live && setPasskey(false));
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
      if (typeof URL.revokeObjectURL === "function") {
        for (const url of previews.current.values()) URL.revokeObjectURL(url);
      }
      previews.current.clear();
      files.current.clear();
      docs.current.clear();
      rereads.current.clear();
      dispatch({ type: "reset", lang: stateRef.current.lang });
      setIdleLocked(idle);
      setVaultStatus("locked");
    },
    [services],
  );

  // A page brought back from the browser's back cache had its vault locked on the way out.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted && vaultStatus === "open" && !services.vault.isUnlocked()) lockNow();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [vaultStatus, services, lockNow]);

  // Which ways open the saved progress, so the resume screen offers only those.
  useEffect(() => {
    if (vaultStatus !== "locked" || !services.vault.methods) return;
    let live = true;
    services.vault
      .methods()
      .then((m) => live && setMethods(m))
      .catch(() => live && setMethods(null));
    return () => {
      live = false;
    };
  }, [vaultStatus, services]);

  // The vault locks itself after a quiet stretch. The screen follows it, so nothing readable stays up
  // on a shared device. Locks the flow asks for itself (Lock now, Exit, a new save) need nothing here.
  useEffect(() => {
    if (!services.vault.onLock) return;
    return services.vault.onLock((reason) => {
      if (reason === "idle") lockNow(true);
    });
  }, [services, lockNow]);

  // A vault without its own idle lock gets this one.
  useEffect(() => {
    if (vaultStatus !== "open" || services.vault.onLock) return;
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
  }, [vaultStatus, services, lockNow]);

  const value = useMemo<Flow>(() => {
    const ctxFor = (s: FlowState, txDates: string[]) => {
      const dates = [...txDates].sort();
      const incident = knowsDate(s, today) ? s.check.date : (dates[0] ?? countingDate(s, today));
      return { st: s.check.st, incident_date: incident };
    };

    // A statement's costs, read and sorted on this device; cloud AI only with the survivor's yes.
    const statementCosts = async (txns: StatementTxn[], sha: string, opts?: SortOptions) => {
      const ctx = ctxFor(
        stateRef.current,
        txns.map((t) => t.date),
      );
      const classified = await services.classifier.classify(txns, ctx, opts);
      const raw = rawFinder(txns);
      return classified.map((c): FlowItem => ({
        ...c,
        item_id: `stmt:${sha}:${c.item_id}`,
        origin: "statement",
        merchant: raw(c.item_id)?.merchant,
      }));
    };

    const bankCosts = async (txns: StatementTxn[], billIds: string[], opts?: SortOptions) => {
      const ctx = ctxFor(
        stateRef.current,
        txns.map((t) => t.date),
      );
      const classified = await services.classifier.classify(txns, ctx, opts);
      const find = rawFinder(txns);
      return classified.map((c): FlowItem => {
        const raw = find(c.item_id);
        // A pending bill in the bank is money owed, not money spent.
        const bankBill = Boolean(raw && billIds.includes(raw.id) && raw.amount_cents === c.amount_cents);
        return {
          ...c,
          // Bank records carry the "nessie:" prefix (docs/SPEC.md item ids), which also tells the
          // packet a bank charge apart from an itemized bill.
          item_id: c.item_id.startsWith("nessie:") ? c.item_id : `nessie:${c.item_id}`,
          origin: "bank",
          merchant: raw?.merchant,
          is_bill: c.is_bill || bankBill,
          bill_id: bankBill ? raw!.id : undefined,
        };
      });
    };

    // A second reading of a record replaces rows nothing could sort before and adds what the new
    // labels bring (a ride to newly sorted care), each still counted once. Returns how many it sorted.
    const resort = (items: FlowItem[]): number => {
      const before = new Map(stateRef.current.items.map((i) => [i.item_id, i]));
      const sorted = items.filter((i) => before.get(i.item_id)?.expense === "unknown" && i.expense !== "unknown");
      const added = newCosts(
        stateRef.current.items,
        items.filter((i) => !before.has(i.item_id)),
      ).fresh;
      if (sorted.length || added.length) dispatch({ type: "resort", items: [...sorted, ...added] });
      return sorted.length;
    };

    // With on-device AI ready, the rules answer first and the record shows at once; the model then
    // sorts what is left in the background (it can take a few seconds a batch).
    const firstPass = async (): Promise<{ fast: boolean }> => {
      const ai = await services.classifier.deviceAi().catch(() => "unavailable" as const);
      return { fast: ai === "available" };
    };
    const refine = (id: string) => {
      const again = rereads.current.get(id);
      if (!again) return;
      setRefining((r) => [...r.filter((x) => x !== id), id]);
      again({})
        .then((items) => {
          if (rereads.current.get(id) === again) resort(items);
        })
        .catch(() => {
          // The rules' reading stands; those rows wait for the survivor's answer.
        })
        .finally(() => setRefining((r) => r.filter((x) => x !== id)));
    };

    // A bill's lines, read on this device (or by cloud AI after a yes). Only a reading whose lines
    // add up becomes costs; otherwise the survivor sees the original.
    const billFrom = async (file: File, sha: string, sample: boolean, cloudConsent: boolean) => {
      const id = `bill-${sha}`;
      const reading = await services.billReader.read(file, cloudConsent ? { cloudConsent } : undefined);
      const s = stateRef.current;
      const ok = reading.status === "ok" && reading.sums_match && reading.lines.length > 0;
      // A date the Check step would not count (a typo in the future) does not date the bill either.
      const date = knowsDate(s, today) ? s.check.date : today;
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
      const bill: BillRecord = {
        id,
        label: file.name,
        reading: ok ? reading : { ...reading, status: "unreliable" },
        replaces: ok ? findReplaced(s, reading) : null,
        choice: null,
        sample,
      };
      return { bill, items };
    };

    return {
      state,
      dispatch,
      services,
      today,
      input,
      claim,
      vault: { status: vaultStatus, idleLocked, methods, passkey },

      async readStatement(file, sample = false) {
        const sha = shortHash(await fileSha(file));
        const { txns, warnings } = await services.statementParser.parse(file);
        const { fast } = await firstPass();
        const items = await statementCosts(txns, sha, fast ? { deviceAi: false } : undefined);
        const id = `stmt:${sha}`;
        rereads.current.set(id, (opts) => statementCosts(txns, sha, opts));
        docs.current.set(id, { file, rows: txns });
        const { fresh, already } = newCosts(stateRef.current.items, items);
        const source: SourceRecord = {
          id,
          kind: "statement",
          label: file.name,
          read: txns.length,
          found: fresh.filter((it) => offered(stateRef.current, it, today)).length,
          already,
          warnings,
          sample,
        };
        dispatch({ type: "addSource", source, items: fresh });
        if (fast) refine(id);
        return source;
      },

      async connectBank() {
        const { txns, billIds, account } = await services.bank();
        const { fast } = await firstPass();
        const items = await bankCosts(txns, billIds, fast ? { deviceAi: false } : undefined);
        rereads.current.set("bank", (opts) => bankCosts(txns, billIds, opts));
        docs.current.set("bank", { rows: txns });
        const { fresh, already } = newCosts(stateRef.current.items, items);
        const source: SourceRecord = {
          id: "bank",
          kind: "bank",
          label: account.nickname,
          read: txns.length,
          found: fresh.filter((it) => offered(stateRef.current, it, today)).length,
          already,
          warnings: [],
          sample: true,
        };
        dispatch({ type: "addSource", source, items: fresh, account });
        if (fast) refine("bank");
        return source;
      },

      async readBill(file, sample = false) {
        const sha = shortHash(await fileSha(file));
        const id = `bill-${sha}`;
        const existing = stateRef.current.bills.find((b) => b.id === id);
        if (existing) return existing;
        const { bill, items } = await billFrom(file, sha, sample, false);
        files.current.set(id, file);
        docs.current.set(id, { file });
        if (typeof URL.createObjectURL === "function") previews.current.set(id, URL.createObjectURL(file));
        dispatch({ type: "addBill", bill, items });
        return bill;
      },

      canReread: (id) => files.current.has(id) || rereads.current.has(id),

      refining,

      async cloudSort(sourceId) {
        const again = rereads.current.get(sourceId);
        if (!again) return 0;
        return resort(await again({ cloudConsent: true }));
      },

      async cloudReadBill(billId) {
        const file = files.current.get(billId);
        const old = stateRef.current.bills.find((b) => b.id === billId);
        if (!file || !old) return null;
        const sha = billId.replace(/^bill-/, "");
        const { bill, items } = await billFrom(file, sha, old.sample, true);
        dispatch({ type: "rereadBill", bill: { ...bill, choice: old.choice }, items });
        return bill;
      },

      preview: (billId) => previews.current.get(billId) ?? null,

      previewDoc: (id) => docs.current.get(id) ?? null,

      releaseFiles() {
        if (typeof URL.revokeObjectURL === "function") {
          for (const url of previews.current.values()) URL.revokeObjectURL(url);
        }
        previews.current.clear();
        files.current.clear();
        docs.current.clear();
        rereads.current.clear();
      },

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

      async openSaved(opts) {
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
        files.current.clear();
        docs.current.clear();
        rereads.current.clear();
        dispatch({ type: "reset", lang: stateRef.current.lang });
        setIdleLocked(false);
        setVaultStatus("none");
      },

      endSession() {
        if (services.vault.isUnlocked()) services.vault.lock();
        files.current.clear();
        docs.current.clear();
        rereads.current.clear();
        dispatch({ type: "reset", lang: stateRef.current.lang });
        setVaultStatus((v) => (v === "open" ? "locked" : v));
      },
    };
  }, [
    state,
    services,
    today,
    input,
    claim,
    vaultStatus,
    idleLocked,
    methods,
    passkey,
    logSent,
    lockNow,
    setLang,
    refining,
  ]);

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
