// Where the share cards point, and every page's metadataBase. Set NEXT_PUBLIC_SITE_URL when deploying;
// docs/UX.md names youreowed.tech. Kept out of data.ts: the root layout imports this, and importing
// data.ts there would trace all of public/data into every route.
export function siteUrl(): URL {
  const raw = process.env.NEXT_PUBLIC_SITE_URL || "https://youreowed.tech";
  try {
    return new URL(raw);
  } catch {
    return new URL("https://youreowed.tech");
  }
}
