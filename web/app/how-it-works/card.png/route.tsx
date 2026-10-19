import { ImageResponse } from "next/og";
import { CARD_SIZE, cardFonts } from "@/components/public/og/card";
import { SiteCard } from "@/components/public/og/siteCard";

// How it works' link preview, written as a static PNG at build time.
export const dynamic = "force-static";

export async function GET() {
  return new ImageResponse(<SiteCard page="how" />, { ...CARD_SIZE, fonts: await cardFonts() });
}
