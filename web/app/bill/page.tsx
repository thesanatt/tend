import type { Metadata } from "next";
import StepNav from "@/components/StepNav";
import BillScreen from "./BillScreen";

export const metadata: Metadata = { title: "Bill" };

export default function BillPage() {
  return (
    <div className="page">
      <StepNav />
      <div style={{ paddingTop: "var(--space-6)" }}>
        <BillScreen />
      </div>
    </div>
  );
}
