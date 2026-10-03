import type { Metadata } from "next";
import StepNav from "@/components/StepNav";
import ClaimScreen from "./ClaimScreen";

export const metadata: Metadata = { title: "Claim" };

export default function ClaimPage() {
  return (
    <div className="page">
      <StepNav />
      <ClaimScreen />
    </div>
  );
}
