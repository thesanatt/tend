import type { Metadata } from "next";
import ShareScreen from "./ShareScreen";

export const metadata: Metadata = { title: "Shared claim", robots: { index: false, follow: false } };

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="page">
      <ShareScreen token={token} />
    </div>
  );
}
