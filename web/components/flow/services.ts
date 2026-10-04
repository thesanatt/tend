// Everything the flow calls outside React, behind one interface so tests can swap in mocks.
// The defaults import the real local-first modules by the paths in lib/contracts.ts.
import { ApiError, confirmPayment, dataMode, proposePayment } from "@/lib/api";
import type {
  BillReader,
  Classifier,
  PacketBuilder,
  Share,
  StatementParser,
  StatementTxn,
  Vault,
} from "@/lib/contracts";
import { evaluateClaim, type Evaluation } from "@/lib/engine";
import { billReader, classifier, releaseDeviceAi, statementParser } from "@/lib/local";
import { packetBuilder } from "@/lib/packet";
import { share } from "@/lib/share";
import type { AccountRef, ActionProposal, ActionResult, EngineInput } from "@/lib/types";
import { vault } from "@/lib/vault";
import { demoBankTxns, ROWAN_ACCOUNT } from "./samples";

// Why the vault locked. "idle" and "exit" come from the vault itself; the flow causes the others.
export type LockReason = "manual" | "idle" | "exit" | "destroyed";

// What the device's vault can say beyond the contract. Each is optional, so a plain Vault works too.
export interface VaultExtras {
  // Which ways open the saved vault, or null when nothing is saved.
  methods?(): Promise<{ passphrase: boolean; passkey: boolean } | null>;
  // Whether this device can make a passkey that also unlocks the vault (WebAuthn PRF).
  passkeyAvailable?(): Promise<boolean>;
  onLock?(listener: (reason: LockReason) => void): () => void;
}

export interface BankConnection {
  txns: StatementTxn[];
  billIds: string[];
  account: AccountRef;
}

export interface PaymentRequest {
  bill_id: string;
  amount_cents: number;
  from: AccountRef;
  payee: string;
}

export interface FlowServices {
  statementParser: StatementParser;
  classifier: Classifier;
  billReader: BillReader;
  vault: Vault & VaultExtras;
  share: Share;
  packetBuilder: PacketBuilder;
  evaluate(input: EngineInput, opts: { allowApi: boolean }): Promise<Evaluation>;
  bank(): Promise<BankConnection>;
  propose(req: PaymentRequest): Promise<ActionProposal & { demo: boolean }>;
  confirm(actionId: string, code: string): Promise<ActionResult>;
  passkeySupported(): Promise<boolean>;
  // Closes any on-device AI sessions (Quick exit). Optional: not every reader keeps one open.
  releaseDeviceAi?(): void;
}

export function accountLabel(a: AccountRef): string {
  return a.mask ? `${a.nickname} ${a.mask}` : a.nickname;
}

async function propose(req: PaymentRequest): Promise<ActionProposal & { demo: boolean }> {
  if ((await dataMode()) === "live") {
    // A plain transfer to the payee; the bill's lines were read on this device, not by the server.
    const res = await fetch("/api/actions/propose", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ from_account_id: req.from.id, payee: req.payee, amount_cents: req.amount_cents }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => null);
    // The status says what went wrong (422 whole dollars, 403 not a demo account); the screen words it.
    if (!res.ok || !body)
      throw new ApiError(typeof body?.detail === "string" ? body.detail : `${res.status}`, res.status);
    return { ...(body as ActionProposal), demo: false };
  }
  return proposePayment(
    {
      bill_id: req.bill_id,
      item_ids: [],
      amount_cents: req.amount_cents,
      from_account_id: req.from.id,
      payee: req.payee,
    },
    accountLabel(req.from),
  );
}

export const defaultServices: FlowServices = {
  statementParser,
  classifier,
  billReader,
  vault,
  share,
  packetBuilder,
  evaluate: (input, opts) => evaluateClaim(input, { allowApi: opts.allowApi }),
  // The demo bank is Rowan's fictional checking account at Capital One's Nessie mock bank. Its history
  // ships with the app, so reading it sends nothing; only a payment you confirm reaches the bank.
  async bank() {
    const { txns, billIds } = demoBankTxns();
    return { txns, billIds, account: ROWAN_ACCOUNT };
  },
  propose,
  confirm: confirmPayment,
  // The vault knows whether a passkey here can also lock it (WebAuthn PRF); WebAuthn alone is not enough.
  async passkeySupported() {
    if (typeof window === "undefined" || !("PublicKeyCredential" in window)) return false;
    return vault.passkeyAvailable().catch(() => false);
  },
  releaseDeviceAi() {
    try {
      releaseDeviceAi();
    } catch {
      // Leaving the page matters more than closing a model session.
    }
  },
};
