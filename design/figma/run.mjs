// Runs one generator script inside the open Figma tab through the Chrome DevTools protocol.
// Usage: node run.mjs 01_tokens.js [more.js ...]
// Each script is an expression that evaluates to a promise, e.g. (async () => { ... })().
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FILE_KEY = "kPZUqX0ptO138LzG1ah9hk";

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find((t) => t.type === "page" && t.url.includes(FILE_KEY));
if (!page) {
  console.error("Figma tab not found");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params) =>
  new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let failed = false;
const names = process.argv.slice(2);
// Helpers first, so every script finds window.__tend fresh (fonts, variables, styles, components).
if (!names.includes("00_helpers.js")) names.unshift("00_helpers.js");
for (const name of names) {
  const src = readFileSync(resolve(here, name), "utf8");
  const t0 = Date.now();
  const r = await send("Runtime.evaluate", {
    expression: src,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  const ms = Date.now() - t0;
  if (r.error || r.result?.exceptionDetails) {
    failed = true;
    const ex = r.result?.exceptionDetails;
    console.log(`${name} FAILED in ${ms}ms`);
    console.log(JSON.stringify(r.error ?? { text: ex?.text, desc: ex?.exception?.description, line: ex?.lineNumber }, null, 1));
  } else {
    console.log(`${name} ok in ${ms}ms`);
    console.log(JSON.stringify(r.result?.result?.value, null, 1));
  }
}
ws.close();
process.exit(failed ? 1 : 0);
