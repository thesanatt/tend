// Every test starts in a fresh tab. jsdom keeps one sessionStorage for a whole file, and the privacy
// line remembers there what the tab sent (components/flow/keptSends.ts).
import { afterEach } from "vitest";
import { forgetKeptSends } from "@/components/flow/keptSends";

afterEach(() => forgetKeptSends());
