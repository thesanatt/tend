import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Atkinson_Hyperlegible_Mono, Atkinson_Hyperlegible_Next, Source_Serif_4 } from "next/font/google";
import AppShell from "@/components/flow/AppShell";
import { siteUrl } from "@/components/public/site";
import "./globals.css";

// next/font downloads these at build time and serves them from this site; browsers never call Google.
const serif = Source_Serif_4({ subsets: ["latin"], axes: ["opsz"], variable: "--ff-serif", display: "swap" });
// Next has no fallback metrics for the Atkinson families, so they fall back to the system stack.
const sans = Atkinson_Hyperlegible_Next({
  subsets: ["latin"],
  variable: "--ff-sans",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["system-ui", "sans-serif"],
});
const mono = Atkinson_Hyperlegible_Mono({
  subsets: ["latin"],
  variable: "--ff-mono",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["ui-monospace", "monospace"],
});

// The tab says only "Tend" on survivor pages (docs/UX.md, Always on). Open Graph and Twitter cards are set
// page by page on public pages, never here, so flow and share links get no card. Some apps unfurl a link from
// its title and description alone, so those pages also swap this description for a neutral one
// (components/flow/meta.ts).
export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: { default: "Tend", template: "%s | Tend" },
  description:
    "Tend checks costs against your state's crime victim compensation law and shows the exact sentence behind every dollar.",
  referrer: "no-referrer",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f2e9" },
    { media: "(prefers-color-scheme: dark)", color: "#141412" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
