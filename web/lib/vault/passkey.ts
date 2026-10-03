// Passkey unlock through the WebAuthn PRF extension: Touch ID (or the phone's lock) returns a
// secret that only this passkey and this salt produce. Nothing is sent anywhere: there is no
// server check, so the challenge is just random bytes.
import { fromB64url, randomBytes, toB64url, type Bytes } from "./bytes";

export interface PasskeyProvider {
  // Whether this browser can make a passkey that returns a PRF secret.
  available(): Promise<boolean>;
  // Makes a new passkey and returns its id with the PRF secret for this salt.
  register(salt: Bytes): Promise<{ credentialId: string; secret: Bytes }>;
  // Asks for the passkey again. Throws PasskeyError("cancelled") when the person says no.
  secret(credentialId: string, salt: Bytes): Promise<Bytes>;
}

export class PasskeyError extends Error {
  constructor(
    readonly code: "unsupported" | "cancelled",
    message: string,
  ) {
    super(message);
    this.name = "PasskeyError";
  }
}

interface PrfOutput {
  enabled?: boolean;
  results?: { first?: BufferSource };
}

const TIMEOUT_MS = 120_000;

function prfFirst(cred: PublicKeyCredential): Bytes | null {
  const ext = cred.getClientExtensionResults() as { prf?: PrfOutput };
  const first = ext.prf?.results?.first;
  if (!first) return null;
  const view = ArrayBuffer.isView(first)
    ? new Uint8Array(first.buffer, first.byteOffset, first.byteLength)
    : new Uint8Array(first);
  return new Uint8Array(view) as Bytes;
}

function prfEnabled(cred: PublicKeyCredential): boolean {
  const ext = cred.getClientExtensionResults() as { prf?: PrfOutput };
  return ext.prf?.enabled === true || !!ext.prf?.results?.first;
}

function cancelled(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === "NotAllowedError" || name === "AbortError";
}

export function webAuthnPasskeys(): PasskeyProvider {
  const api = () => {
    if (typeof window === "undefined" || !window.PublicKeyCredential || !navigator.credentials) {
      throw new PasskeyError("unsupported", "This browser cannot use a passkey here. Use a passphrase.");
    }
    return navigator.credentials;
  };

  async function secret(credentialId: string, salt: Bytes): Promise<Bytes> {
    let cred: PublicKeyCredential | null;
    try {
      cred = (await api().get({
        publicKey: {
          challenge: randomBytes(32),
          allowCredentials: [{ type: "public-key", id: fromB64url(credentialId) }],
          userVerification: "required",
          timeout: TIMEOUT_MS,
          extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
    } catch (e) {
      if (cancelled(e)) throw new PasskeyError("cancelled", "The passkey was not used.");
      throw e;
    }
    const out = cred ? prfFirst(cred) : null;
    if (!out) throw new PasskeyError("unsupported", "This passkey cannot unlock saved work here. Use the passphrase.");
    return out;
  }

  return {
    async available() {
      if (typeof window === "undefined" || !window.PublicKeyCredential) return false;
      const pkc = window.PublicKeyCredential as typeof PublicKeyCredential & {
        getClientCapabilities?: () => Promise<Record<string, boolean>>;
      };
      try {
        if (pkc.getClientCapabilities) {
          const caps = await pkc.getClientCapabilities();
          if (caps["extension:prf"] === false) return false;
          if (caps["extension:prf"] === true) return true;
        }
        return await pkc.isUserVerifyingPlatformAuthenticatorAvailable();
      } catch {
        return false;
      }
    },

    async register(salt) {
      let cred: PublicKeyCredential | null;
      try {
        cred = (await api().create({
          publicKey: {
            // No name, email, or account: the passkey is labeled only "Tend" (Stay Jane Doe).
            rp: { name: "Tend" },
            user: { id: randomBytes(16), name: "Tend", displayName: "Tend" },
            challenge: randomBytes(32),
            pubKeyCredParams: [
              { type: "public-key", alg: -7 },
              { type: "public-key", alg: -257 },
            ],
            authenticatorSelection: { userVerification: "required", residentKey: "discouraged" },
            attestation: "none",
            timeout: TIMEOUT_MS,
            extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
          },
        })) as PublicKeyCredential | null;
      } catch (e) {
        if (cancelled(e)) throw new PasskeyError("cancelled", "The passkey was not made.");
        throw e;
      }
      if (!cred || !prfEnabled(cred)) {
        throw new PasskeyError("unsupported", "This device's passkeys cannot lock saved work. Use a passphrase.");
      }
      const credentialId = toB64url(new Uint8Array(cred.rawId));
      // Some authenticators only return the secret when the passkey is used, not when it is made.
      return { credentialId, secret: prfFirst(cred) ?? (await secret(credentialId, salt)) };
    },

    secret,
  };
}
