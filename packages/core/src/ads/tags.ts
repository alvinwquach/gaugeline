import type { FetchErrorReason, Hop } from "../fetcher.js";

/**
 * Do the campaign tags on an ad's link survive the click? The answer is read from the hop list the
 * fetcher already records (G03), so this file makes no request and has no redirect follower of its
 * own: it compares the first address with the last and, when a key is missing, walks the hops to
 * the first redirect whose Location no longer carries it.
 *
 * Only redirects are followed. A script that rewrites the address after the page loads is not seen.
 */

/** The tags a campaign adds to a link, and any other utm_ key. Compared in lower case. */
export const CAMPAIGN_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
] as const;

const CAMPAIGN_KEY = /^(utm_.*|gclid|fbclid)$/i;

/** utm_ anything, gclid and fbclid. */
export function isCampaignKey(key: string): boolean {
  return CAMPAIGN_KEY.test(key);
}

/**
 * What Gaugeline sends when a link carries no tags of its own, so the question can still be asked.
 * Every place that uses them says they are Gaugeline's.
 */
export const PROBE_TAGS: Readonly<Record<string, string>> = Object.freeze({
  utm_source: "gaugeline-check",
  gclid: "test",
});

/**
 * The campaign tags of an address: the first value of each key, decoded (so %20 and + are the same
 * value), under the key in lower case. The fragment is not read: a server never sees it.
 */
export function campaignTags(address: string): Record<string, string> {
  const out: Record<string, string> = {};
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return out;
  }
  for (const [key, value] of url.searchParams) {
    const k = key.toLowerCase();
    if (isCampaignKey(k)) out[k] ??= value;
  }
  return out;
}

/**
 * The address with these tags added after its own query (keys it already has are left alone). The
 * existing query is not rewritten, so what the server receives is what the person wrote.
 */
export function withCampaignTags(address: string, tags: Readonly<Record<string, string>>): string {
  const url = new URL(address);
  const have = new Set([...url.searchParams.keys()].map((k) => k.toLowerCase()));
  const add = Object.entries(tags)
    .filter(([k]) => !have.has(k.toLowerCase()))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  if (add.length === 0) return url.href;
  url.search = `${url.search === "" ? "?" : `${url.search}&`}${add.join("&")}`;
  return url.href;
}

/** Where a redirect hop points, as an absolute address; undefined when it is not a redirect. */
function locationOf(hop: Hop): string | undefined {
  if (![301, 302, 303, 307, 308].includes(hop.status)) return undefined;
  const header = Object.entries(hop.headers).find(([k]) => k.toLowerCase() === "location")?.[1];
  if (header === undefined) return undefined;
  try {
    return new URL(header.trim(), hop.url).href;
  } catch {
    return undefined;
  }
}

/** The address a trail ends at: the last hop's own, or where its redirect pointed if it went no further. */
function endOf(hops: readonly Hop[]): string {
  const last = hops.at(-1);
  return last === undefined ? "" : (locationOf(last) ?? last.url);
}

/** The first redirect that stops carrying a key. */
export interface TagLoss {
  /** The hop, counting from 1. */
  hop: number;
  from: string;
  to: string;
  /** The redirect's status. */
  status: number;
  /** The keys that were carried into this hop and are not in its Location, in the order they were sent. */
  keys: string[];
  /** Keys that were moved into the part after # instead: servers never see it, so the tag is gone. */
  inFragment?: string[];
}

export interface TagSurvival {
  /** The campaign tags on the first address. */
  sent: Record<string, string>;
  /** The ones the last address carries. */
  arrived: Record<string, string>;
  lostAt?: TagLoss;
}

/** Keys of the fragment read as a query string, or as the query after a "?" inside it (#/page?utm_source=x). */
function fragmentTags(address: string): Record<string, string> {
  let hash: string;
  try {
    hash = new URL(address).hash.slice(1);
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  const inner = hash.indexOf("?");
  for (const text of inner === -1 ? [hash] : [hash, hash.slice(inner + 1)])
    for (const [k, v] of new URLSearchParams(text)) {
      const key = k.toLowerCase();
      if (isCampaignKey(key)) out[key] ??= v;
    }
  return out;
}

/**
 * Compare the campaign keys on the first requested address with the last. Order does not matter and
 * values compare after URL decoding, so a redirect that reorders or re-encodes loses nothing. A key
 * with a different value is lost: the report would no longer say what the ad said. When a key is
 * lost, the first redirect whose Location no longer carries it is reported, with the keys it dropped.
 * A duplicated key is compared on its first value only.
 */
export function tagSurvival(hops: readonly Hop[]): TagSurvival {
  const first = hops[0];
  if (first === undefined) return { sent: {}, arrived: {} };
  const sent = campaignTags(first.url);
  const arrived = campaignTags(endOf(hops));
  const lost = Object.keys(sent).filter((k) => arrived[k] !== sent[k]);
  if (lost.length === 0) return { sent, arrived };
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i] as Hop;
    const to = locationOf(hop);
    if (to === undefined) continue;
    const here = campaignTags(hop.url);
    const next = campaignTags(to);
    const keys = lost.filter((k) => here[k] === sent[k] && next[k] !== sent[k]);
    if (keys.length === 0) continue;
    const moved = fragmentTags(to);
    const inFragment = keys.filter((k) => moved[k] === sent[k]);
    return {
      sent,
      arrived,
      lostAt: {
        hop: i + 1,
        from: hop.url,
        to,
        status: hop.status,
        keys,
        ...(inFragment.length > 0 ? { inFragment } : {}),
      },
    };
  }
  // A key is missing at the end but no redirect visibly dropped it (a hop list that does not join
  // up, such as an http fallback): name the first redirect, so the verdict is never "kept".
  const at = Math.max(
    0,
    hops.findIndex((h) => locationOf(h) !== undefined),
  );
  const hop = hops[at] as Hop;
  return {
    sent,
    arrived,
    lostAt: {
      hop: at + 1,
      from: hop.url,
      to: locationOf(hop) ?? endOf(hops),
      status: hop.status,
      keys: lost,
    },
  };
}

