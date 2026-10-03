import { redirect } from "next/navigation";

// Older links: /start became Check.
export default async function StartPage({ searchParams }: { searchParams: Promise<{ demo?: string }> }) {
  const { demo } = await searchParams;
  redirect(demo === "rowan" ? "/check?demo=rowan" : "/check");
}
