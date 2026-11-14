import { createFetcher, type Fetcher, type Transport } from "../../fetcher.js";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import { staticSite, useCassette } from "../../../../testkit/src/index.js";
import type { ListingsConfig } from "../config.js";
import { LISTING_ENV_VARS, type ListingsSettings } from "../read.js";
import { freezeEnv } from "../../connectors/env.js";
import { readFileSync } from "node:fs";

/** The invented bar's folder: its site, its Apple export and the config that names the listings. */
export const BAR_DIR = `${SITES_DIR}listings-bar`;
export const BAR_HOST = "bucktavern.example";
export const BAR_ADDRESS = `https://${BAR_HOST}/`;

/** Keys built at run time so no secret scanner sees a literal. */
export const KEYS = {
  GOOGLE_BUSINESS_PROFILE_TOKEN: ["ya29", "invented", "bar", "token", "0123456789abcdef"].join("."),
  GOOGLE_PLACES_API_KEY: ["invented", "places", "key", "0123456789abcdef"].join("-"),
  YELP_API_KEY: ["invented", "yelp", "key", "0123456789abcdef"].join("_"),
};

export const BAR_CONFIG: ListingsConfig = JSON.parse(
  readFileSync(`${BAR_DIR}/gaugeline.listings.json`, "utf8"),
) as ListingsConfig;

export function barSettings(
  env: Record<string, string | undefined> = KEYS,
  config: ListingsConfig = BAR_CONFIG,
): ListingsSettings {
  return {
    config,
    env: freezeEnv(env, LISTING_ENV_VARS),
    appleCsv: readFileSync(`${BAR_DIR}/apple-business-connect.csv`, "utf8"),
  };
}

/** A fetcher that serves the bar's site from its folder and everything else from a cassette. */
export function barFetcher(
  cassette: string,
  seen: { url: URL; headers: Record<string, string> }[] = [],
): Fetcher {
  const recorded = useCassette(cassette, { mode: "replay" });
  const others: Transport = (url, req) => {
    seen.push({ url, headers: req.headers });
    return recorded(url, req);
  };
  return createFetcher({ transport: staticSite(BAR_HOST, BAR_DIR, others), timeoutMs: 5000 });
}
