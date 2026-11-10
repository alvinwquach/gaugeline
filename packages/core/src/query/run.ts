import { createQueryRegistry, type QueryInput } from "../checks/query-counts.js";
import { createGraphqlRegistry } from "../checks/query-graphql.js";
import { createMutationsRegistry } from "../checks/query-mutations.js";
import { createUnusedRegistry } from "../checks/query-unused.js";
import { ConnectorRateLimitedError, ConnectorRefusedError } from "../connectors/http.js";
import { createSanityRead } from "../connectors/sanity.js";
import type { Env } from "../connectors/types.js";
import { ConfigError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import { buildResult, type Result } from "../result.js";
import { runChecks } from "../run.js";
import { readContentShape, type ContentShape } from "./content-shape.js";
import { fetchCounts, type TypeCounts } from "./counts.js";
import { findDupes, type DupeGroup } from "./dupes.js";
import { graphqlShapes, type GqlFieldUse, type GqlSchema } from "./graphql.js";
import type { MutationShape, SchemaFile, SchemaShape } from "./mutations.js";
import type { QueryShape } from "./shape.js";
import { suggestQuery } from "./suggest.js";
import type { UnusedAnalysis } from "./unused.js";

export interface QueryCompareOptions {
  shapes: readonly QueryShape[];
  /** SANITY_PROJECT_ID, SANITY_DATASET and SANITY_TOKEN. */
  env: Env;
  fetcher: Fetcher;
  now: Date;
  /** --dupes: also ask for the id, slug and title of each document and report documents that share one. */
  dupes?: boolean;
  /** --mutations: the writes read from the code and the schema to compare them with. Nothing about them is sent. */
  mutations?: { shapes: readonly MutationShape[]; schema: SchemaShape };
}

export interface QueryCompareRun {
  counts: Map<string, TypeCounts>;
  /** The documents that share a slug or a title; undefined unless dupes was asked for. */
  dupes?: DupeGroup[];
  /** Plain-language lines for stderr: the dataset that was assumed, a query sent in parts. Never a key. */
  notices: string[];
  result: Result;
}

/** A failed read of the dataset, as the ConfigError the person sees (exit 2). */
function unreadable(err: unknown): ConfigError {
  if (err instanceof ConnectorRefusedError)
    return new ConfigError(
      `Sanity refused the request (HTTP ${err.status}).${err.hint ? ` ${err.hint}` : ""}`,
      { hint: "The steps are in docs/private-datasets." },
    );
  if (err instanceof ConnectorRateLimitedError)
    return new ConfigError(err.message, { hint: "Run it again in a minute." });
  return new ConfigError(err instanceof Error ? err.message : String(err), {
    hint: "Nothing was changed in your dataset: Gaugeline only reads.",
  });
}

/**
 * Compare the queries found in a repository with the dataset: one request per document type (counts
 * only), then the four query checks. With `dupes`, one more request per type for the id, slug and
 * title of each published document, and the two duplicate checks. SANITY_PROJECT_ID must be set (the caller decides whether to
 * ask at all). A private dataset with no token, a token Sanity refuses or a dataset that cannot be
 * read is a ConfigError (exit 2).
 */
export async function compareQueries(options: QueryCompareOptions): Promise<QueryCompareRun> {
  const { shapes, env, fetcher, now } = options;
  const notices: string[] = [];
  let read;
  try {
    read = createSanityRead(env, fetcher);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err), {
      hint: "The settings are SANITY_PROJECT_ID, SANITY_DATASET and SANITY_TOKEN; the steps are in docs/private-datasets.",
    });
  }
  if (read.datasetAssumed)
    notices.push(
      `SANITY_DATASET is not set, so the dataset "${read.dataset}" was assumed. Set it if your content lives in another dataset.`,
    );
  let counts: Map<string, TypeCounts>;
  let dupes: DupeGroup[] | undefined;
  try {
    counts = await fetchCounts(shapes, read, { log: (m) => notices.push(m) });
    if (options.dupes === true)
      dupes = await findDupes([...new Set(shapes.map((s) => s.type))], read);
  } catch (err) {
    throw unreadable(err);
  }
  const checked = await runChecks(
    {
      shapes,
      counts,
      ...(dupes ? { dupes } : {}),
      ...(options.mutations ? { mutations: options.mutations } : {}),
    },
    createQueryRegistry({ dupes: dupes !== undefined, mutations: options.mutations !== undefined }),
  );
  const types = counts.size;
  return {
    counts,
    ...(dupes ? { dupes } : {}),
    notices,
    result: buildResult({
      url: "query",
      startedAt: now,
      findings: checked.findings,
      passed: checked.passed,
      failed: checked.failed.map((f) => f.id),
      couldNotCheck: checked.couldNotCheck,
      sampled: { "query-types": { seen: types, taken: types, limit: types } },
    }),
  };
}

