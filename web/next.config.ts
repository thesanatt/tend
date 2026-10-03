import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// TEND_API_URL points at the FastAPI service (for example http://127.0.0.1:8000).
// Without it, /api/* is not proxied and the app runs on its built-in fixtures.
const api = process.env.TEND_API_URL?.replace(/\/$/, "");
// engine/ writes its Emscripten build here; checked when the server starts.
const wasm = existsSync(path.join(process.cwd(), "public", "engine", "tend.js"));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_TEND_API: api ? "1" : "0",
    NEXT_PUBLIC_TEND_WASM: wasm ? "1" : "0",
  },
  async rewrites() {
    return api ? [{ source: "/api/:path*", destination: `${api}/api/:path*` }] : [];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        source: "/engine/:file*.wasm",
        headers: [{ key: "Content-Type", value: "application/wasm" }],
      },
    ];
  },
};

export default nextConfig;