/** An address without its query or fragment: where it is, not what it carries. */
export function withoutQuery(address: string): string {
  try {
    const u = new URL(address);
    return `${u.origin}${u.pathname}`;
  } catch {
    return address;
  }
}

/** The text for keys moved into the fragment. */
export function fragmentNote(keys: readonly string[]): string {
  return `${keys.join(", ")} ${keys.length === 1 ? "was" : "were"} moved into the part of the address after #, and servers never see that part, so the tag does not reach your analytics.`;
}

export interface TagProbe {
  /** The destination key from the export. */
  url: string;
  /** The address that was asked for: the destination with the tags added. */
  requested: string;
  /** Whose tags: one ad's real ones from the export, or Gaugeline's own (PROBE_TAGS) when no ad had any. */
  source: "export" | "probe";
  tags: Record<string, string>;
  /** Every hop that was received, also when the trail ended in an error. */
  hops: Hop[];
  /** Why the trail stopped before its end, in a sentence. */
  error?: string;
  /** What kind of failure it was, when the fetcher said (a FetchError). */
  errorReason?: FetchErrorReason;
  ads: number;
  /** The spend behind this page in each currency, minor units. Never added together. */
  spend: { currency: string; amount: number }[];
}

export interface TrailText {
  /** One line per hop, with the campaign keys still there. */
  hops: string[];
  /** One line: kept, or lost at which hop. */
  verdict: string;
  /** Things worth saying beside the verdict. */
  notes: string[];
}

const list = (keys: readonly string[]): string => keys.join(", ");

/** The trail in words, for `gaugeline tags`: a line per hop, one verdict line, and notes. */
export function describeTrail(hops: readonly Hop[], survival = tagSurvival(hops)): TrailText {
  const sentKeys = Object.keys(survival.sent);
  const lines = hops.map((h, i) => {
    const here = campaignTags(h.url);
    const kept = sentKeys.filter((k) => here[k] === survival.sent[k]);
    const status = h.status === 0 ? "-" : String(h.status);
    return `hop ${i + 1}  ${status}  ${h.url}  tags: ${kept.length === 0 ? "none" : list(kept)}`;
  });
  const notes: string[] = [];
  const { lostAt } = survival;
  let verdict: string;
  if (hops.length === 0) verdict = "No answer, so there is nothing to say about the tags.";
  else if (sentKeys.length === 0)
    verdict = "The address carries no campaign tags, so there is nothing to follow.";
  else if (lostAt) {
    const arrivedKeys = sentKeys.filter((k) => survival.arrived[k] === survival.sent[k]);
    verdict = `Campaign tags lost at hop ${lostAt.hop}: the ${lostAt.status} from ${withoutQuery(lostAt.from)} to ${withoutQuery(lostAt.to)} dropped ${list(lostAt.keys)}.${arrivedKeys.length > 0 ? ` ${list(arrivedKeys)} arrived.` : ""}`;
    if (lostAt.inFragment) notes.push(fragmentNote(lostAt.inFragment));
    const later = sentKeys.filter(
      (k) => survival.arrived[k] !== survival.sent[k] && !lostAt.keys.includes(k),
    );
    if (later.length > 0)
      notes.push(`${list(later)} ${later.length === 1 ? "is" : "are"} also missing at the end.`);
  } else {
    const redirects = hops.filter((h) => [301, 302, 303, 307, 308].includes(h.status)).length;
    verdict = `Campaign tags kept: ${list(sentKeys)} arrived (${redirects === 0 ? "no redirect" : `${redirects} ${redirects === 1 ? "redirect" : "redirects"}`}).`;
  }
  const last = hops.at(-1);
  if (last && last.status >= 400)
    notes.push(
      `The last page answered ${last.status}. That is about the page, not its tags: this only reports on the tags.`,
    );
  return { hops: lines, verdict, notes };
}
