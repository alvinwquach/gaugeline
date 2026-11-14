import { FetchError, type Fetcher, type Hop } from "../fetcher.js";
import { buildSnapshot, jsonLdNodes } from "../snapshot.js";
import type { ListSource, OldItem, OldList } from "./list.js";

/**
 * What the migration checks read: for each item of the old site's list, how the new site answers its
 * path, and, when the old site can still be asked, what the old page said. Everything here is data from
 * the two sites; the checks only compare it. Every request is a GET through the fetcher.
 */

/**
 * Structured data types that describe the whole site or the page in general, which themes and
 * frameworks write in their own way: left out of the comparison so a rebuilt site is not told it lost a
 * WebSite it writes differently. A type that says what the page is (Article, Event, FAQPage, Product,
 * Recipe, LocalBusiness, BreadcrumbList) is compared.
 */
export const SITE_WIDE_TYPES: ReadonlySet<string> = new Set([
  "WebSite",
  "WebPage",
  "ImageObject",
  "Person",
  "Organization",
  "SearchAction",
]);

/** What a page says about itself that the checks compare. */
export interface PageFacts {
  title?: string;
  /** The og:title. */
  og?: string;
  /** The first <h1>. */
  h1?: string;
  /** The canonical's path, with its host and query left off. Absent: the page has no canonical. */
  canonical?: string;
  /** Structured data types, JSON-LD @type and microdata itemtype, sorted, without SITE_WIDE_TYPES. */
  types: string[];
}

export type NewRead =
  /** The new site answered, after zero or more redirects. `trail` is each address asked, in order. */
  | { kind: "answered"; status: number; trail: string[]; facts: PageFacts }
  /** The redirects never ended (a loop, or more than the fetcher follows). */
  | { kind: "loop"; trail: string[] }
  /** Nothing answered: a refusal, a timeout, a certificate. */
  | { kind: "unreachable"; reason: string };

export interface ItemRead {
  item: OldItem;
  /** The old page, when the old site was asked and answered 200; its reason when it did not. */
  old?: PageFacts | { unreadable: string };
  now: NewRead;
}

export interface MigrationReading {
  /** The new site's origin, with no trailing slash. */
  newOrigin: string;
  /** The old site's origin, when one was given. */
  oldOrigin?: string;
  source: ListSource;
  /**
   * Whether old pages were read: "read", or why not: "same-site" (the old address is the new site's own,
   * so asking it gives the new page), "none" (no old address: the list came from a file).
   */
  oldPages: "read" | "same-site" | "none";
  items: ItemRead[];
}

const pathOf = (url: string): string | undefined => {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
};

function typesOf(snapshot: ReturnType<typeof buildSnapshot>): string[] {
  const found = new Set<string>();
  for (const node of jsonLdNodes(snapshot)) {
    const t = node["@type"];
    for (const name of Array.isArray(t) ? t : [t])
      if (typeof name === "string" && name !== "") found.add(name.replace(/^.*[/#]/u, ""));
  }
  for (const t of snapshot.itemTypes ?? []) found.add(t.replace(/^.*[/#]/u, ""));
  return [...found].filter((t) => !SITE_WIDE_TYPES.has(t) && t !== "").sort();
}

/** The facts of the page a trail of hops ended on. */
export function factsOf(hops: readonly Hop[]): PageFacts {
  const snapshot = buildSnapshot([...hops]);
  const canonical = snapshot.canonical === undefined ? undefined : pathOf(snapshot.canonical);
  const h1 = snapshot.headings.find((h) => h.level === 1)?.text;
  const og = snapshot.og["og:title"];
  return {
    ...(snapshot.title !== undefined && snapshot.title !== "" ? { title: snapshot.title } : {}),
    ...(og !== undefined && og !== "" ? { og } : {}),
    ...(h1 !== undefined && h1 !== "" ? { h1 } : {}),
    ...(canonical !== undefined ? { canonical } : {}),
    types: typesOf(snapshot),
  };
}

async function readNew(fetcher: Fetcher, url: string): Promise<NewRead> {
  try {
    const hops = await fetcher.get(url);
    const last = hops.at(-1);
    if (last === undefined) return { kind: "unreachable", reason: "no answer" };
    return {
      kind: "answered",
      status: last.status,
      trail: hops.map((h) => h.url),
      // Facts of a page that is not there are not facts.
      facts: last.status >= 200 && last.status < 300 ? factsOf(hops) : { types: [] },
    };
  } catch (err) {
    if (err instanceof FetchError && (err.reason === "loop" || err.reason === "too-many-redirects"))
      return { kind: "loop", trail: err.hops.map((h) => h.url) };
    return {
      kind: "unreachable",
      reason: err instanceof Error ? err.message : "no answer",
    };
  }
}

async function readOld(fetcher: Fetcher, url: string): Promise<PageFacts | { unreadable: string }> {
  try {
    const hops = await fetcher.get(url);
    const last = hops.at(-1);
    if (last === undefined || last.status < 200 || last.status >= 300)
      return { unreadable: `answered ${last?.status ?? "nothing"}` };
    return factsOf(hops);
  } catch (err) {
    return { unreadable: err instanceof Error ? err.message : "no answer" };
  }
}

/**
 * Ask the new site for every path in the list, and the old site for the same paths when it can be
 * asked. `oldAddress` is the old site's address (an origin); old pages are read only when its host is
 * not the new site's, since after a cutover both are the same site.
 */
export async function readMigration(opts: {
  fetcher: Fetcher;
  newAddress: string;
  oldAddress?: string;
  list: OldList;
}): Promise<MigrationReading> {
  const newOrigin = new URL(opts.newAddress).origin;
  const oldOrigin = opts.oldAddress === undefined ? undefined : new URL(opts.oldAddress).origin;
  const oldPages: MigrationReading["oldPages"] =
    oldOrigin === undefined
      ? "none"
      : new URL(oldOrigin).host === new URL(newOrigin).host
        ? "same-site"
        : "read";
  const items = await Promise.all(
    opts.list.items.map(async (item): Promise<ItemRead> => {
      const [now, old] = await Promise.all([
        readNew(opts.fetcher, `${newOrigin}${item.path}`),
        oldPages === "read" && oldOrigin !== undefined
          ? readOld(opts.fetcher, `${oldOrigin}${item.path}`)
          : Promise.resolve(undefined),
      ]);
      return { item, now, ...(old !== undefined ? { old } : {}) };
    }),
  );
  return {
    newOrigin,
    ...(oldOrigin !== undefined ? { oldOrigin } : {}),
    source: opts.list.source,
    oldPages,
    items,
  };
}
