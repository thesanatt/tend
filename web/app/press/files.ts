// The files /press offers from public/press: the fact sheet and the logos. The page shows each file's real
// size and pixel size, read when the site is built.
// Server components, scripts, and tests only: it reads the file system.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export const PRESS_DIR = path.join(process.cwd(), "public", "press");

// Made by scripts/press-factsheet.ts from app/press/facts.ts.
export const FACT_SHEET = "tend-fact-sheet.pdf";

export interface Logo {
  name: string;
  note: string;
  svg: string;
  png: string;
  alt: string;
}

// Made by scripts/press-logos.py.
export const LOGOS: Logo[] = [
  {
    name: "Logo",
    note: "For light backgrounds.",
    svg: "tend-logo.svg",
    png: "tend-logo.png",
    alt: "The Tend logo: a green sprout with two leaves beside the word Tend in dark ink.",
  },
  {
    name: "Logo, reversed",
    note: "Paper color on Tend's green.",
    svg: "tend-logo-reversed.svg",
    png: "tend-logo-reversed.png",
    alt: "The Tend logo in reverse: the sprout and the word Tend in a light paper color on dark green.",
  },
  {
    name: "Mark",
    note: "The sprout alone, on a clear background.",
    svg: "tend-mark.svg",
    png: "tend-mark-512.png",
    alt: "The Tend mark: a green sprout with two leaves above a short ground line.",
  },
  {
    name: "Icon",
    note: "The site's icon, on a rounded paper tile.",
    svg: "tend-mark-tile.svg",
    png: "tend-mark-tile-512.png",
    alt: "The Tend icon: the green sprout on a rounded square the color of paper.",
  },
];

// The home page's link card at 1280 x 640, made by scripts/press-social.tsx.
export const LINK_CARD = {
  file: "tend-social-1280x640.png",
  alt: "Tend's link card: the logo, the sentence about claiming compensation without giving up a name, the address youreowed.tech, and a row of plant drawings from sprout to bloom.",
};

export function pressFile(name: string): string {
  return path.join(PRESS_DIR, name);
}

export function bytesOf(name: string): number {
  return statSync(pressFile(name)).size;
}

// A PNG's width and height sit in its header, at bytes 16 to 23.
export function pngSize(name: string): { width: number; height: number } {
  const head = readFileSync(pressFile(name)).subarray(0, 24);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

// Decimal units, like /data.
export function sizeText(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} bytes`;
}
