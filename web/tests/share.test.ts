// lib/share: the packet is encrypted in the browser; the server sees only ciphertext, an IV, an
// expiry, and the open-once flag. The key rides in the link's fragment and never in a request.
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SharedPacket } from "@/lib/contracts";
import { evaluatePreview } from "@/lib/engine/preview";
import { createShare, parseShareLink, ShareError } from "@/lib/share";
import { fromB64url } from "@/lib/vault/bytes";
import { fakeShareServer, rowanInput, rowanOutput, webDir, webLaw, type Captured } from "./trust-helpers";

const packet = (): SharedPacket => ({
  st: "MI",
  created_at: "2026-10-03T16:20:00Z",
  input: rowanInput(),
  output: rowanOutput(),
  notes: "Fictional demo claim",
});

// Every way the key could leak into a request: as written, as standard base64, as hex.
function keyForms(link: string): string[] {
  const { key } = parseShareLink(link);
  const raw = fromB64url(key);
  const b64 = Buffer.from(raw).toString("base64");
  return [key, b64, b64.replace(/=+$/, ""), Buffer.from(raw).toString("hex"), encodeURIComponent(key)];
}

function everything(calls: Captured[]): string {
  return calls.map((c) => [c.url, c.method, JSON.stringify(c.headers), c.body ?? ""].join("\n")).join("\n---\n");
}

