import { redirect } from "next/navigation";

// Older links: the claim is the Packet step now.
export default function MovedPage() {
  redirect("/packet");
}
