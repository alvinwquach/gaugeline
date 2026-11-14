import { withCampaignTags } from "../ads/tags.js";
import { NetworkError } from "../errors.js";
import { FetchError, type FetchErrorReason, type Fetcher, type Hop } from "../fetcher.js";
import type { LinkSample } from "../links.js";
import { LIMITS } from "../limits.js";
import { inKind } from "../request-log.js";
import { isSameSite } from "../sample.js";
import type { PageSnapshot } from "../snapshot.js";
import { destinationKey, readRegions, type NavRules } from "./read-regions.js";

/**
 * The test campaign tags a menu link is asked with. They are Gaugeline's own, never a client's, and
 * every finding that mentions them says so. Three utm_ keys, so a redirect that keeps only some of
 * them is seen.
 */
export const NAV_TAGS: Readonly<Record<string, string>> = Object.freeze({
  utm_source: "gaugeline-check",
  utm_medium: "menu-test",
  utm_campaign: "nav-links",
});

/** One menu or footer destination, as it is written in the HTML. */
export interface NavTarget {
  /** Resolved address of the destination, no #fragment. */
  url: string;
  /** "header › Menu › Breads": where the first link to it sits. */
  where: string;
}

export interface NavTargets {
  /** Unique same-site destinations of the header and footer links, header first, in page order. */
  taken: NavTarget[];
  /** How many there were before the allowance. */
  seen: number;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The checked page's menu destinations: links in the header and footer regions (the same regions
 * `nav-changed` reads), same site only, each destination once. The body is not a menu. At most
 * LIMITS.navLinks are taken, header links first, so the cut never drops the main menu for a footer.
 * Nothing is requested here.
 */
export function navTargets(
  page: Pick<PageSnapshot, "hops" | "finalUrl">,
  rules?: NavRules,
): NavTargets {
  const entries = readRegions(page, rules).entries.filter((e) => e.region !== "body");
  const ordered = [
    ...entries.filter((e) => e.region === "header"),
    ...entries.filter((e) => e.region === "footer"),
  ];
  const seen = new Set<string>();
  const unique: NavTarget[] = [];
  for (const e of ordered) {
    if (seen.has(e.destination) || !isSameSite(e.destination, page.finalUrl)) continue;
    seen.add(e.destination);
    const where = [e.region, e.parent, clean(e.text)].filter((s) => s !== "").join(" › ");
    unique.push({ url: e.destination, where });
  }
  return { taken: unique.slice(0, LIMITS.navLinks), seen: unique.length };
}

/** One destination, requested, with every hop the fetcher recorded ([] when it did not answer). */
export interface NavProbe extends NavTarget {
  requested: string;
  hops: Hop[];
  /** Set when the fetcher gave up before the end of the trail (a loop, too many hops). */
  error?: FetchErrorReason;
}

/** Ask each target once (HEAD, GET when HEAD is refused), the campaign tags added when `tags` is set. */
export async function probeNavTargets(
  targets: readonly NavTarget[],
  fetcher: Fetcher,
  tags?: Readonly<Record<string, string>>,
): Promise<NavProbe[]> {
  return Promise.all(
    targets.map(async (t) => {
      const requested = tags ? withCampaignTags(t.url, tags) : t.url;
      return { ...t, requested, ...(await inKind("link", () => trailOf(requested, fetcher))) };
    }),
  );
}

const cache = new WeakMap<object, Map<string, Promise<NavProbe[]>>>();

/**
 * The page's menu destinations, probed once per page and kind per run: every check that reads the
 * menu's answers shares these requests.
 */
export function navProbesOf(
  page: Pick<PageSnapshot, "hops" | "finalUrl">,
  fetcher: Fetcher,
  rules: NavRules | undefined,
  kind: "tagged" | "plain",
): Promise<NavProbe[]> {
  const byKind = cache.get(page) ?? new Map<string, Promise<NavProbe[]>>();
  cache.set(page, byKind);
  let pending = byKind.get(kind);
  if (!pending) {
    pending = probeNavTargets(
      navTargets(page, rules).taken,
      fetcher,
      kind === "tagged" ? NAV_TAGS : undefined,
    );
    byKind.set(kind, pending);
  }
  return pending;
}

/** One destination's whole trail: every hop received, and why it stopped early (a loop, too many hops). */
export interface NavTrail extends NavTarget {
  hops: Hop[];
  /** Set when the fetcher gave up before the end of the trail; the hops are what it had read. */
  error?: FetchErrorReason;
  /** The answer came from the run's link sample: broken-links already judges it. */
  sampled: boolean;
}

async function trailOnce(
  url: string,
  fetcher: Fetcher,
  method?: "HEAD",
): Promise<{ hops: Hop[]; error?: FetchErrorReason }> {
  try {
    return { hops: await fetcher.get(url, method ? { method } : undefined) };
  } catch (err) {
    // A loop or too many hops is an answer about the link, not silence: keep what was read.
    if (err instanceof FetchError) return { hops: err.hops, error: err.reason };
    if (err instanceof NetworkError) return { hops: [] };
    throw err;
  }
}

/** HEAD first; GET when HEAD answers 405 or 501. Unlike probe(), a loop keeps its hops and its reason. */
async function trailOf(url: string, fetcher: Fetcher) {
  const head = await trailOnce(url, fetcher, "HEAD");
  const status = head.hops.at(-1)?.status;
  return status === 405 || status === 501 ? trailOnce(url, fetcher) : head;
}

const trails = new WeakMap<object, Promise<NavTrail[]>>();

/**
 * The page's menu destinations as plain addresses, with every hop. A destination the run's link
 * sample already asked (same address) reuses that answer, so no link is requested twice; the others
 * are asked once here. Shared by every check that reads the menu's trails, once per page per run.
 */
export function navTrailsOf(
  page: Pick<PageSnapshot, "hops" | "finalUrl">,
  fetcher: Fetcher,
  rules: NavRules | undefined,
  sample: LinkSample | undefined,
): Promise<NavTrail[]> {
  let pending = trails.get(page);
  if (!pending) {
    const known = new Map(
      (sample?.taken ?? [])
        .filter((l) => l.hops.length > 0)
        .map((l) => [destinationKey(l.url), l.hops]),
    );
    pending = Promise.all(
      navTargets(page, rules).taken.map(async (t): Promise<NavTrail> => {
        const hops = known.get(destinationKey(t.url));
        if (hops !== undefined) return { ...t, hops, sampled: true };
        return { ...t, ...(await inKind("link", () => trailOf(t.url, fetcher))), sampled: false };
      }),
    );
    trails.set(page, pending);
  }
  return pending;
}
