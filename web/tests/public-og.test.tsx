// The share card renders through next/og to a 1200 x 630 PNG for every jurisdiction, and the site's own
// public pages get link cards of their own. Survivor flow and share links get no card and a neutral description.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { describe, expect, it, vi } from "vitest";
import { dynamicParams, generateStaticParams, GET } from "@/app/[st]/card.png/route";
import * as homeCard from "@/app/card.png/route";
import * as howCard from "@/app/how-it-works/card.png/route";
import { metadata as howMeta } from "@/app/how-it-works/page";
import { metadata as homeMeta } from "@/app/page";
import * as sourcesCard from "@/app/sources/card.png/route";
import { metadata as sourcesMeta } from "@/app/sources/page";
import * as tourCard from "@/app/tour/card.png/route";
import { metadata as tourMeta } from "@/app/tour/page";
import { NEUTRAL_DESCRIPTION } from "@/components/flow/meta";
import { bodySize, cardSourceLine } from "@/components/public/og/card";
import { sentenceSize, siteCardAddress, siteCardAlt } from "@/components/public/og/siteCard";

// The root layout loads its fonts through the Next.js compiler, which tests do not run.
vi.mock("next/font/google", () => {
  const font = () => ({ variable: "", className: "", style: {} });
  return { Source_Serif_4: font, Atkinson_Hyperlegible_Next: font, Atkinson_Hyperlegible_Mono: font };
});

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

  it("never calls the card's sentence a quote: it names the pinpoints or points to the page", () => {
    expect(cardSourceLine("Michigan", ["MCL 18.361(1)", "MCL 18.355a(10)"])).toBe(
      "From Michigan law: MCL 18.361(1) and MCL 18.355a(10). The program decides.",
    );
    const long = cardSourceLine("Kansas", ["K.S.A. 74-7301 through a very long pinpoint", "K.A.R. 20-2-8(a)(1)(B)"]);
    expect(long).toBe("From Kansas law, with citations on the page. The program decides.");
    expect(long).not.toMatch(/quot/i);
  });
});

const web = path.resolve(import.meta.dirname, "..");

function files(dir: string, match = /\.tsx?$/): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p, match) : match.test(name) ? [p] : [];
  });
}

// Each public page with a link card: its tab title (unchanged) and what a posted link shows.
const PAGES: {
  path: string;
  meta: Metadata;
  card: { GET: () => Promise<Response>; dynamic: string };
  image: string;
  tab?: string;
  title: string;
  description: string;
}[] = [
  {
    path: "/",
    meta: homeMeta,
    card: homeCard,
    image: "/card.png",
    title: "Tend",
    description:
      "Tend helps sexual assault survivors claim the crime victim compensation their state already owes them, without giving up their name.",
  },
  {
    path: "/how-it-works",
    meta: howMeta,
    card: howCard,
    image: "/how-it-works/card.png",
    tab: "How it works",
    title: "How Tend works",
    description: "Each state's verified law runs on your device, and every dollar points to the sentence behind it.",
  },
  {
    path: "/sources",
    meta: sourcesMeta,
    card: sourcesCard,
    image: "/sources/card.png",
    tab: "Sources",
    title: "Sources",
    description: "Where each number about the problem comes from, and how to rerun Tend's own.",
  },
  {
    path: "/tour",
    meta: tourMeta,
    card: tourCard,
    image: "/tour/card.png",
    tab: "What you just saw",
    title: "What you just saw",
    description: "A 2-minute tour of Tend with Rowan, a fictional survivor in Michigan.",
  },
];

