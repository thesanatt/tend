import { redirect } from "next/navigation";

// Older links: bills are triaged in Gather now.
export default function MovedPage() {
  redirect("/gather/bills");
}
