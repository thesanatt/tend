// The files /press offers from public/press: the fact sheet, the logos, and the screenshots. The page shows
// each file's real size and pixel size, read when the site is built. tests/press.test.tsx checks that every
// file listed here exists and that nothing in the folder is left off the page.
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
  alt: "Tend's link card: the logo, the sentence about applying for crime victim compensation without giving Tend a name, the address youreowed.tech, and a row of plant drawings from sprout to bloom.",
};

export interface Shot {
  file: string;
  device: "desktop" | "phone";
  caption: string;
  alt: string;
}

// Made by scripts/press-screenshots.py, which keeps the same names. The alt text says what each frame shows
// without quoting the state page's wording, which comes from the verified rules and can change with them.
// A frame of the fictional demo has "demo" in its name, because a downloaded file leaves its caption behind
// and the packet frame shows no Fictional tag.
export const SHOT_DIR = "screenshots";
export const SHOTS: Shot[] = [
  {
    file: "tend-home-desktop.png",
    device: "desktop",
    caption: "The home page.",
    alt: "Tend's home page in a desktop browser: the sentence about applying for crime victim compensation without giving Tend a name, the line on who built it and the prize, buttons for the 2-minute tour and How it works, and the heading Every state has money set aside to pay survivors back.",
  },
  {
    file: "tend-demo-bill-held-desktop.png",
    device: "desktop",
    caption:
      "The fictional demo bill. Tend holds the $325.00 forensic exam line and quotes the Michigan law behind it.",
    alt: "A fictional itemized bill from Riverbend General Hospital, $443.00 in three lines. The $325.00 medical forensic exam line is struck through and marked Held. Beside the bill: Don't pay this line, the quote from MCL 18.355a(2), and a button for a letter to the billing office.",
  },
  {
    file: "tend-demo-packet-desktop.png",
    device: "desktop",
    caption: "The packet for the fictional demo claim, built in the browser.",
    alt: "The Your packet screen: the amount the fictional claim can ask for, with The program decides under it, the $325.00 held bill line kept apart, and Michigan's application, filled in with safe details only.",
  },
  {
    file: "tend-mi-phone.png",
    device: "phone",
    caption: "Michigan's page: what the law says, in plain words, each line linked to its sentence.",
    alt: "Michigan's page on a phone: the heading If you're Jane Doe in Michigan, the program's name and phone number, a drawing of a flowering plant, and the first key facts.",
  },
  {
    file: "tend-share-card-phone.png",
    device: "phone",
    caption: "Michigan's share card, which anyone can post. It is made only from the verified rules.",
    alt: "The Share this page section of Michigan's page on a phone: the card's sentence, buttons to copy the link and save the card, and the card itself with its citations.",
  },
  {
    file: "tend-demo-bill-held-phone.png",
    device: "phone",
    caption: "The same fictional bill on a phone.",
    alt: "The fictional Riverbend General Hospital bill on a phone. The $325.00 medical forensic exam line is struck through and marked Held, You should not be billed for this, and the rest comes to $118.00.",
  },
];

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
