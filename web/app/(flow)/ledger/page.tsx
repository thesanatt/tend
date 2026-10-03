import { redirect } from "next/navigation";

// Older links: the cost ledger is part of Gather now.
export default function MovedPage() {
  redirect("/gather");
}
