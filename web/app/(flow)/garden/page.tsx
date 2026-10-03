import { redirect } from "next/navigation";

// Older links: the survivor's garden is the Track step now.
export default function MovedPage() {
  redirect("/track");
}