/**
 * `gaugeline query --mutations` with no SANITY_PROJECT_ID: the five mutation checks over the writes
 * read from the code, and nothing else. No request of any kind is made, and none could be: this
 * path never touches the fetcher.
 */
export async function checkMutationsOnly(options: {
  mutations: { shapes: readonly MutationShape[]; schema: SchemaShape };
  now: Date;
}): Promise<QueryCompareRun> {
  const input: QueryInput = { shapes: [], counts: new Map(), mutations: options.mutations };
  const checked = await runChecks(input, createMutationsRegistry());
  return {
    counts: new Map(),
    notices: [],
    result: buildResult({
      url: "query",
      startedAt: options.now,
      findings: checked.findings,
      passed: checked.passed,
      failed: checked.failed.map((f) => f.id),
      couldNotCheck: checked.couldNotCheck,
    }),
  };
}

/**
 * `gaugeline query --unused`: the unused-field check over what the analysis of the repository found.
 * No request of any kind is made, and none could be: this path never touches the fetcher or the
 * environment. A query that could not be followed is recorded under the check as could-not-check,
 * with its file and line, and none of its fields is reported.
 */
export async function checkUnusedOnly(options: {
  analysis: Pick<UnusedAnalysis, "findings" | "couldNotFollow">;
  now: Date;
}): Promise<QueryCompareRun> {
  const input: QueryInput = {
    shapes: [],
    counts: new Map(),
    unused: {
      findings: options.analysis.findings,
      couldNotFollow: options.analysis.couldNotFollow,
    },
  };
  const checked = await runChecks(input, createUnusedRegistry());
  return {
    counts: new Map(),
    notices: [],
    result: buildResult({
      url: "query",
      startedAt: options.now,
      findings: checked.findings,
      passed: checked.passed,
      failed: checked.failed.map((f) => f.id),
      couldNotCheck: checked.couldNotCheck,
    }),
  };
}

export interface GraphqlCompareOptions {
  uses: readonly GqlFieldUse[];
  schema: GqlSchema;
  /**
   * Present when the documents are to be compared with the content too: SANITY_PROJECT_ID,
   * SANITY_DATASET and SANITY_TOKEN, and the fetcher the counts go through. Absent: only the
   * schema is checked, and no request is made here.
   */
  sanity?: { env: Env; fetcher: Fetcher };
  now: Date;
}

/**
 * `gaugeline query --graphql`: the field check over the documents and the schema, and then, when
 * `sanity` is given, the same document types counted in the dataset (one request per type, counts
 * only) and the three count checks over them. The schema says a field may exist; only a count says
 * it does. The document types are the ones the schema marks as Sanity documents; a schema with
 * none has nothing to count, and `types` says so (0) without a request.
 */
