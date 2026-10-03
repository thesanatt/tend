// The share card renders through next/og to a 1200 x 630 PNG for every jurisdiction, with alt text
// that is the card's own sentence.
import { describe, expect, it } from "vitest";
import Image, { contentType, generateImageMetadata, size } from "@/app/[st]/opengraph-image";
import { bodySize } from "@/components/public/og/card";
import STATES from "@/lib/states.json";

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("share card image", () => {
  it("declares a 1200 x 630 PNG with the share sentence as alt text", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
    const [meta] = generateImageMetadata({ params: { st: "mi" } });
    expect(meta).toMatchObject({ id: "card", contentType: "image/png" });
    expect(meta.alt).toBe(
      "If you're Jane Doe in Michigan: you can ask for up to $45,000, and a forensic exam can count instead of a police report.",
    );
    // Next calls this while listing params too, before it knows the state.
    expect(generateImageMetadata({ params: {} })[0].alt).toBe("A Tend share card");
  });

  it.each(["mi", "il", "dc", "ny"])("renders %s as a 1200 x 630 PNG", async (st) => {
    const res = await Image({ params: Promise.resolve({ st }) });
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");
    expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
    expect(bytes.length).toBeGreaterThan(20_000);
  }, 30_000);

  it("has a card for every jurisdiction", () => {
    for (const { st } of STATES) {
      expect(generateImageMetadata({ params: { st: st.toLowerCase() } })[0].alt).toMatch(/^If you're Jane Doe in /);
    }
  });

  it("steps the type size down as the sentence grows", () => {
    expect(bodySize("x".repeat(90))).toBe(60);
    expect(bodySize("x".repeat(120))).toBe(54);
    expect(bodySize("x".repeat(150))).toBe(48);
    expect(bodySize("x".repeat(200))).toBe(42);
  });
});
