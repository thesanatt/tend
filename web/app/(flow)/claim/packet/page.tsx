import { redirect } from "next/navigation";

// Older links: the printable packet is the Packet step now.
export default function MovedPage() {
  redirect("/packet");
}
