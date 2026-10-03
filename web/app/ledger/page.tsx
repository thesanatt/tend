import type { Metadata } from "next";
import StepNav from "@/components/StepNav";
import Ledger from "./Ledger";

export const metadata: Metadata = { title: "Costs" };

export default function LedgerPage() {
  return (
    <div className="page">
      <StepNav />
      <Ledger />
    </div>
  );
}