describe("link cards for the site's own pages", () => {
  it.each(PAGES)(
    "$path has a static 1200 x 630 PNG at $image",
    async ({ card }) => {
      expect(card.dynamic).toBe("force-static");
      const res = await card.GET();
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");
      expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
      expect(bytes.length).toBeGreaterThan(20_000);
    },
    30_000,
  );

  it.each(PAGES)("$path keeps its tab title and shows its card when the link is posted", (page) => {
    expect(page.meta.title).toBe(page.tab);
    const image = {
      url: page.image,
      width: 1200,
      height: 630,
      type: "image/png",
      alt: expect.stringContaining(page.description),
    };
    const { title, description } = page;
    expect(page.meta.openGraph).toEqual({
      type: "website",
      siteName: "Tend",
      title,
      description,
      url: page.path,
      images: [image],
    });
    expect(page.meta.twitter).toEqual({ card: "summary_large_image", title, description, images: [image] });
  });

  it("describes the whole image in its alt text, address and drawing included", () => {
    expect(siteCardAlt("home")).toBe(
      "Tend helps sexual assault survivors claim the crime victim compensation their state already owes them, without giving up their name. youreowed.tech, with a row of plant drawings from sprout to bloom.",
    );
    expect(siteCardAlt("how")).toMatch(
      /^How Tend works: Each state's .* youreowed\.tech\/how-it-works, with a row of plant drawings/,
    );
    expect(siteCardAddress("tour")).toBe("youreowed.tech/tour");
  });

  it("steps the sentence down a size only past 110 characters", () => {
    expect(sentenceSize("x".repeat(110))).toBe(54);
    expect(sentenceSize("x".repeat(133))).toBe(50);
  });
});

// These import the real layouts, which load the whole survivor flow on first import.
describe("pages without a link card", { timeout: 60_000 }, () => {
  it("sets the base URL but no card in the root layout, so no page inherits one", async () => {
    const { metadata } = await import("@/app/layout");
    expect(String(metadata.metadataBase)).toBe("https://youreowed.tech/");
    expect(metadata.title).toEqual({ default: "Tend", template: "%s | Tend" });
    expect(metadata.openGraph).toBeUndefined();
    expect(metadata.twitter).toBeUndefined();
  });

  // Next applies an opengraph-image or twitter-image file to its own segment and every segment below it, so one
  // in app/ would put a card on every flow and share page. Public pages get theirs from card.png routes instead.
  it("has no file-based preview image a flow or share page could inherit", () => {
    const images = files(path.join(web, "app"), /^(opengraph|twitter)-image\./);
    expect(images.map((f) => path.relative(web, f))).toEqual([]);
  });

  it("gives the survivor flow and share links no card and a neutral description", async () => {
    expect(NEUTRAL_DESCRIPTION).not.toMatch(/crime|victim|compensation|assault|survivor|claim|law/i);
    const flow = await import("@/app/(flow)/layout");
    expect(Object.keys(flow).sort()).toEqual(["default", "metadata"]);
    expect(flow.metadata).toEqual({ description: NEUTRAL_DESCRIPTION });
    for (const page of [await import("@/app/share/page"), await import("@/app/share/[token]/page")]) {
      expect(page.metadata).toEqual({
        title: "Shared claim",
        description: NEUTRAL_DESCRIPTION,
        robots: { index: false, follow: false },
      });
    }
    const sources = [...files(path.join(web, "app", "(flow)")), ...files(path.join(web, "app", "share"))];
    expect(sources.length).toBeGreaterThan(10);
    for (const file of sources) {
      const name = path.relative(web, file);
      const text = readFileSync(file, "utf8");
      expect(text, name).not.toMatch(/openGraph|twitter|generateMetadata|card\.png/);
      // A flow page or nested layout with metadata of its own could replace the layout's description.
      if (name.includes("(flow)") && name !== path.join("app", "(flow)", "layout.tsx"))
        expect(text, name).not.toMatch(/\bmetadata\b/);
      // Share pages sit outside the flow layout, so one without this line would show the root description.
      if (name.startsWith(path.join("app", "share")) && path.basename(name) === "page.tsx")
        expect(text, name).toContain("description: NEUTRAL_DESCRIPTION");
    }
  });
});
