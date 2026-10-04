// Tend's offline helper (registered from the survivor flow, components/flow/offline.ts).
//
// After one visit, the flow's pages, the law engine (WebAssembly), every state's compiled law image,
// verified rules, and law summary, and Michigan's form load from this cache, so Check, Gather, the
// claim, and the packet run with the network off. It caches public files only, never anyone's
// answers, and it never touches /api/*: a payment, a share, or the bank always goes to the network
// and fails plainly when there is none.
//
// Bump VERSION when this file changes, and whenever the engine (tend.wasm) or the law images change, so a
// phone never mixes an engine with images from another release (tend 1.3.0 reads only tlaw 1.3 images and
// refuses older ones). The old caches are removed when the new one takes over.
const VERSION = "tend-offline-v3";
const SHELL = ["/check", "/gather", "/gather/bills", "/packet", "/track", "/share"];
const CORE = [
  "/engine/tend.js",
  "/engine/tend.wasm",
  "/data/jurisdictions.json",
  "/forms/MI.pdf",
  "/icon.svg",
];
// How long a page or a law file may take before the saved copy is used instead.
const NETWORK_WAIT_MS = 3500;
const REFRESH_EVERY_MS = 10 * 60_000;

let lastShellRefresh = 0;

async function put(cache, url) {
  try {
    const res = await fetch(url, { cache: "no-cache", credentials: "same-origin" });
    if (res.ok && res.type === "basic") await cache.put(url, res.clone());
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

// Script, style, and font files a page names: /_next/static/... in attributes or in the inline
// payload that lists the page's client chunks.
function assetsIn(html) {
  const out = new Set();
  const re = /(?:\/_next\/static\/[A-Za-z0-9_\-./~%@]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const url = m[0].replace(/\\$/, "");
    if (/\.(js|css|woff2?|ttf|otf|png|svg|ico|json)$/.test(url)) out.add(url);
  }
  return [...out];
}

// Each step's route tree, the first thing Next asks for before moving to a step it has not seen.
// Next answers a made-up ?_rsc= with a redirect to the right one, which fetch follows.
async function cacheTree(cache, path) {
  try {
    const res = await fetch(`${path}?_rsc=tend`, {
      headers: { RSC: "1", "Next-Router-Prefetch": "1", "Next-Router-Segment-Prefetch": "/_tree" },
      credentials: "same-origin",
    });
    if (!res.ok || !(res.headers.get("content-type") || "").startsWith("text/x-component")) return;
    const copy = new Response(await res.arrayBuffer(), { status: 200, headers: res.headers });
    await cache.put(`${path}?tend-rsc=${encodeURIComponent("/_tree")}&prefetch=1`, copy);
  } catch {
    // Moving to this step offline then reloads the page instead.
  }
}

async function cacheShell(cache) {
  await Promise.all(SHELL.map((path) => cacheTree(cache, path)));
  const pages = await Promise.all(SHELL.map((path) => put(cache, path)));
  const assets = new Set();
  for (const res of pages) {
    if (!res) continue;
    try {
      for (const url of assetsIn(await res.clone().text())) assets.add(url);
    } catch {
      // A page that cannot be read still loads from the network next time.
    }
  }
  await Promise.all([...assets].map(async (url) => ((await cache.match(url)) ? null : put(cache, url))));
  lastShellRefresh = Date.now();
}

// Every state's compiled law image, verified rules, and law summary, so a state chosen offline works.
async function cacheLaw(cache) {
  let states = [];
  try {
    const res = await put(cache, "/data/jurisdictions.json");
    const list = res ? await res.clone().json() : [];
    states = (Array.isArray(list) ? list : []).map((j) => String(j.st || "").toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s));
  } catch {
    states = [];
  }
  const urls = states.flatMap((st) => [`/engine/laws/${st}.tlaw`, `/data/law/${st}.json`, `/data/ir/${st}.json`]);
  // A few at a time, so the first visit stays light on a phone.
  for (let i = 0; i < urls.length; i += 8) await Promise.all(urls.slice(i, i + 8).map((url) => put(cache, url)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      await Promise.all(CORE.map((url) => put(cache, url)));
      await cacheShell(cache);
      await cacheLaw(cache);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

// The page tells the worker which files it loaded before the worker was in charge (so those are
// saved too), and asks for the pages to be refreshed after a new release.
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "tend-files" && Array.isArray(data.urls)) {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(VERSION);
        const same = data.urls
          .map((u) => {
            try {
              return new URL(u, self.location.origin);
            } catch {
              return null;
            }
          })
          // Files only. Page data (?_rsc=) fetched without Next's headers would come back as a page.
          .filter((u) => u && u.origin === self.location.origin && /^\/(_next\/static|engine|data|forms)\//.test(u.pathname))
          .filter((u) => !u.searchParams.has("_rsc"))
          .map((u) => u.pathname + u.search);
        await Promise.all(same.map(async (url) => ((await cache.match(url)) ? null : put(cache, url))));
        if (Date.now() - lastShellRefresh > REFRESH_EVERY_MS) await cacheShell(cache);
        event.source?.postMessage({ type: "tend-ready", version: VERSION });
      })(),
    );
  }
});

