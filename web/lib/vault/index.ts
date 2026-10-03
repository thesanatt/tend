// PLACEHOLDER (survivor flow branch). The vault module owns this file; at merge its encrypted
// IndexedDB implementation replaces this one entirely. This stand-in keeps data in memory only.
import type { Vault } from "../contracts";
import { mockVault } from "../mocks";

export const vault: Vault = mockVault();
