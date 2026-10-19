import type { Metadata } from "next";
import type { ReactNode } from "react";
import FlowFrame from "@/components/flow/FlowFrame";
import { NEUTRAL_DESCRIPTION } from "@/components/flow/meta";

// Check, Gather, Packet, Track: the survivor flow (docs/UX.md). The tab title stays "Tend", and a link
// pasted from here gets no card and only the neutral description.
export const metadata: Metadata = { description: NEUTRAL_DESCRIPTION };

export default function FlowLayout({ children }: { children: ReactNode }) {
  return <FlowFrame>{children}</FlowFrame>;
}
