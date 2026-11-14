import { escapeInvisible } from "../checks/hidden-text/escape.js";
import type { SanityRead } from "../connectors/sanity.js";
import type { Finding } from "../model.js";

/**
 * Two or more published documents of one type that mean the same thing: they share a slug (the
 * same address) or a title (the same name). `value` is the slug as it is, or the title as the
 * document with the lowest id wrote it. `ids` is sorted.
 */
export interface DupeGroup {
  type: string;
  key: "slug" | "title";
  value: string;
  ids: string[];
}

/** How many ids a finding lists before it says how many more there are. */
const LISTED_IDS = 10;

/** The finding titles are not static: each one names a count, a type and a value. */
export const DUPE_TITLES = {
  slug: "Two documents share a slug",
  title: "Two documents share a title",
} as const;

/**
 * The one query for one type: the id, the slug and the title of each document, and nothing else.
 * Published documents only is the request's perspective (see productsUrl), not part of the query.
 * The type is written as a JSON string, so a name from a file can add nothing to the query.
 */
export function dupesQuery(type: string): string {
  return `*[_type == ${JSON.stringify(type)}]{_id,"slug":slug.current,title}`;
}

/** Code-unit order, the same on every machine (localeCompare depends on the locale). */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Titles are compared after trimming and case folding; slugs are compared exactly. */
const titleKey = (title: string): string => title.trim().toLowerCase();

interface Bucket {
  ids: string[];
  /** The id and the text of the document with the lowest id so far: what a title group shows. */
  shownId: string;
  shown: string;
}

function put(buckets: Map<string, Bucket>, key: string, id: string, shown: string): void {
  const bucket = buckets.get(key);
  if (bucket === undefined) {
    buckets.set(key, { ids: [id], shownId: id, shown });
    return;
  }
  bucket.ids.push(id);
  if (id < bucket.shownId) {
    bucket.shownId = id;
    bucket.shown = shown;
  }
}

/** The groups of one type, from the rows Sanity answered with. One pass: each id goes into its bucket. */
function groupsOf(type: string, result: unknown): DupeGroup[] {
  if (!Array.isArray(result))
    throw new Error("Sanity answered with something that is not a list of documents.");
  const slugs = new Map<string, Bucket>();
  const titles = new Map<string, Bucket>();
  for (const row of result as unknown[]) {
    if (row === null || typeof row !== "object") continue;
    const doc = row as Record<string, unknown>;
    const id = doc._id;
    // A draft is never half of a pair: it is the same document as the one it will become.
    if (typeof id !== "string" || id === "" || id.startsWith("drafts.")) continue;
    if (typeof doc.slug === "string" && doc.slug.trim() !== "") put(slugs, doc.slug, id, doc.slug);
    if (typeof doc.title === "string" && doc.title.trim() !== "")
      put(titles, titleKey(doc.title), id, doc.title.trim());
  }
  const groups: DupeGroup[] = [];
  // The slug group each id is in, so a title group that is only that pair is not reported twice.
  const slugOf = new Map<string, string>();
  for (const [value, b] of [...slugs].sort((a, c) => byCodeUnit(a[0], c[0]))) {
    if (b.ids.length < 2) continue;
    for (const id of b.ids) slugOf.set(id, value);
    groups.push({ type, key: "slug", value, ids: b.ids.sort(byCodeUnit) });
  }
  for (const [, b] of [...titles].sort((a, c) => byCodeUnit(a[0], c[0]))) {
    if (b.ids.length < 2) continue;
    const first = slugOf.get(b.ids[0] ?? "");
    if (first !== undefined && b.ids.every((id) => slugOf.get(id) === first)) continue;
    groups.push({ type, key: "title", value: b.shown, ids: b.ids.sort(byCodeUnit) });
  }
  return groups;
}

/**
 * The documents of each type that share a slug or a title: one request for each type (a GET of the
 * query endpoint, published documents), asking for the id, the slug and the title. A Map from a
 * slug, or from a trimmed and lower-cased title, to the ids that have it: one pass, and a bucket
 * with more than one id is a group. Documents with no slug, or no title, are left out of that key.
 * Types are kept apart (the same slug on a page and on a post is two addresses). The groups come in
 * the order the types were named, slug groups first.
 */
export async function findDupes(types: string[], sanity: SanityRead): Promise<DupeGroup[]> {
  const distinct = [...new Set(types)];
  const answers = await Promise.all(distinct.map((t) => sanity.query(dupesQuery(t))));
  return distinct.flatMap((type, i) => groupsOf(type, answers[i]));
}

const quoted = (text: string): string => `\u201C${escapeInvisible(text, 80)}\u201D`;

function idList(ids: readonly string[]): string {
  const shown = ids.slice(0, LISTED_IDS).map((id) => escapeInvisible(id, 80));
  const more = ids.length - shown.length;
  return more > 0 ? `${shown.join(", ")}, and ${more} more` : shown.join(", ");
}

/**
 * One finding for each group: a shared slug is high (only one document can own the address), a
 * shared title is a warning (different addresses, same thing). The ids are the evidence, sorted,
 * ten at most and then how many more. Text an editor wrote is escaped and cut.
 */
export function dupeFindings(groups: readonly DupeGroup[]): Finding[] {
  return groups.map((g): Finding => {
    const type = escapeInvisible(g.type, 60);
    const url = `sanity:${type}`;
    return g.key === "slug"
      ? {
          checkId: "query-dupe-slug",
          severity: "high",
          title: `${g.ids.length} ${type} documents share the slug ${quoted(g.value)}`,
          evidence: `Only one can own the address. ${idList(g.ids)}`,
          url,
        }
      : {
          checkId: "query-dupe-title",
          severity: "medium",
          title: `${g.ids.length} ${type} documents are called ${quoted(g.value)}`,
          evidence: `Different addresses, same thing. ${idList(g.ids)}`,
          url,
        };
  });
}
