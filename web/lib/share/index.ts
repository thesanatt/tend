// PLACEHOLDER (survivor flow branch). The share module owns this file; at merge its end-to-end
// encrypted implementation replaces this one entirely. This stand-in keeps sealed packets in memory.
import type { Share } from "../contracts";
import { mockShare } from "../mocks";

export const share: Share = mockShare(typeof window === "undefined" ? undefined : window.location.origin);
