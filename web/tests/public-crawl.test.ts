// robots.txt and sitemap.xml: what a search engine is told about the site. The sitemap lists only the
// public pages, as absolute links on the site's own address, and never the survivor flow or share links.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import robots, { dynamic as robotsDynamic } from "@/app/robots";
import sitemap, { dynamic as sitemapDynamic } from "@/app/sitemap";
import { generateStaticParams as statePageParams } from "@/app/[st]/layout";
import { generateStaticParams as lawPageParams } from "@/app/law/[st]/page";
import STATES from "@/lib/states.json";

const web = path.resolve(import.meta.dirname, "..");
const synced = STATES.map((s) => s.st).filter((st) => existsSync(path.join(web, "public/data/law", `${st}.json`)));
const urls = () => sitemap().map((e) => e.url);
// The site's own pages, listed before the programs' pages.
const SITE = ["/", "/how-it-works", "/sources", "/tour", "/compare"];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("robots.txt", () => {
  it("lets every crawler in and points to the sitemap", () => {
    expect(robots()).toEqual({
      rules: { userAgent: "*", allow: "/" },
      sitemap: "https://youreowed.tech/sitemap.xml",
    });
  });

  it("is written at build time", () => {
    expect(robotsDynamic).toBe("force-static");
  });
});

describe("sitemap.xml", () => {
  it("lists the site pages, then each program's page and law page", () => {
    expect(synced).toHaveLength(51);
    const expected = [
      ...SITE,
      ...[...synced].sort().map((st) => `/${st.toLowerCase()}`),
      ...[...synced].sort().map((st) => `/law/${st}`),
    ].map((p) => `https://youreowed.tech${p}`);
    expect(urls()).toEqual(expected);
    expect(new Set(urls()).size).toBe(expected.length);
  });

  it("uses absolute https links on the site's address, and follows NEXT_PUBLIC_SITE_URL", () => {
    expect(urls().every((u) => u.startsWith("https://youreowed.tech/"))).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://preview.example.org");
    expect(urls()[0]).toBe("https://preview.example.org/");
    expect(urls().at(-1)).toBe("https://preview.example.org/law/WY");
    expect(robots().sitemap).toBe("https://preview.example.org/sitemap.xml");
  });

  it("never lists the survivor flow, share links, or the law changes view", () => {
    const flow = readdirSync(path.join(web, "app/(flow)"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => `/${d.name}`);
    expect(flow).toEqual(expect.arrayContaining(["/check", "/gather", "/packet", "/track", "/start", "/bill"]));
    const paths = urls().map((u) => new URL(u).pathname);
    for (const p of paths) {
      expect(
        flow.some((f) => p === f || p.startsWith(`${f}/`)),
        p,
      ).toBe(false);
      expect(p.startsWith("/share"), p).toBe(false);
      expect(p, p).not.toBe("/law/changes");
    }
    expect(urls().some((u) => u.includes("?") || u.includes("#"))).toBe(false);
  });

  it("lists only pages that are built: the site pages exist and every state is a static param", () => {
    for (const p of SITE) expect(existsSync(path.join(web, "app", p, "page.tsx")), p).toBe(true);
    const statePages = new Set(statePageParams().map((p) => `/${p.st}`));
    const lawPages = new Set(lawPageParams().map((p) => `/law/${p.st}`));
    const programs = urls()
      .map((u) => new URL(u).pathname)
      .filter((p) => !SITE.includes(p));
    expect(programs).toHaveLength(2 * synced.length);
    for (const p of programs) expect(statePages.has(p) || lawPages.has(p), p).toBe(true);
  });

  it("is written at build time", () => {
    expect(sitemapDynamic).toBe("force-static");
  });
});
