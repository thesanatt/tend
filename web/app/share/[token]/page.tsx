import type { Metadata } from "next";
import { NEUTRAL_DESCRIPTION } from "@/components/flow/meta";
import ShareScreen from "./ShareScreen";

export const metadata: Metadata = {
  title: "Shared claim",
  description: NEUTRAL_DESCRIPTION,
  robots: { index: false, follow: false },
};

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="page">
      <ShareScreen token={token} />
    </div>
  );
}
