import type { ReactNode } from "react";
import STATES from "@/lib/states.json";

// The params live on the layout so the page and its share card image are both built for every
// jurisdiction at build time, and nothing else matches /[st].
export const dynamicParams = false;

export function generateStaticParams() {
  return STATES.map((s) => ({ st: s.st.toLowerCase() }));
}

export default function StateLayout({ children }: { children: ReactNode }) {
  return children;
}
