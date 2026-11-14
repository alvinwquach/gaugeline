import {
  DEFAULT_RETENTION_DAYS,
  adaptersOrDefault,
  buildChanges,
  compareRuns,
  createChangeSources,
  createFetcher,
  formatBeforeAfter,
  formatChanges,
  parseSince,
  type ContentAdapter,
  type FetcherOptions,
  type Outcome,
} from "@gaugeline/core";
import { readAdaptersConfig, readChangesConfig } from "./schema-config.js";
import { readRuns } from "./runs.js";

export interface ChangesIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  env?: Readonly<Record<string, string | undefined>>;
}

export interface ChangesDeps {
  fetcher?: FetcherOptions;
  cwd?: string;
}

/**
 * gaugeline changes <site> --before-after: the findings of two saved runs side by side (fixed, new, still
 * there). No request is made.
 * gaugeline changes <site>: the findings that are new since the run before (or since a date or run id),
 * with what changed on the page and what the records say changed it. Reads the local runs store, then
 * GETs the content system's edit history and the host's deployment list, only for what
 * gaugeline.changes.json names. Never writes, never guesses an author.
 */
export async function runChanges(
  args: {
    address: string;
    since?: string;
    beforeAfter?: boolean;
    json: boolean;
    quiet: boolean;
  },
  io: ChangesIo,
  deps: ChangesDeps,
): Promise<Outcome> {
  const cwd = deps.cwd ?? process.cwd();
  const host = new URL(args.address).host;
  const config = readChangesConfig(cwd) ?? {};
  const { runs, prunedBefore } = readRuns(cwd, host);
  if (args.beforeAfter) {
    // The report of two saved runs: nothing is requested, and no author or cause is looked for.
    const result = compareRuns(host, runs, args.since ? parseSince(args.since)! : undefined);
    io.stdout.write(
      args.json
        ? `${JSON.stringify({ schema: 1, ...result }, null, 2)}\n`
        : formatBeforeAfter(result),
    );
    return { kind: "ran", highFindings: 0, drift: false };
  }
  const env = io.env ?? {};
  const fetcher = createFetcher({ ...deps.fetcher });
  let adapter: ContentAdapter | undefined;
  if (config.documents && Object.keys(config.documents).length > 0) {
    const named = readAdaptersConfig(cwd);
    const adapters = await adaptersOrDefault(named, { env, fetcher, site: args.address });
    adapter = adapters.find((a) => a.revisions !== undefined) ?? adapters[0];
  }
  const report = await buildChanges({
    site: host,
    runs,
    ...(args.since ? { since: parseSince(args.since)! } : {}),
    sources: createChangeSources({ config, env, fetcher, adapter }),
    ...(config.warranty ? { warranty: config.warranty } : {}),
    ...(prunedBefore ? { prunedBefore } : {}),
  });
  io.stdout.write(
    args.json
      ? `${JSON.stringify({ schema: 1, retentionDays: config.retentionDays ?? DEFAULT_RETENTION_DAYS, ...report }, null, 2)}\n`
      : formatChanges(report),
  );
  return { kind: "ran", highFindings: 0, drift: false };
}
