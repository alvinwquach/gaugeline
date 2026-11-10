import type { Fact } from "../../facts/types.js";
import type { Fetcher } from "../../fetcher.js";
import { runConnectors } from "../run.js";
import type { ConnectorNotice, Env } from "../types.js";
import { queryParts, sourceEnvVars, type SourcesConfig } from "./config.js";
import { databaseConnector, type DatabaseQueryResult } from "./connector.js";
import { factsFromResult } from "./facts.js";

/** What the run was told about databases: the config and the variables it names, already copied. */
export interface DatabasesSettings {
  config: SourcesConfig;
  env: Env;
}

/** Everything the configured sources gave, read once per run. */
export interface DatabasesRead {
  /** Every named query, in config order, with its rows (or why it could not be checked). */
  queries: DatabaseQueryResult[];
  /** The same by "source.query", for a check that asks for one. */
  byName: Map<string, DatabaseQueryResult>;
  /** Rows of the queries that declare a fact mapping, in the X23 facts model. */
  facts: Fact[];
  /** Sources that gave nothing, rows cut at the cap, roles with more power than needed. */
  notices: ConnectorNotice[];
}

/** The variables the configured sources may read: what the CLI hands to core for them. */
export function databaseEnvVars(config: SourcesConfig): string[] {
  return sourceEnvVars(config);
}

/** Read every configured source (all at once, each its own connector), then map facts. */
export async function readDatabases(
  settings: DatabasesSettings,
  fetcher: Fetcher,
  options: { debug?: (line: string) => void } = {},
): Promise<DatabasesRead> {
  const connectors = Object.entries(settings.config.sources).map(([name, source]) =>
    databaseConnector(name, source),
  );
  const run = await runConnectors(connectors, settings.env, fetcher, options);
  const queries: DatabaseQueryResult[] = [];
  const notices = [...run.notices];
  const facts: Fact[] = [];
  for (const [name, source] of Object.entries(settings.config.sources)) {
    const rows = (run.data.get(`db:${name}`) ?? []) as DatabaseQueryResult[];
    queries.push(...rows);
    for (const result of rows) {
      const entry = source.queries[result.query];
      const mapping = entry === undefined ? undefined : queryParts(entry).fact;
      if (!mapping || result.status !== "ok") continue;
      const mapped = factsFromResult(result, mapping);
      facts.push(...mapped.facts);
      if (mapped.skipped > 0)
        notices.push({
          connector: `db:${name}`,
          kind: "advice",
          message: `${mapped.skipped} row${mapped.skipped === 1 ? "" : "s"} of "${result.query}" could not become a fact (an empty value or a price that is not a plain amount).`,
        });
    }
  }
  return {
    queries,
    byName: new Map(queries.map((q) => [`${q.source}.${q.query}`, q])),
    facts,
    notices,
  };
}

/** The read, done once on first use and shared by every check in the run. */
export function lazyDatabases(
  settings: DatabasesSettings,
  fetcher: Fetcher,
  options: { debug?: (line: string) => void } = {},
): () => Promise<DatabasesRead> {
  let pending: Promise<DatabasesRead> | undefined;
  return () => (pending ??= readDatabases(settings, fetcher, options));
}
