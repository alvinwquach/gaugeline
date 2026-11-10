import { CheckRegistry, defineCheck, type Check, type Finding } from "../model.js";
import { TITLES, compareWithCounts, type TypeCounts } from "../query/counts.js";
import type { DupeGroup } from "../query/dupes.js";
import type { QueryShape } from "../query/shape.js";
import type { MutationShape, SchemaShape } from "../query/mutations.js";
import type { GqlFieldUse, GqlSchema } from "../query/graphql.js";
import type { CouldNotFollow } from "../query/unused.js";
import { GRAPHQL_CHECKS } from "./query-graphql.js";
import { MUTATION_CHECKS } from "./query-mutations.js";
import { QUERY_DUPE_CHECKS } from "./query-dupes.js";

/** What the query checks read: the queries found in a repository, and what the dataset holds. */
export interface QueryInput {
  shapes: readonly QueryShape[];
  /** What the dataset holds, by type. A type with no entry gets only the drafts finding. */
  counts: ReadonlyMap<string, TypeCounts>;
  /** The documents that share a slug or a title (--dupes). Absent: the dupe checks are not run. */
  dupes?: readonly DupeGroup[];
  /** The writes found in the code and the schema they are compared with (--mutations). Absent: the mutation checks are not run. */
  mutations?: { shapes: readonly MutationShape[]; schema: SchemaShape };
  /** The GraphQL fields found in the code and the schema they are compared with (--graphql). Absent: the GraphQL check is not run. */
  graphql?: { uses: readonly GqlFieldUse[]; schema: GqlSchema };
  /** What the unused-field analysis found (--unused). Absent: the unused-field check is not run. */
  unused?: { findings: readonly Finding[]; couldNotFollow: readonly CouldNotFollow[] };
}

const only = (id: string, input: QueryInput) =>
  compareWithCounts(input.shapes, input.counts).filter((f) => f.checkId === id);

const TECH =
  "one GET of the query endpoint for each document type (perspective=published, so drafts are never counted), asking for count(*[_type == T]) and count(*[_type == T && defined(path)]) for each distinct field path, held in a Map from type to a Map from path to an integer; a reference or an array of objects is counted at the field itself (topic, not topic->title); the answer is integers, so no document and no field value is read";

export const queryFieldAbsent = defineCheck<QueryInput>({
  id: "query-field-absent",
  area: "Visitors",
  severity: "high",
  title: TITLES.absent,
  what: "A query in your code asks for a field of a document type, and no published document of that type has it.",
  why: "The field was renamed or never filled in, and the page that asks for it renders empty every time. The schema still declares it, so a type check passes and nobody sees the gap until a customer does.",
  fix: "Open the file and line named, then find what the field is called in your content now (the Studio shows it) and change the query, or fill the field in. Ask Gaugeline again to confirm.",
  tech: `${TECH}; a path whose count is 0 while the type's total is above 0`,
  run: (input) => only("query-field-absent", input),
});

export const queryTypeEmpty = defineCheck<QueryInput>({
  id: "query-type-empty",
  area: "Visitors",
  severity: "high",
  title: TITLES.empty,
  what: "A query in your code asks for a document type, and the dataset has no published documents of it.",
  why: "Either the type was renamed or the content has not been created yet. Every page built from the query is blank, and its fields are not reported separately because none of them can exist.",
  fix: "Check the type's name in the Studio against the one in the query, or publish the documents. A document that is only a draft does not count.",
  tech: `${TECH}; count(*[_type == T]) is 0`,
  run: (input) => only("query-type-empty", input),
});

export const queryFieldPartial = defineCheck<QueryInput>({
  id: "query-field-partial",
  area: "Visitors",
  severity: "low",
  title: TITLES.partial,
  what: "A query asks for a field that some published documents of the type have and others do not.",
  why: "Fine when the field is optional. When the page assumes it is there (a link built from it, an image with no fallback), the documents without it break or show a gap.",
  fix: "If the field is optional, make the template cope with it missing. If it is not, fill it in on the documents listed by their count, or mark it required in the schema.",
  tech: `${TECH}; a path whose count is above 0 and below the type's total`,
  run: (input) => only("query-field-partial", input),
});

export const queryNoDraftsFilter = defineCheck<QueryInput>({
  id: "query-no-drafts-filter",
  area: "Security & email",
  severity: "medium",
  title: TITLES.drafts,
  what: "The filter of a query in your code does not leave drafts out.",
  why: "With the published perspective in the client that is safe. If anything runs the query with drafts included (preview mode, a token with the wrong perspective), unpublished content reaches a visitor.",
  fix: 'Add !(_id in path("drafts.**")) to the filter, or make sure the client always asks for the published perspective. Gaugeline cannot see the client, only the query.',
  tech: 'read from the repository with no request: the query\'s filter is parsed and does not require !(_id in path("drafts.**")) (or match "drafts.*") in an && chain',
  run: (input) => only("query-no-drafts-filter", input),
});

/** The checks `gaugeline query` always runs (the two it adds with --dupes are QUERY_DUPE_CHECKS). They read a QueryInput, not a page. */
export const QUERY_CHECKS: readonly Check<QueryInput>[] = [
  queryFieldAbsent,
  queryTypeEmpty,
  queryFieldPartial,
  queryNoDraftsFilter,
];

export function createQueryRegistry(
  options: { dupes?: boolean; mutations?: boolean; graphql?: boolean } = {},
): CheckRegistry {
  const registry = new CheckRegistry();
  // The schema check comes first: it says what cannot be asked at all, before what the content lacks.
  if (options.graphql === true) for (const c of GRAPHQL_CHECKS) registry.register(c);
  for (const c of QUERY_CHECKS) registry.register(c);
  if (options.dupes === true) for (const c of QUERY_DUPE_CHECKS) registry.register(c);
  if (options.mutations === true) for (const c of MUTATION_CHECKS) registry.register(c);
  return registry;
}
