import { NextResponse, type NextRequest } from "next/server";
import STATES from "@/lib/states.json";

// The law pages are built at /law/MI, but links also say /law/mi (docs/JUDGES.md has one). A redirect in
// next.config cannot tell the two apart (its matching ignores case, so it would loop on /law/MI), and a
// second set of static pages would collide with the first on a case-insensitive disk. So the case check
// lives here, and only for a code with a lowercase letter in it.
const CODES = new Set(STATES.map((s) => s.st));

export function proxy(request: NextRequest) {
  const code = request.nextUrl.pathname.split("/")[2] ?? "";
  const upper = code.toUpperCase();
  if (code === upper || !CODES.has(upper)) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = `/law/${upper}`;
  return NextResponse.redirect(url, 308);
}

export const config = {
  matcher: "/law/:st([a-z][a-zA-Z]|[A-Z][a-z])",
};
