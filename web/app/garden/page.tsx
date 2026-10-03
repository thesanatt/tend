import type { Metadata } from "next";
import StepNav from "@/components/StepNav";
import GardenScreen from "./GardenScreen";

export const metadata: Metadata = { title: "Garden" };

export default function GardenPage() {
  return (
    <div className="page">
      <StepNav />
      <GardenScreen />
    </div>
  );
}
