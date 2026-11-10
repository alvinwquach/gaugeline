import { load } from "cheerio/slim";
import { runConnectors } from "../connectors/run.js";
import type { Connector, ConnectorNotice, Env } from "../connectors/types.js";
import { NetworkError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import { redact } from "../redact.js";
import type { ListingsConfig } from "./config.js";
import { hostOf, type LinkResolution } from "./match.js";
import { appleConnector } from "./sources/apple.js";
import { bioConnector } from "./sources/bio.js";
import {
  GOOGLE_BUSINESS_TOKEN,
  GOOGLE_PLACES_KEY,
  googleBusinessConnector,
  googlePlacesConnector,
} from "./sources/google.js";
import { YELP_KEY, yelpConnector } from "./sources/yelp.js";
import type { Listing } from "./types.js";

/** The environment variables the listing connectors may read: what the CLI hands to core. */
export const LISTING_ENV_VARS = [GOOGLE_BUSINESS_TOKEN, GOOGLE_PLACES_KEY, YELP_KEY] as const;

/** What the run was told about listings. Keys are in `env`; the export is already read from its file. */
export interface ListingsSettings {
  config: ListingsConfig;
  env: Env;
  /** The text of the Apple Business Connect export named in the config. */
  appleCsv?: string;
}

export interface ListingsRead {
  listings: Listing[];
  /** Sources that gave nothing (not set up, refused, rate limited, unreachable), in connector order. */
  notices: ConnectorNotice[];
  /** What opening each listing's website link found, by the link as the listing wrote it. */
  links: Map<string, LinkResolution>;
}

/** The connectors a config asks for, in the order the docs list them. */
export function listingConnectors(settings: ListingsSettings): Connector<Listing>[] {
  const { config } = settings;
  const out: Connector<Listing>[] = [];
  if (config.google?.location) out.push(googleBusinessConnector(config.google.location));
  if (config.google?.placeId) out.push(googlePlacesConnector(config.google.placeId));
  if (config.yelp) out.push(yelpConnector(config.yelp.businessId));
  if (config.apple && settings.appleCsv !== undefined)
    out.push(appleConnector(settings.appleCsv, config.apple.location));
  if (config.bios && config.bios.length > 0) out.push(bioConnector(config.bios));
  return out;
}

/** At most this many distinct links are opened: one GET each, however many sources carry them. */
const MAX_LINKS = 8;
/** Hosts kept from a link-in-bio page. */
const MAX_BIO_HOSTS = 200;

async function open(url: string, fetcher: Fetcher, bio: boolean): Promise<LinkResolution> {
  try {
    const hops = await fetcher.get(url);
    const last = hops.at(-1);
    if (!last) return { error: "no answer", redirects: 0 };
    const found: LinkResolution = {
      status: last.status,
      finalUrl: last.url,
      redirects: Math.max(0, hops.length - 1),
    };
    if (bio && last.status >= 200 && last.status < 300) {
      const hosts = new Set<string>();
      const $ = load(last.body ?? "");
      $("a[href]").each((_, el) => {
        let host: string | undefined;
        try {
          host = hostOf(new URL($(el).attr("href") ?? "", last.url).href);
        } catch {
          host = undefined;
        }
        if (host !== undefined && hosts.size < MAX_BIO_HOSTS) hosts.add(host);
      });
      found.linkHosts = [...hosts];
    }
    return found;
  } catch (err) {
    if (err instanceof NetworkError) return { error: redact(err.message), redirects: 0 };
    throw err;
  }
}

/**
 * Read every listing source the config names (each a connector, all at once), then open each
 * distinct website link once with GET. A source that gives nothing is a notice and the others still
 * come back.
 */
export async function readListings(
  settings: ListingsSettings,
  fetcher: Fetcher,
  options: { debug?: (line: string) => void } = {},
): Promise<ListingsRead> {
  const run = await runConnectors(listingConnectors(settings), settings.env, fetcher, options);
  const listings = [...run.data.values()].flat() as Listing[];
  const links = new Map<string, LinkResolution>();
  const wanted = new Map<string, boolean>();
  for (const l of listings)
    if (l.website && !wanted.has(l.website)) wanted.set(l.website, l.source === "bio-link");
  const opened = await Promise.all(
    [...wanted]
      .slice(0, MAX_LINKS)
      .map(async ([url, bio]) => [url, await open(url, fetcher, bio)] as const),
  );
  for (const [url, found] of opened) links.set(url, found);
  return { listings, notices: run.notices, links };
}

/** Said when a listing check was asked for by id and no listing is set up: not a pass. */
export const NO_LISTINGS =
  "No listing is set up, so listings were not compared. Add gaugeline.listings.json to name your Google, Yelp or Apple listing or your bio links.";

/** What a listing check reads when it was asked for and nothing is configured. */
export function noListings(): ListingsRead {
  return {
    listings: [],
    notices: [{ connector: "listings", kind: "not-configured", message: NO_LISTINGS }],
    links: new Map(),
  };
}

export function lazyListings(
  settings: ListingsSettings,
  fetcher: Fetcher,
  options: { debug?: (line: string) => void } = {},
): () => Promise<ListingsRead> {
  let pending: Promise<ListingsRead> | undefined;
  return () => (pending ??= readListings(settings, fetcher, options));
}
