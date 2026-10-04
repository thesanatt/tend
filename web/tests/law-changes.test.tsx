// /law/changes: two law versions compared. Live, the API reads both versions' Neon branches; otherwise the page
// falls back to the saved comparison in app/law/changes/snapshot.json and says so.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadChanges, pickPair, type VersionRef } from "@/app/law/changes/data";
import LawChanges from "@/app/law/changes/page";
import { versionNote } from "@/app/law/changes/parts";
import SNAPSHOT from "@/app/law/changes/snapshot.json";

const versions = SNAPSHOT.versions as unknown as VersionRef[];
const names = versions.map((v) => v.name);
const [first, second, third] = names;
const newest = names[names.length - 1];

async function page(params: Record<string, string>): Promise<string> {
  return renderToStaticMarkup(await LawChanges({ searchParams: Promise.resolve(params) }));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the saved comparison", () => {
  it("names real published versions, oldest first, with one in use", () => {
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(versions.map((v) => v.seq)).toEqual(versions.map((_, i) => i + 1));
    expect(names.every((n) => /^law-\d{4}-\d{2}-\d{2}-[0-9a-f]{7}$/.test(n))).toBe(true);
    expect(names).toContain(SNAPSHOT.current);
    for (const key of Object.keys(SNAPSHOT.pairs)) {
      const [a, b] = key.split("..");
      expect(names).toContain(a);
      expect(names).toContain(b);
    }
  });

  it("picks the newest version and the one before by default, and reads forward in time", () => {
    expect(pickPair(versions).map((v) => v.name)).toEqual([names[names.length - 2], newest]);
    expect(pickPair(versions, newest, first).map((v) => v.name)).toEqual([first, newest]);
    expect(pickPair(versions, "law-2099-01-01-0000000", second).map((v) => v.name)).toEqual([first, second]);
    expect(pickPair(versions, undefined, first).map((v) => v.name)).toEqual([first, second]);
    expect(pickPair(versions, third, third).map((v) => v.name)).toEqual([second, third]);
  });

  it("says in plain words what a version added", () => {
    const pair = Object.values(SNAPSHOT.pairs).find(
      (p) => (p.summary.by_category.added as Record<string, number>).address_confidentiality,
    );
    expect(pair).toBeDefined();
    const note = versionNote(pair!.summary as never);
    expect(note).toMatch(
      /^Added \d+ rules: address confidentiality program \(\d+\), claim records kept confidential \(\d+\)\.$/,
    );
  });
});

describe("/law/changes without the live service", () => {
  it("shows a state's added rules with their quotes and source links, and says the comparison is saved", async () => {
    vi.stubEnv("TEND_API_URL", "");
    const key = Object.keys(SNAPSHOT.pairs).find((k) =>
      (SNAPSHOT.pairs as Record<string, { states: Record<string, { added: { rule_id: string }[] }> }>)[
        k
      ].states.MI?.added.some((r) => r.rule_id === "MI-ACP-1"),
    );
    expect(key).toBeDefined();
    const [from, to] = key!.split("..");
    const html = await page({ st: "mi", from, to });
    expect(html).toContain("What changed in Michigan&#x27;s rules</h1>");
    expect(html).toContain("This is the comparison saved on");
    expect(html).toContain("MI-ACP-1");
    expect(html).toContain("conceal the addresses");
    expect(html).toMatch(/Read this sentence on (www\.)?michigan\.gov/);
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("lists every program that changed, linked to its own comparison", async () => {
    vi.stubEnv("TEND_API_URL", "");
    const html = await page({ from: first, to: newest });
    expect(html).toMatch(/\d+ programs changed/);
    expect(html).toContain(`/law/changes?from=${first}&amp;to=${newest}&amp;st=MI`);
    expect(html).toContain("In use now");
  });

  it("says when a comparison needs the live service", async () => {
    vi.stubEnv("TEND_API_URL", "");
    const saved = new Set(Object.keys(SNAPSHOT.pairs));
    const missing = names
      .flatMap((a, i) => names.slice(i + 1).map((b) => [a, b]))
      .find(([a, b]) => !saved.has(`${a}..${b}`));
    if (!missing) return; // every pair is saved
    const html = await page({ from: missing[0], to: missing[1] });
    expect(html).toContain("This comparison needs the live service");
  });

  it("answers an unchanged state plainly", async () => {
    vi.stubEnv("TEND_API_URL", "");
    const view = await loadChanges({ st: "MI", from: names[names.length - 2], to: newest });
    const mi = (SNAPSHOT.pairs as Record<string, { states: Record<string, unknown> }>)[
      `${names[names.length - 2]}..${newest}`
    ]?.states.MI;
    if (mi) return; // Michigan changed in the newest version
    expect(view.state?.unchanged).toBe(true);
    const html = await page({ st: "MI", from: names[names.length - 2], to: newest });
    expect(html).toContain("No change in Michigan");
  });
});

describe("/law/changes with the live service", () => {
  it("asks the API for the two versions and shows when it compared them", async () => {
    vi.stubEnv("TEND_API_URL", "http://api.test/");
    const pair = SNAPSHOT.pairs[`${first}..${second}` as keyof typeof SNAPSHOT.pairs] as unknown as {
      states: Record<string, unknown>;
    };
    const fetchMock = vi.fn(async (url: string) => {
      const body = url.includes("/api/law/versions")
        ? { versions, current: SNAPSHOT.current }
        : { ...(pair.states.MI as object), compared_at: "2026-10-04T01:23:00Z" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const html = await page({ st: "MI", from: first, to: second });
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual([
      "http://api.test/api/law/versions",
      `http://api.test/api/law/diff?from=${first}&to=${second}&st=MI`,
    ]);
    expect(html).toContain("Compared from the two versions&#x27; database branches at Oct 3, 2026, 9:23 PM ET");
    expect(html).not.toContain("This is the comparison saved on");
  });

  it("falls back to the saved comparison when the API fails", async () => {
    vi.stubEnv("TEND_API_URL", "http://api.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 })),
    );
    const view = await loadChanges({});
    expect(view.source).toBe("saved");
    expect(view.summary).not.toBeNull();
    expect(view.liveFailed).toBe(true);
    expect(await page({})).toContain("The live service did not answer just now.");
  });

  it("does not claim the live service failed when this site has none", async () => {
    vi.stubEnv("TEND_API_URL", "");
    const html = await page({});
    expect(html).toContain("This is the comparison saved on");
    expect(html).not.toContain("did not answer");
  });

  it("sends the Vercel protection bypass header the API project needs, only when it is set", async () => {
    vi.stubEnv("TEND_API_URL", "http://api.test");
    vi.stubEnv("TEND_API_BYPASS", "bypass-secret");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("down", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await loadChanges({});
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["x-vercel-protection-bypass"]).toBe("bypass-secret");
    vi.stubEnv("TEND_API_BYPASS", "");
    fetchMock.mockClear();
    await loadChanges({});
    expect(fetchMock.mock.calls[0][1]?.headers).not.toHaveProperty("x-vercel-protection-bypass");
  });

  it("does not show raw commit messages, and says the program decides", async () => {
    vi.stubEnv("TEND_API_URL", "");
    const html = await page({});
    for (const v of versions) expect(html).not.toContain(v.subject);
    expect(html).toContain("the program decides every claim");
  });
});
