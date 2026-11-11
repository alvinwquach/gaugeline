import type { ContractEntry } from "./contract.js";
import { CONTRACT_ENTRIES } from "./contracts.generated.js";

/**
 * One contract entry per adapter, each in its own file beside its fixture (__tests__/<id>.contract.ts, named like
 * the adapter's adapters/<id>.entry.ts), collected by `pnpm gen:adapters` into contracts.generated.ts. A new
 * adapter's branch adds its file and edits nothing here. The names below are what other tests import.
 */
export { WP_ENV, WP_USER } from "./wordpress.contract.js";
export const ENTRIES: readonly ContractEntry[] = CONTRACT_ENTRIES;
