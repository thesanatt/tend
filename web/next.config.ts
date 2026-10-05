import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// TEND_API_URL points at the FastAPI service (for example http://127.0.0.1:8000).
// Without it, /api/* is not proxied and the app runs on its built-in fixtures.
const api = process.env.TEND_API_URL?.replace(/\/$/, "");
// On Vercel, web/vercel.json proxies /api/* to the API project at request time (with its protection bypass
// for previews), so the Next.js rewrite is only for local runs. docs/DEPLOY.md has the whole picture.
const onVercel = Boolean(process.env.VERCEL);
// engine/ writes its Emscripten build here; checked when the server starts.
const wasm = existsSync(path.join(process.cwd(), "public", "engine", "tend.js"));
const dev = process.env.NODE_ENV === "development";

// Everything the survivor flow needs comes from this origin. Scripts: Next.js puts its page data in inline
// scripts on prerendered pages, which a nonce would force to render per request (and break the offline
// path), so inline scripts are allowed and every script file, connection, frame, and font stays on this
// origin. 'wasm-unsafe-eval' lets the law engine compile; React's development build needs 'unsafe-eval'.
// blob: images are the survivor's own bill photos, shown back to them before anything is read.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// The engine, law images, corpus data, and forms have fixed names, so they are revalidated rather than kept
// forever: fresh for an hour, then served stale while the browser checks, which also covers a dropped
// connection mid-session.
const revalidate = "public, max-age=3600, stale-while-revalidate=86400";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_TEND_API: api ? "1" : "0",
    NEXT_PUBLIC_TEND_WASM: wasm ? "1" : "0",
  },
  async rewrites() {
    return api && !onVercel ? [{ source: "/api/:path*", destination: `${api}/api/:path*` }] : [];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
          },
        ],
      },
      { source: "/engine/:path*", headers: [{ key: "Cache-Control", value: revalidate }] },
      { source: "/data/:path*", headers: [{ key: "Cache-Control", value: revalidate }] },
      { source: "/forms/:path*", headers: [{ key: "Cache-Control", value: revalidate }] },
      {
        source: "/engine/:file*.wasm",
        headers: [{ key: "Content-Type", value: "application/wasm" }],
      },
      {
        source: "/engine/:file*.mjs",
        headers: [{ key: "Content-Type", value: "text/javascript; charset=utf-8" }],
      },
      {
        source: "/engine/laws/:file*.tlaw",
        headers: [{ key: "Content-Type", value: "application/octet-stream" }],
      },
      // A service worker must update as soon as a new one ships.
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
      {
        // Fictional sample documents opened in the browser's own PDF viewer, which needs to embed the file.
        source: "/samples/:file*",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'self'; object-src 'self'; script-src 'none'; frame-ancestors 'none'" },
          { key: "Cache-Control", value: revalidate },
        ],
      },
    ];
  },
};

export default nextConfig;
