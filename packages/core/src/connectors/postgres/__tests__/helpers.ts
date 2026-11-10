import { createFetcher } from "../../../fetcher.js";
import { runConnectors } from "../../run.js";
import type { ConnectorRun } from "../../types.js";
import { sourceSchema, type SourceConfig } from "../config.js";
import { databaseConnector, type DatabaseQueryResult } from "../connector.js";

/** A source as the config schema would read it, so tests use the same defaults the CLI would. */
export function source(input: Record<string, unknown>): SourceConfig {
  return sourceSchema.parse(input);
}

export const DB_VAR = "GAUGELINE_POSTGRES_URL";

/** The address of a stand-in or throwaway server on this machine, with a user and password. */
export function localUrl(
  port: number,
  user = "reader",
  password = "pw-0123456789",
  db = "bar",
): string {
  return `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${db}?sslmode=disable`;
}

export interface Ran {
  run: ConnectorRun;
  results: DatabaseQueryResult[];
}

/** Run one source through the G23 runner, the way a check run would. */
export async function runSource(
  config: SourceConfig,
  env: Record<string, string>,
  name = "db",
): Promise<Ran> {
  const run = await runConnectors([databaseConnector(name, config)], env, createFetcher({}));
  return { run, results: (run.data.get(`db:${name}`) ?? []) as DatabaseQueryResult[] };
}
