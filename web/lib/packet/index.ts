// PLACEHOLDER (survivor flow branch). The packet module owns this file; at merge its implementation
// (the state's own form filled in the browser, cited summary, letters) replaces this one entirely.
import { fetchLaw } from "../api";
import type { PacketBuilder } from "../contracts";
import { mockPacketBuilder } from "../mocks";

export const packetBuilder: PacketBuilder = mockPacketBuilder(async (st) => (await fetchLaw(st))?.law ?? null);
