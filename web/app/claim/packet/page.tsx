import type { Metadata } from "next";
import PacketScreen from "./PacketScreen";

export const metadata: Metadata = { title: "Packet" };

export default function PacketPage() {
  return (
    <div className="page">
      <PacketScreen />
    </div>
  );
}
