import type { ReactNode } from "react";
import FlowFrame from "@/components/flow/FlowFrame";

// Check, Gather, Packet, Track: the survivor flow (docs/UX.md). The tab title stays "Tend".
export default function FlowLayout({ children }: { children: ReactNode }) {
  return <FlowFrame>{children}</FlowFrame>;
}
