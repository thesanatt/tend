import type { Metadata } from "next";
import OpenShare from "./OpenShare";

export const metadata: Metadata = { title: "Shared claim", robots: { index: false, follow: false } };

// The advocate's read-only view of an end-to-end encrypted share link (/share#<id>.<key>).
export default function ShareViewerPage() {
  return (
    <div className="page">
      <OpenShare />
    </div>
  );
}
