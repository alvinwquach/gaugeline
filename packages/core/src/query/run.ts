import { createQueryRegistry } from "../checks/query-counts.js";
import { ConnectorRateLimitedError, ConnectorRefusedError } from "../connectors/http.js";
import { createSanityRead } from "../connectors/sanity.js";
import type { Env } from "../connectors/types.js";
import { ConfigError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import { buildResult, type Result } from "../result.js";
import { runChecks } from "../run.js";
import { fetchCounts, type TypeCounts } from "./counts.js";
import { findDupes, type DupeGroup } from "./dupes.js";
import type { QueryShape } from "./shape.js";

export interface QueryCompareOptions {
  shapes: readonly QueryShape[];
  /** SANITY_PROJECT_ID, SANITY_DATASET and SANITY_TOKEN. */
  env: Env;
  fetcher: Fetcher;
  now: Date;
  /** --dupes: also ask for the id, slug and title of each document and report documents that share one. */
  dupes?: boolean;
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
    { shapes, counts, ...(dupes ? { dupes } : {}) },
    createQueryRegistry({ dupes: dupes !== undefined }),
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
