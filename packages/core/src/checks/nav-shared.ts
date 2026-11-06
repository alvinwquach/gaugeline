import { readRegions, type NavRules, type PageNav } from "../nav/read-regions.js";
import type { PageSnapshot } from "../snapshot.js";

const cache = new WeakMap<object, PageNav>();

/** A page's navigation, read once per page per run (the rules are fixed for a run). */
export function navOf(page: Pick<PageSnapshot, "hops" | "finalUrl">, rules?: NavRules): PageNav {
  const hit = cache.get(page);
  if (hit) return hit;
  const nav = readRegions(page, rules);
  cache.set(page, nav);
  return nav;
}

/** "header › Menu › Breads" for evidence; the destination is shown as a path on the same site. */
export function where(region: string, parent: string, text: string): string {
  return [region, parent, text].filter((s) => s !== "").join(" › ");
}
