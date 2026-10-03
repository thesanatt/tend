// The share card renders through next/og to a 1200 x 630 PNG for every jurisdiction.
import { describe, expect, it } from "vitest";
import { dynamicParams, generateStaticParams, GET } from "@/app/[st]/card.png/route";
import { bodySize } from "@/components/public/og/card";

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const get = (st: string) => GET(new Request(`http://localhost/${st}/card.png`), { params: Promise.resolve({ st }) });

describe("share card image", () => {
  it("is built for all 51 at build time and nothing else", () => {
    const params = generateStaticParams();
    expect(params).toHaveLength(51);
    expect(params).toContainEqual({ st: "mi" });
    expect(params.every((p) => /^[a-z]{2}$/.test(p.st))).toBe(true);
    expect(dynamicParams).toBe(false);
  });

  it.each(["mi", "il", "dc", "ny"])(
    "renders %s as a 1200 x 630 PNG",
    async (st) => {
      const res = await get(st);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");
      expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
      expect(bytes.length).toBeGreaterThan(20_000);
    },
    30_000,
  );

  it("answers 404 for anything that is not a lowercase state code", async () => {
    expect((await get("MI")).status).toBe(404);
    expect((await get("zz")).status).toBe(404);
  });

  it("steps the type size down as the sentence grows", () => {
    expect(bodySize("x".repeat(90))).toBe(60);
    expect(bodySize("x".repeat(120))).toBe(54);
    expect(bodySize("x".repeat(150))).toBe(48);
    expect(bodySize("x".repeat(200))).toBe(42);
  });
});
