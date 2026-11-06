import type { NavEntry, PageNav } from "./read-regions.js";

/**
 * The navigation between two runs, and the site's link graph. A link's identity is region, parent
 * and destination: the same destination under a new parent is a move, under the same parent with
 * new text a rename. Pure.
 */
export type NavChangeKind = "added" | "removed" | "moved" | "renamed" | "reordered";

export interface NavChange {
  kind: NavChangeKind;
  region: NavEntry["region"];
  destination: string;
  text: string;
  /** For moved: where it was. For renamed: what it was called. For reordered: the old position. */
  from?: string;
  /** For moved: the new parent. For reordered: the new position. */
  to?: string;
  parent: string;
}

const id = (e: Pick<NavEntry, "region" | "parent" | "destination">) =>
  `${e.region}|${e.parent}|${e.destination}`;
const place = (e: Pick<NavEntry, "region" | "destination">) => `${e.region}|${e.destination}`;

/** The menus that are compared: the header and the footer (body links change with every post). */
export const COMPARED: ReadonlySet<NavEntry["region"]> = new Set(["header", "footer"]);

export function diffNav(prev: readonly NavEntry[], next: readonly NavEntry[]): NavChange[] {
  const before = new Map(prev.filter((e) => COMPARED.has(e.region)).map((e) => [id(e), e]));
  const after = new Map(next.filter((e) => COMPARED.has(e.region)).map((e) => [id(e), e]));
  const out: NavChange[] = [];
  const gone = [...before.values()].filter((e) => !after.has(id(e)));
  const arrived = [...after.values()].filter((e) => !before.has(id(e)));
  // A destination that left one parent and arrived under another, in the same region, moved.
  const arrivedByPlace = new Map<string, NavEntry[]>();
  for (const e of arrived)
    arrivedByPlace.set(place(e), [...(arrivedByPlace.get(place(e)) ?? []), e]);
  const paired = new Set<NavEntry>();
  for (const e of gone) {
    const target = arrivedByPlace.get(place(e))?.find((a) => !paired.has(a));
    if (target) {
      paired.add(target);
      out.push({
        kind: "moved",
        region: e.region,
        destination: e.destination,
        text: target.text,
        parent: target.parent,
        from: e.parent || "the top level",
        to: target.parent || "the top level",
      });
    } else
      out.push({
        kind: "removed",
        region: e.region,
        destination: e.destination,
        text: e.text,
        parent: e.parent,
      });
  }
  for (const e of arrived)
    if (!paired.has(e))
      out.push({
        kind: "added",
        region: e.region,
        destination: e.destination,
        text: e.text,
        parent: e.parent,
      });
  // Reordered: the links in both runs, ranked among their siblings in each; a link removed or
  // added before it doesn't move it.
  const common = [...after.keys()].filter((k) => before.has(k));
  const rank = (from: ReadonlyMap<string, NavEntry>) => {
    const out = new Map<string, number>();
    const groups = new Map<string, NavEntry[]>();
    for (const k of common) {
      const e = from.get(k) as NavEntry;
      const g = `${e.region}|${e.parent}`;
      groups.set(g, [...(groups.get(g) ?? []), e]);
    }
    for (const list of groups.values())
      [...list].sort((a, b) => a.order - b.order).forEach((e, i) => out.set(id(e), i));
    return out;
  };
  const rankBefore = rank(before);
  const rankAfter = rank(after);
  for (const key of common) {
    const was = before.get(key) as NavEntry;
    const e = after.get(key) as NavEntry;
    if (was.text !== e.text)
      out.push({
        kind: "renamed",
        region: e.region,
        destination: e.destination,
        text: e.text,
        parent: e.parent,
        from: was.text,
      });
    else if (rankBefore.get(key) !== rankAfter.get(key))
      out.push({
        kind: "reordered",
        region: e.region,
        destination: e.destination,
        text: e.text,
        parent: e.parent,
        from: String((rankBefore.get(key) ?? 0) + 1),
        to: String((rankAfter.get(key) ?? 0) + 1),
      });
  }
  return out;
}

/** Destination -> the pages read that link to it (any region; a page's link to itself doesn't count). */
export function inboundLinks(pages: readonly PageNav[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of pages) {
    let self: string;
    try {
      const u = new URL(p.url);
      u.hash = "";
      if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
      self = u.href;
    } catch {
      self = p.url;
    }
    for (const e of p.entries) {
      if (e.destination === self) continue;
      const from = out.get(e.destination) ?? new Set<string>();
      from.add(p.url);
      out.set(e.destination, from);
    }
  }
  return out;
}

/** Same-site sitemap addresses no page read links to (the checked page itself excepted). */
export function orphans(
  sitemap: readonly string[],
  inbound: ReadonlyMap<string, ReadonlySet<string>>,
  home: string,
): string[] {
  const key = (u: string) => {
    try {
      const x = new URL(u);
      x.hash = "";
      x.hostname = x.hostname.toLowerCase();
      if (x.pathname.length > 1) x.pathname = x.pathname.replace(/\/+$/, "");
      return x.href;
    } catch {
      return u;
    }
  };
  const homeKey = key(home);
  let origin: string;
  try {
    origin = new URL(home).origin;
  } catch {
    return [];
  }
  return [
    ...new Set(
      sitemap
        .map(key)
        .filter((u) => {
          try {
            return new URL(u).origin === origin;
          } catch {
            return false;
          }
        })
        .filter((u) => u !== homeKey && (inbound.get(u)?.size ?? 0) === 0),
    ),
  ];
}
