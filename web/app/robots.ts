import type { MetadataRoute } from "next";
import { siteUrl } from "@/components/public/site";

// Crawlers may fetch every page and are pointed to the sitemap. Share links say noindex on their own
// pages, which a crawler can only read if it may fetch them. Written once, at build time.
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: new URL("/sitemap.xml", siteUrl()).toString(),
  };
}
