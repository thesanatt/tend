// The deployed site's headers and its /api proxy (docs/DEPLOY.md). These are what keep the survivor flow on
// one origin with no third-party scripts, so a change here should be a deliberate one.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextConfig } from "next";

type Header = { key: string; value: string };
type Rule = { source: string; headers: Header[] };

async function loadConfig(env: Record<string, string | undefined>): Promise<NextConfig> {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value as string);
  return (await import("../next.config")).default;
}

async function rules(config: NextConfig): Promise<Rule[]> {
  return (await config.headers!()) as Rule[];
}

function header(all: Rule[], source: string, key: string): string | undefined {
  return all.find((r) => r.source === source)?.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("security headers", () => {
  it("allow the WebAssembly engine and nothing from another origin", async () => {
    const all = await rules(await loadConfig({ NODE_ENV: "production" }));
    const csp = header(all, "/:path*", "Content-Security-Policy")!;
    const directives = Object.fromEntries(
      csp.split(";").map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name, values];
      }),
    );
    expect(directives["script-src"]).toEqual(["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"]);
    expect(directives["connect-src"]).toEqual(["'self'"]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
    expect(directives["base-uri"]).toEqual(["'none'"]);
    // No host anywhere in the policy: every script, connection, font, and frame stays on this origin.
    expect(csp).not.toMatch(/https?:|\*\./);
    expect(header(all, "/:path*", "Referrer-Policy")).toBe("no-referrer");
    expect(header(all, "/:path*", "X-Content-Type-Options")).toBe("nosniff");
    expect(header(all, "/:path*", "X-Frame-Options")).toBe("DENY");
  });

  it("add 'unsafe-eval' only for the development server", async () => {
    const all = await rules(await loadConfig({ NODE_ENV: "development" }));
    expect(header(all, "/:path*", "Content-Security-Policy")).toContain("'unsafe-eval'");
  });

  it("serve the engine and law images with the right types and revalidating caches", async () => {
    const all = await rules(await loadConfig({ NODE_ENV: "production" }));
    expect(header(all, "/engine/:file*.wasm", "Content-Type")).toBe("application/wasm");
    expect(header(all, "/engine/:file*.mjs", "Content-Type")).toMatch(/^text\/javascript/);
    expect(header(all, "/engine/laws/:file*.tlaw", "Content-Type")).toBe("application/octet-stream");
    for (const source of ["/engine/:path*", "/data/:path*", "/forms/:path*"]) {
      expect(header(all, source, "Cache-Control")).toMatch(/max-age=\d+, stale-while-revalidate=\d+/);
      expect(header(all, source, "Cache-Control")).not.toContain("immutable");
    }
  });
});

describe("the /api proxy", () => {
  it("is a Next.js rewrite locally and left to web/vercel.json on Vercel", async () => {
    const local = await loadConfig({ TEND_API_URL: "http://127.0.0.1:8000/", VERCEL: undefined });
    expect(await local.rewrites!()).toEqual([
      { source: "/api/:path*", destination: "http://127.0.0.1:8000/api/:path*" },
    ]);
    expect(local.env?.NEXT_PUBLIC_TEND_API).toBe("1");
    const vercel = await loadConfig({ TEND_API_URL: "https://tend-api.example", VERCEL: "1" });
    expect(await vercel.rewrites!()).toEqual([]);
    expect(vercel.env?.NEXT_PUBLIC_TEND_API).toBe("1");
    const none = await loadConfig({ TEND_API_URL: undefined, VERCEL: undefined });
    expect(none.env?.NEXT_PUBLIC_TEND_API).toBe("0");
  });

  it("on Vercel reads the API address and its bypass secret from the environment, never from the file", () => {
    const config = JSON.parse(readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"));
    const route = config.routes.find((r: { src: string }) => r.src === "/api/(.*)");
    expect(route.dest).toBe("${TEND_API_URL}/api/$1");
    expect(route.env).toEqual(["TEND_API_URL"]);
    const bypass = route.transforms.find(
      (t: { target: { key: string } }) => t.target.key === "x-vercel-protection-bypass",
    );
    expect(bypass.args).toBe("${TEND_API_BYPASS}");
    expect(bypass.env).toEqual(["TEND_API_BYPASS"]);
  });

  it("never uploads local env files, keys, or test output from web/", () => {
    const lines = readFileSync(path.join(__dirname, "..", ".vercelignore"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    for (const rule of [".env*", "*.pem", "node_modules", ".next", "test-results", "playwright-report"]) {
      expect(lines).toContain(rule);
    }
    expect(lines.some((l) => l.startsWith("!"))).toBe(false);
  });
});
