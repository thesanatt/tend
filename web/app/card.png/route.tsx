import { ImageResponse } from "next/og";
import { CARD_SIZE, cardFonts } from "@/components/public/og/card";
import { SiteCard } from "@/components/public/og/siteCard";

// The home page's link preview, drawn by next/og and written as a static PNG at build time: /card.png.
export const dynamic = "force-static";

export async function GET() {
  return new ImageResponse(<SiteCard page="home" />, { ...CARD_SIZE, fonts: await cardFonts() });
}
