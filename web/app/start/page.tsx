import type { Metadata } from "next";
import StartForm from "./StartForm";

export const metadata: Metadata = { title: "Start" };

export default async function StartPage({ searchParams }: { searchParams: Promise<{ demo?: string }> }) {
  const { demo } = await searchParams;
  return <StartForm demo={demo === "rowan"} />;
}
