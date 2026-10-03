import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Atkinson_Hyperlegible_Mono, Atkinson_Hyperlegible_Next, Source_Serif_4 } from "next/font/google";
import QuickExit from "@/components/QuickExit";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { SessionProvider } from "@/lib/session";
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

export const metadata: Metadata = {
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
        <a className="skip" href="#main">
          Skip to content
        </a>
        <SessionProvider>
          <QuickExit />
          <SiteHeader />
          <main id="main">{children}</main>
          <SiteFooter />
        </SessionProvider>
      </body>
    </html>
  );
}
