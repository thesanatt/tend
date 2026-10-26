import type { MetadataRoute } from "next";
import { hasLaw } from "@/components/public/data";
import { siteUrl } from "@/components/public/site";
import STATES from "@/lib/states.json";

// The public pages: home, How it works, Sources, the tour's recap, the state comparison, and each program's
// two pages (/mi and /law/MI) once its verified rules are synced. Before that /mi is a 404 and /law/MI only
// says the rules are not verified yet. The survivor flow (/check, /gather, /packet, /track and the rest) and
// share links stay out. Written once, at build time.
export const dynamic = "force-static";

const PAGES = ["/", "/how-it-works", "/sources", "/tour", "/compare"];

export default function sitemap(): MetadataRoute.Sitemap {
  const states = STATES.map((s) => s.st)
    .filter(hasLaw)
    .sort();
  const paths = [...PAGES, ...states.map((st) => `/${st.toLowerCase()}`), ...states.map((st) => `/law/${st}`)];
  return paths.map((p) => ({ url: new URL(p, siteUrl()).toString() }));
}