export async function compareGraphql(
  options: GraphqlCompareOptions,
): Promise<QueryCompareRun & { types: number }> {
  const { uses, schema, sanity, now } = options;
  const shapes = sanity ? graphqlShapes(uses, schema) : [];
  const notices: string[] = [];
  let counts = new Map<string, TypeCounts>();
  if (sanity && shapes.length > 0) {
    let read;
    try {
      read = createSanityRead(sanity.env, sanity.fetcher);
    } catch (err) {
      throw new ConfigError(err instanceof Error ? err.message : String(err), {
        hint: "The settings are SANITY_PROJECT_ID, SANITY_DATASET and SANITY_TOKEN; the steps are in docs/private-datasets.",
      });
    }
    try {
      counts = await fetchCounts(shapes, read, { log: (m) => notices.push(m) });
    } catch (err) {
      throw unreadable(err);
    }
  }
  const counted = counts.size > 0;
  const checked = await runChecks(
    { shapes, counts, graphql: { uses, schema } },
    counted ? createQueryRegistry({ graphql: true }) : createGraphqlRegistry(),
  );
  return {
    counts,
    notices,
    types: counts.size,
    result: buildResult({
      url: "query",
      startedAt: now,
      findings: checked.findings,
      passed: checked.passed,
      failed: checked.failed.map((f) => f.id),
      couldNotCheck: checked.couldNotCheck,
      ...(counted
        ? {
            sampled: {
              "query-types": { seen: counts.size, taken: counts.size, limit: counts.size },
            },
          }
        : {}),
    }),
  };
}

export interface SuggestOptions {
  /** The document type to write a query for. */
  type: string;
  /** SANITY_PROJECT_ID, SANITY_DATASET and SANITY_TOKEN. */
  env: Env;
  fetcher: Fetcher;
  /** The schema extract the field names and kinds come from. */
  schema: SchemaFile;
  /** How many of the newest published documents the counts are over. Default 50. */
  sample?: number;
}

export interface SuggestRun {
  shape: ContentShape;
  /** The query, or undefined when the type has no published documents. */
  query?: string;
  /** The dataset that was read. */
  dataset: string;
  /** Plain-language lines for stderr: the dataset that was assumed. Never a key. */
  notices: string[];
}

/** The shape of a type's published documents, and where it was read from. */
export interface ShapeRun {
  shape: ContentShape;
  /** The dataset that was read. */
  dataset: string;
  /** Plain-language lines for stderr: the dataset that was assumed. Never a key. */
  notices: string[];
}

/**
 * Take a type's field names and kinds from the schema file and count how many of the newest
 * published documents have each field (count queries, one GET, drafts left out): the shape that
 * `--suggest` writes a query from and `--page` writes a route from. No document and no value is
 * ever requested. A private dataset with no token, a token Sanity refuses or an unreadable
 * dataset is a ConfigError (exit 2), and so is a type name that is not one. A type with no
 * published documents comes back with `sampled` 0.
 */
export async function readShapeForType(options: SuggestOptions): Promise<ShapeRun> {
  const notices: string[] = [];
  let read;
  try {
    read = createSanityRead(options.env, options.fetcher);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err), {
      hint: "The settings are SANITY_PROJECT_ID, SANITY_DATASET and SANITY_TOKEN; the steps are in docs/private-datasets.",
    });
  }
  if (read.datasetAssumed)
    notices.push(
      `SANITY_DATASET is not set, so the dataset "${read.dataset}" was assumed. Set it if your content lives in another dataset.`,
    );
  let shape: ContentShape;
  try {
    shape = await readContentShape(options.type, read, options.schema, options.sample);
  } catch (err) {
    throw err instanceof ConfigError ? err : unreadable(err);
  }
  return { shape, dataset: read.dataset, notices };
}

/**
 * `gaugeline query --suggest --type <name>`: take the type's field names and kinds from the schema
 * file, count how many of the newest published documents have each field (count queries, one GET,
 * drafts left out), and write a query from the result. Plain rules, no model: the same schema and
 * counts give the same text. No document and no value is ever requested. A private dataset with no token, a token Sanity refuses or an unreadable dataset is a
 * ConfigError (exit 2), and so is a type name that is not one.
 */
export async function suggestForType(options: SuggestOptions): Promise<SuggestRun> {
  const run = await readShapeForType(options);
  return {
    ...run,
    ...(run.shape.sampled === 0 ? {} : { query: suggestQuery(run.shape) }),
  };
}