function timeout(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

// The network first, so a new release shows up; the saved copy when there is no network or it is
// too slow. A response that arrives late still refreshes the copy. keys: where the copy is saved,
// best match first (the first is exact, later ones are fallbacks).
async function networkFirst(request, keys, matchOptions) {
  const cache = await caches.open(VERSION);
  const network = fetch(request)
    .then(async (res) => {
      if (res.ok && res.type === "basic") await Promise.all(keys.map((key) => cache.put(key, res.clone())));
      return res;
    })
    .catch(() => null);
  const first = await Promise.race([network, timeout(NETWORK_WAIT_MS)]);
  if (first) return first;
  for (const key of keys) {
    const saved = await cache.match(key, matchOptions);
    if (saved) return saved;
  }
  const late = await network;
  return late || Response.error();
}

// A step's data for moving between pages: Next asks for each piece (the route tree, a page) with
// headers that it also folds into ?_rsc=. The exact address is tried first; the same piece of the
// same page asked from another page has another ?_rsc=, so a second key leaves that out. Tend's
// flow pages are the same for everyone, so either copy is the right one.
function rscKeys(request, url) {
  const piece = request.headers.get("Next-Router-Segment-Prefetch") || "full";
  const prefetch = request.headers.get("Next-Router-Prefetch") ? "1" : "0";
  const loose = `${url.pathname}?tend-rsc=${encodeURIComponent(piece)}&prefetch=${prefetch}`;
  return [url.pathname + url.search, loose];
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const saved = await cache.match(request, { ignoreVary: true });
  if (saved) return saved;
  const res = await fetch(request);
  if (res.ok && res.type === "basic") await cache.put(request, res.clone());
  return res;
}

const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tend</title></head><body style="font:18px/1.6 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 16px;background:#f6f2e9;color:#1c1b18"><h1 style="font-size:1.6rem">This page is not saved on this device yet</h1><p>You are offline. The steps you already opened work without the internet. <a href="/check" style="color:#1f5136">Go to Check</a>.</p></body></html>`;

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Payments, shares, the bank, and everything else on the server always go to the network.
  if (url.pathname.startsWith("/api/") || url.pathname === "/sw.js") return;

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (request.mode === "navigate") {
    // The page is saved under its bare path ("/check" for "/check?demo=rowan"). Matching ignores
    // nothing else: the same path with ?_rsc= holds page data, not the page.
    event.respondWith(
      networkFirst(request, [url.pathname], { ignoreVary: true }).then((res) =>
        res.type === "error"
          ? new Response(OFFLINE_PAGE, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } })
          : res,
      ),
    );
    return;
  }
  if (request.headers.get("RSC") === "1" || url.searchParams.has("_rsc")) {
    event.respondWith(networkFirst(request, rscKeys(request, url), { ignoreVary: true }));
    return;
  }
  if (/^\/(engine|data|forms)\//.test(url.pathname) || url.pathname === "/icon.svg") {
    event.respondWith(networkFirst(request, [url.pathname], { ignoreSearch: true, ignoreVary: true }));
  }
});
