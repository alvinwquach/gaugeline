import type { PageSnapshot } from "../snapshot.js";
import { FINGERPRINTS } from "./fingerprints.js";

/**
 * How many times a page loads each Tag Manager container and each GA4 measurement id, from the script
 * tags the snapshot kept (script addresses and inline code). Reads the page; sends nothing. The noscript
 * iframe is the other half of one install and is not counted. A tag a script adds after the page loads is
 * not seen.
 */
export interface AnalyticsLoads {
  /** Container id -> script tags that load it (the snippet inline, or gtm.js by address). */
  containers: Map<string, number>;
  /** Measurement id -> gtag.js script addresses that name it. */
  gtagScripts: Map<string, number>;
  /** Measurement id -> gtag('config', id) calls. Each one sends its own page view unless it says not to. */
  gtagConfigs: Map<string, number>;
  /** Every measurement id the page's own code names, sorted. */
  ga4Ids: string[];
}

const kind = (k: string) => FINGERPRINTS.find((f) => f.kind === k);

/** The ids a pattern list finds in one text, once each. */
function idsIn(text: string, patterns: readonly RegExp[] | undefined): string[] {
  const found = new Set<string>();
  for (const pattern of patterns ?? [])
    for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const id = m.groups?.["id"];
      if (id !== undefined) found.add(id);
    }
  return [...found];
}

const bump = (map: Map<string, number>, id: string, by = 1) => map.set(id, (map.get(id) ?? 0) + by);

export function analyticsLoads(page: Pick<PageSnapshot, "scriptTags">): AnalyticsLoads {
  const gtm = kind("gtm")?.script;
  const ga4 = kind("ga4")?.script;
  const containers = new Map<string, number>();
  const gtagScripts = new Map<string, number>();
  const gtagConfigs = new Map<string, number>();
  for (const tag of page.scriptTags ?? []) {
    // One tag is one load of a container, however many of the patterns read it.
    for (const id of idsIn(tag.src ?? tag.inline ?? "", gtm)) bump(containers, id);
    // The first GA4 pattern is the gtag.js address, the second the config call (a test pins the order).
    if (tag.src !== undefined)
      for (const id of idsIn(tag.src, ga4?.slice(0, 1))) bump(gtagScripts, id);
    else {
      const text = tag.inline ?? "";
      for (const m of text.matchAll(new RegExp(ga4?.[1]?.source ?? "$^", ga4?.[1]?.flags ?? "g"))) {
        const id = m.groups?.["id"];
        if (id !== undefined) bump(gtagConfigs, id);
      }
    }
  }
  return {
    containers,
    gtagScripts,
    gtagConfigs,
    ga4Ids: [...new Set([...gtagScripts.keys(), ...gtagConfigs.keys()])].sort(),
  };
}
