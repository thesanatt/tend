"use client";

// /share#<id>.<key>: fetch the locked copy by id, open it here with the key from the fragment.
// The fragment never reaches a server, so neither does the key.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { SharedPacket } from "@/lib/contracts";
import type { TendPacketBuilder } from "@/lib/packet";
import { share as defaultClient, ShareError, type ShareErrorCode, type ShareMeta, type TendShare } from "@/lib/share";
import SharedClaim from "./SharedClaim";
import styles from "./share.module.css";

type Opened = { packet: SharedPacket; meta: ShareMeta };
type Result = { kind: "ready"; opened: Opened } | { kind: "error"; code: ShareErrorCode | "unknown"; message: string };

// One request per link. React runs effects twice in development, and a second request would use
// up a link that opens once.
const opening = new Map<string, Promise<Opened>>();

function openOnce(client: TendShare, link: string): Promise<Opened> {
  let pending = opening.get(link);
  if (!pending) {
    pending = client.openWithMeta(link);
    opening.set(link, pending);
    // A dropped connection did not use the link up, so trying again may help.
    pending.catch((e) => {
      if (e instanceof ShareError && (e.code === "network" || e.code === "server")) opening.delete(link);
    });
  }
  return pending;
}

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.state}>
      <h1>{title}</h1>
      {children}
    </div>
  );
}

export default function OpenShare({
  client = defaultClient,
  builder,
}: {
  client?: TendShare;
  builder?: TendPacketBuilder;
}) {
  // null while rendering on the server, which never sees the fragment.
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => null,
  );
  const [result, setResult] = useState<{ link: string; tries: number; value: Result } | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    if (!hash || hash.length < 2) return;
    let live = true;
    openOnce(client, hash).then(
      (opened) => live && setResult({ link: hash, tries, value: { kind: "ready", opened } }),
      (e: unknown) =>
        live &&
        setResult({
          link: hash,
          tries,
          value:
            e instanceof ShareError
              ? { kind: "error", code: e.code, message: e.message }
              : { kind: "error", code: "unknown", message: "This shared claim could not open." },
        }),
    );
    return () => {
      live = false;
    };
  }, [client, hash, tries]);

  if (hash === null || (hash.length >= 2 && (!result || result.link !== hash || result.tries !== tries))) {
    return (
      <div className={styles.state}>
        <p className="meta" role="status">
          Opening the shared claim in this browser
        </p>
      </div>
    );
  }

  if (hash.length < 2) {
    return (
      <Message title="Open a shared claim">
        <p className="lead">
          A shared link ends with a key after the # sign. Open the whole link you were sent to see the claim.
        </p>
      </Message>
    );
  }

  const value = result!.value;
  if (value.kind === "error") {
    const title =
      value.code === "gone" || value.code === "not_found"
        ? "This link does not work now"
        : value.code === "bad_link"
          ? "This link is not complete"
          : value.code === "network" || value.code === "server"
            ? "Tend could not reach its server"
            : "This link could not open the claim";
    return (
      <Message title={title}>
        <p className="lead">{value.message}</p>
        {value.code === "network" || value.code === "server" ? (
          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={() => setTries((t) => t + 1)}>
              Try again
            </button>
          </div>
        ) : (
          <p>Ask the person who shared it for a new link.</p>
        )}
      </Message>
    );
  }

  const { packet, meta } = value.opened;
  return (
    <SharedClaim
      input={packet.input}
      output={packet.output}
      createdAt={meta.created_at ?? packet.created_at}
      expiresAt={meta.expires_at}
      sealed
      once={meta.once}
      notes={packet.notes ?? null}
      builder={builder}
    />
  );
}
