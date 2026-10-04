// Exports Figma nodes to PNG files for visual checks.
// Usage: node shot.mjs "<page name>" "<node name>" out.png [scale] [maxSide]
// The node is found by exact name on that page (first match, top-level preferred).
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [pageName, nodeName, out, scaleArg, maxArg] = process.argv.slice(2);
const scale = Number(scaleArg || 1);
const maxSide = Number(maxArg || 4000);
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("kPZUqX0ptO138LzG1ah9hk"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
const expr = `(async () => {
  const p = figma.root.children.find((x) => x.name === ${JSON.stringify(pageName)});
  if (!p) return { err: "no page" };
  await p.loadAsync?.();
  let n = p.children.find((x) => x.name === ${JSON.stringify(nodeName)}) || p.findOne((x) => x.name === ${JSON.stringify(nodeName)});
  if (!n) return { err: "no node" };
  let s = ${scale};
  const big = Math.max(n.width, n.height) * s;
  if (big > ${maxSide}) s = ${maxSide} / Math.max(n.width, n.height);
  const bytes = await n.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: s } });
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { b64: btoa(bin), w: n.width, h: n.height, scale: s, type: n.type };
})()`;
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
const msg = await new Promise((r) => (ws.onmessage = (e) => r(JSON.parse(e.data))));
ws.close();
const v = msg.result?.result?.value;
if (!v || v.err) {
  console.log("FAILED", JSON.stringify(v ?? msg.result?.exceptionDetails ?? msg).slice(0, 500));
  process.exit(1);
}
const file = resolve(here, "shots", out);
writeFileSync(file, Buffer.from(v.b64, "base64"));
console.log(`${file} ${v.type} ${Math.round(v.w)}x${Math.round(v.h)} @${v.scale.toFixed(2)}`);
