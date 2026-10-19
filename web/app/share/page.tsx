import type { Metadata } from "next";
import { NEUTRAL_DESCRIPTION } from "@/components/flow/meta";
import OpenShare from "./OpenShare";

export const metadata: Metadata = {
  title: "Shared claim",
  description: NEUTRAL_DESCRIPTION,
  robots: { index: false, follow: false },
};

// The advocate's read-only view of an end-to-end encrypted share link (/share#<id>.<key>).
export default function ShareViewerPage() {
  return (
    <div className="page">
      <OpenShare />
    </div>
  );
}