describe("sealed share links", () => {
  it("seals, opens to the same packet, and never sends the key", async () => {
    const server = fakeShareServer();
    const share = createShare({ fetch: server.fetch, origin: "https://youreowed.tech" });
    const sealed = await share.seal(packet(), { expires_hours: 72, once: false });

    expect(sealed.url).toMatch(/^https:\/\/youreowed\.tech\/share#tok_[0-9]+\.[A-Za-z0-9_-]{43}$/);
    expect(sealed.id).toBe(parseShareLink(sealed.url).id);
    expect(fromB64url(parseShareLink(sealed.url).key)).toHaveLength(32);

    const opened = await share.openWithMeta(sealed.url);
    expect(opened.packet).toEqual(packet());
    expect(opened.meta).toMatchObject({ id: sealed.id, once: false, expires_at: "2026-10-10T16:20:00Z" });
    await share.revoke(sealed.id);

    expect(server.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/shares",
      `GET /api/shares/${sealed.id}`,
      `DELETE /api/shares/${sealed.id}`,
    ]);
    const sent = everything(server.calls);
    for (const form of keyForms(sealed.url)) expect(sent).not.toContain(form);
    // The request carries only these fields, and no readable part of the packet.
    const body = JSON.parse(server.calls[0].body!);
    expect(Object.keys(body).sort()).toEqual(["alg", "ciphertext", "expires_hours", "iv", "once"]);
    expect(body).toMatchObject({ alg: "AES-256-GCM", expires_hours: 72, once: false });
    for (const plain of ["Riverbend", "forensic", "MetroRide", "Fictional demo", "rcpt:9c41e2a7", "MI-EXAM-1"]) {
      expect(sent).not.toContain(plain);
    }
  });

  it("uses a fresh key and IV for every share", async () => {
    const server = fakeShareServer();
    const share = createShare({ fetch: server.fetch, origin: null });
    const a = await share.seal(packet(), { expires_hours: 1, once: false });
    const b = await share.seal(packet(), { expires_hours: 1, once: false });
    expect(a.url).toMatch(/^\/share#/);
    expect(parseShareLink(a.url).key).not.toBe(parseShareLink(b.url).key);
    const [ba, bb] = server.calls.map((c) => JSON.parse(c.body!));
    expect(ba.iv).not.toBe(bb.iv);
    expect(ba.ciphertext).not.toBe(bb.ciphertext);
  });

  it("detects a changed ciphertext and a wrong or cut-off key", async () => {
    const server = fakeShareServer();
    const share = createShare({ fetch: server.fetch, origin: null });
    const sealed = await share.seal(packet(), { expires_hours: 24, once: false });
    const { id, key } = parseShareLink(sealed.url);

    const other = await share.seal(packet(), { expires_hours: 24, once: false });
    await expect(share.open(`#${id}.${parseShareLink(other.url).key}`)).rejects.toMatchObject({ code: "bad_key" });
    await expect(share.open(`#${id}.${key.slice(0, 40)}`)).rejects.toMatchObject({ code: "bad_link" });
    await expect(share.open(`/share#${id}`)).rejects.toMatchObject({ code: "bad_link" });

    const stored = server.shares.get(id)!;
    const ct = stored.ciphertext;
    stored.ciphertext = `${ct.slice(0, 20)}${ct[20] === "A" ? "B" : "A"}${ct.slice(21)}`;
    await expect(share.open(sealed.url)).rejects.toMatchObject({ code: "bad_key" });
    stored.ciphertext = ct;
    stored.iv = `${stored.iv.slice(0, -1)}${stored.iv.endsWith("A") ? "B" : "A"}`;
    await expect(share.open(sealed.url)).rejects.toMatchObject({ code: "bad_key" });
  });

  it("an open-once link opens once; expired and turned-off links say so", async () => {
    const server = fakeShareServer();
    const share = createShare({ fetch: server.fetch, origin: null });
    const once = await share.seal(packet(), { expires_hours: 24, once: true });
    expect(once.once).toBe(true);
    expect(JSON.parse(server.calls[0].body!).once).toBe(true);
    expect((await share.openWithMeta(once.url)).meta.once).toBe(true);
    await expect(share.open(once.url)).rejects.toMatchObject({ code: "gone" });

    const later = await share.seal(packet(), { expires_hours: 24, once: false });
    server.shares.get(later.id)!.expired = true;
    await expect(share.open(later.url)).rejects.toMatchObject({ code: "gone" });

    const revoked = await share.seal(packet(), { expires_hours: 24, once: false });
    await share.revoke(revoked.url); // a full link works too
    await expect(share.open(revoked.url)).rejects.toMatchObject({ code: "gone" });
    await share.revoke(revoked.id); // already off counts as off

    await expect(
      share.open("/share#tok_doesnotexist000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("falls back to the API's /api/share route and still never sends the key", async () => {
    const server = fakeShareServer("legacy");
    const share = createShare({ fetch: server.fetch, origin: null });
    const sealed = await share.seal(packet(), { expires_hours: 168, once: true });
    const post = server.calls.find((c) => c.method === "POST" && c.url === "/api/share")!;
    const body = JSON.parse(post.body!);
    expect(Object.keys(body).sort()).toEqual(["alg", "ciphertext", "nonce", "open_once", "ttl_hours"]);
    expect(body).toMatchObject({ ttl_hours: 168, open_once: true });

    // A different client (the advocate's browser) finds it the same way.
    const advocate = createShare({ fetch: server.fetch, origin: null });
    expect(await advocate.open(sealed.url)).toEqual(packet());
    await advocate.revoke(sealed.id);
    expect(server.shares.get(sealed.id)!.revoked).toBe(true);
    for (const form of keyForms(sealed.url)) expect(everything(server.calls)).not.toContain(form);
  });

  it("says plainly when no share route exists, and checks its options", async () => {
    const share = createShare({ fetch: fakeShareServer("none").fetch, origin: null });
    await expect(share.seal(packet(), { expires_hours: 24, once: false })).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(share.seal(packet(), { expires_hours: 0, once: false })).rejects.toMatchObject({
      code: "bad_options",
    });
    await expect(share.seal(packet(), { expires_hours: 169, once: false })).rejects.toMatchObject({
      code: "bad_options",
    });
    await expect(share.seal(packet(), { expires_hours: 1.5, once: false })).rejects.toMatchObject({
      code: "bad_options",
    });
    await expect(share.seal({ ...packet(), st: "Michigan" }, { expires_hours: 1, once: false })).rejects.toMatchObject({
      code: "bad_packet",
    });
    const offline = createShare({
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
    });
    await expect(offline.seal(packet(), { expires_hours: 1, once: false })).rejects.toMatchObject({ code: "network" });
  });

  it("reads links pasted with punctuation after them", () => {
    const key = "A".repeat(43);
    expect(parseShareLink(`https://x.tech/share#tok_abcdefgh.${key}).`)).toEqual({ id: "tok_abcdefgh", key });
    expect(parseShareLink(`tok_abcdefgh.${key}`)).toEqual({ id: "tok_abcdefgh", key });
    expect(() => parseShareLink("https://x.tech/share")).toThrow(ShareError);
    expect(() => parseShareLink(`#bad id.${key}`)).toThrow(ShareError);
  });

  it("refuses a packet with broken money or parts, whether sealing or opening one someone else made", async () => {
    const bad: [string, (p: SharedPacket) => void][] = [
      ["fractional cents", (p) => (p.output.lines[1].allowed_cents = 118000.5)],
      ["a string total", (p) => ((p.output.totals as unknown as Record<string, unknown>).allowed_cents = "139400")],
      ["negative amount", (p) => (p.input.items[0].amount_cents = -1)],
      ["lines that are not objects", (p) => ((p.output as unknown as Record<string, unknown>).lines = ["x"])],
      ["a line with no matching cost", (p) => (p.output.lines[0].item_id = "nowhere")],
      ["an unknown status", (p) => ((p.output.lines[0] as unknown as Record<string, unknown>).status = "paid")],
      ["checked under another state", (p) => (p.output.jurisdiction = "NY")],
      ["no checks", (p) => ((p.output as unknown as Record<string, unknown>).checks = {})],
    ];
    for (const [what, breakIt] of bad) {
      const p = packet();
      breakIt(p);
      const server = fakeShareServer();
      const share = createShare({ fetch: server.fetch, origin: null });
      await expect(share.seal(p, { expires_hours: 1, once: false }), what).rejects.toMatchObject({
        code: "bad_packet",
      });
      expect(server.calls, what).toHaveLength(0);

      // The same packet sealed by hand, the way anyone could, still does not open.
      const key = crypto.getRandomValues(new Uint8Array(32));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aes = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
      const plain = new TextEncoder().encode(JSON.stringify({ format: "tend.share/1", packet: p }));
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("tend.share.v1") },
        aes,
        plain,
      );
      const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
      const res = await server.fetch("/api/shares", {
        method: "POST",
        body: JSON.stringify({ ciphertext: b64(new Uint8Array(ct)), iv: b64(iv), once: false }),
      });
      const { id } = (await res.json()) as { id: string };
      await expect(share.open(`/share#${id}.${b64(key)}`), what).rejects.toMatchObject({ code: "bad_packet" });
    }
  });

  it("seals and opens a real claim for each of the 51 jurisdictions", async () => {
    const dir = path.join(webDir, "public", "data", "law");
    const states = readdirSync(dir)
      .filter((f) => /^[A-Z]{2}\.json$/.test(f))
      .map((f) => f.slice(0, 2));
    expect(states).toHaveLength(51);
    const share = createShare({ fetch: fakeShareServer().fetch, origin: null });
    for (const st of states) {
      const law = webLaw(st);
      const input = { ...rowanInput(), jurisdiction: st };
      const p: SharedPacket = { ...packet(), st, input, output: evaluatePreview(input, law, "0".repeat(64)) };
      const { url } = await share.seal(p, { expires_hours: 1, once: false });
      expect(await share.open(url), st).toEqual(p);
    }
  });
});
