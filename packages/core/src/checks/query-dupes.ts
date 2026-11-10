import { CheckRegistry, defineCheck, type Check } from "../model.js";
import { DUPE_TITLES, dupeFindings } from "../query/dupes.js";
import type { QueryInput } from "./query-counts.js";

const TECH =
  'one GET of the query endpoint for each document type (perspective=published, so drafts are never read), projecting only _id, "slug": slug.current and title; one pass puts each id into a Map from the slug as it is, or from the trimmed and lower-cased title, to the ids that have it, and a bucket with more than one id is a group; documents with no slug or no title are left out of that key, a draft id is skipped, and types are grouped apart';

const only = (id: string, input: QueryInput) =>
  dupeFindings(input.dupes ?? []).filter((f) => f.checkId === id);

export const queryDupeSlug = defineCheck<QueryInput>({
  id: "query-dupe-slug",
  area: "Visitors",
  severity: "high",
  title: DUPE_TITLES.slug,
  what: "Two or more published documents of one type have the same slug.",
  why: "A slug is the address. Only one document can own it, so a page built from the other cannot be reached, or the site shows whichever the query happens to return first.",
  fix: "Open the documents named by their ids in the Studio. Delete the copy you do not want, or give it its own slug.",
  tech: `${TECH}; a slug shared by two or more ids of one type`,
  run: (input) => only("query-dupe-slug", input),
});

export const queryDupeTitle = defineCheck<QueryInput>({
  id: "query-dupe-title",
  area: "Search & sharing",
  severity: "medium",
  title: DUPE_TITLES.title,
  what: "Two or more published documents of one type are called the same thing, ignoring case and spaces around the title.",
  why: "Different addresses, same name: usually content that was duplicated and not moved, which splits search results between two pages. It can also be two real pages that need different names.",
  fix: "Open the documents named by their ids. If one is a copy, delete it and redirect its address; if both are real, rename one so a visitor can tell them apart.",
  tech: `${TECH}; a title shared by two or more ids of one type that do not all share one slug`,
  run: (input) => only("query-dupe-title", input),
});

/** The checks `gaugeline query --dupes` adds. They read the groups in a QueryInput. */
export const QUERY_DUPE_CHECKS: readonly Check<QueryInput>[] = [queryDupeSlug, queryDupeTitle];

/** Only the two dupe checks. `createQueryRegistry({ dupes: true })` adds them to the four counts checks. */
export function createDupesRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of QUERY_DUPE_CHECKS) registry.register(c);
  return registry;
}
