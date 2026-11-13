/**
 * The part of the engine this package uses, and no more. The build points "@gaugeline/core" here
 * (tsup.config.ts), so the published bundle holds the fetcher, the Sanity reader and the address
 * guard, not the whole engine with its parsers. Tests and the type check use the real package.
 */
export { createFetcher } from "../../core/src/fetcher.js";
export type { Fetcher, FetcherOptions } from "../../core/src/fetcher.js";
export { createSanityRead } from "../../core/src/connectors/sanity.js";
export { isBlockedAddress } from "../../core/src/addresses.js";
