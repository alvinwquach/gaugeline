import { withCampaignTags } from "../ads/tags.js";
import type { Fetcher, Hop } from "../fetcher.js";
import { LIMITS } from "../limits.js";
import { probe } from "../probe.js";
import { isSameSite } from "../sample.js";
import type { PageSnapshot } from "../snapshot.js";
import { readRegions, type NavRules } from "./read-regions.js";

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
      return { ...t, requested, hops: await probe(requested, fetcher) };
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
