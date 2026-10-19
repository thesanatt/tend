// Writes GitHub's social preview, public/press/tend-social-1280x640.png: the home page's link card
// (components/public/og/siteCard.tsx) drawn by the same next/og code, at GitHub's 1280 x 640.
// Run from web/, where the card finds its fonts:
//   npx tsx scripts/press-social.tsx
// GitHub takes it from the repo's Settings, under Social preview.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { ImageResponse } from "next/og";
import { cardFonts } from "../components/public/og/card";
import { SiteCard } from "../components/public/og/siteCard";

const SIZE = { width: 1280, height: 640 };

// tsx runs this file as CommonJS, so the work is wrapped instead of using top-level await.
void (async () => {
  const out = path.resolve(import.meta.dirname, "..", "public", "press", "tend-social-1280x640.png");
  const res = new ImageResponse(<SiteCard page="home" />, { ...SIZE, fonts: await cardFonts() });
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(out, bytes);
  console.log(`wrote ${path.relative(process.cwd(), out)}: ${SIZE.width} x ${SIZE.height}, ${bytes.length} bytes`);
})();
