import CheckScreen from "@/components/flow/check/CheckScreen";

export default async function CheckPage({ searchParams }: { searchParams: Promise<{ demo?: string }> }) {
  const { demo } = await searchParams;
  return <CheckScreen demo={demo === "rowan"} />;
}
