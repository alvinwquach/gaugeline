import { classifyStatement } from "../connectors/postgres/classify.js";
import {
  connectionVar,
  keyVar,
  sourceEnvVars,
  type SourceConfig,
  type SourcesConfig,
} from "../connectors/postgres/config.js";
import type { DatabaseQueryResult } from "../connectors/postgres/connector.js";
import { readDatabases } from "../connectors/postgres/read.js";
import { parseConnectionString, redactorFor } from "../connectors/postgres/url.js";
import { createRedactor } from "../connectors/redact.js";
import type { ConnectorNotice, Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { EVIDENCE_ROWS, cellText } from "./evidence.js";
import { assertionsOf, type Placed } from "./select.js";
import type { AssertionResult } from "./types.js";

/** What the run was told about assertions: the config and the variables it names, already copied. */
export interface AssertionsSettings {
  config: SourcesConfig;
  env: Env;
  /** Called once with the finished read, for the CLI to look at (it decides the exit code). */
  onAssertions?: (read: AssertionsRead) => void;
}

export interface AssertionsRead {
  /** One entry per assertion read, in the order of the file. */
  results: AssertionResult[];
  /** Sources that gave nothing, rows cut at the cap, roles with more power than needed. */
  notices: ConnectorNotice[];
}

const base = (p: Placed): Omit<AssertionResult, "status" | "message"> => ({
  id: p.assertion.id,
  title: p.assertion.title,
  severity: p.assertion.severity,
  source: p.source,
  count: 0,
  atLeast: false,
  columns: [],
  rows: [],
});

/**
 * Blanks every value that must never leave: the variables' values as written, and for each source
 * its connection string's password (as written and as decoded) and key. Cells, notices and
 * messages all pass through it.
 */
export function sourcesRedactor(config: SourcesConfig, env: Env): (text: string) => string {
  const steps = [createRedactor(env, sourceEnvVars(config))];
  for (const source of Object.values(config.sources)) {
    const raw = env[connectionVar(source)] ?? "";
    const name = keyVar(source);
    const parsed = parseConnectionString(raw, {});
    if (parsed.ok) steps.push(redactorFor(raw, parsed.value, name ? env[name] : undefined));
  }
  return (text) => steps.reduce((acc, step) => step(acc), text);
}

/** The connector speaks of "the query a3"; the person wrote an assertion with an id. */
function renamed(message: string, queryName: string, id: string): string {
  return message.replace(`The query "${queryName}"`, `The assertion "${id}"`);
}

/**
 * Run the configured assertions (all, or the ids in `only`) through the database connector, one
 * read per source, so every assertion meets the three read-only layers a named query meets: the
 * classifier first (an assertion that is not a pure read is a config error and is never sent), then
 * a read-only transaction with a timeout and a row cap, then the role.
 *
 * Only the allow-listed evidence columns of the first 20 rows are kept; every other column of the
 * result is dropped here. Nothing in it is a pass unless the query ran and returned no rows.
 */
export async function readAssertions(
  settings: AssertionsSettings,
  fetcher: Fetcher,
  options: { only?: readonly string[]; debug?: (line: string) => void } = {},
): Promise<AssertionsRead> {
  const { config, env } = settings;
  const placed = assertionsOf(config, options.only);
  const redact = sourcesRedactor(config, env);
  const results: Array<AssertionResult | undefined> = placed.map(() => undefined);

  // Layer 1 again, even though the schema ran it: this function is reachable with a config that was
  // built by hand, and a refusal here costs nothing.
  const queries = new Map<string, Record<string, string>>();
  placed.forEach((p, index) => {
    const source = config.sources[p.source] as SourceConfig;
    const verdict = classifyStatement(p.assertion.sql, {
      ...(source.denyFunctions ? { denyFunctions: source.denyFunctions } : {}),
    });
    if (!verdict.ok) {
      results[index] = {
        ...base(p),
        status: "config-error",
        message: `assertion "${p.assertion.id}" is not a read and was not run. ${verdict.message}`,
      };
      return;
    }
    const queryName = `a${index}`;
    queries.set(p.source, { ...queries.get(p.source), [queryName]: p.assertion.sql });
  });

  const notices: ConnectorNotice[] = [];
  let byName = new Map<string, DatabaseQueryResult>();
  if (queries.size > 0) {
    // One derived source per real source: the same connection, limits and deny list, and only the
    // assertions' SQL as its queries (the owner's named queries are not run here).
    const derived: SourcesConfig = {
      sources: Object.fromEntries(
        [...queries].map(([name, q]) => [
          name,
          { ...(config.sources[name] as SourceConfig), queries: q },
        ]),
      ),
    };
    const read = await readDatabases({ config: derived, env }, fetcher, {
      ...(options.debug ? { debug: options.debug } : {}),
    });
    byName = read.byName;
    notices.push(...read.notices);
  }

  placed.forEach((p, index) => {
    if (results[index]) return;
    const id = p.assertion.id;
    const queryName = `a${index}`;
    const got = byName.get(`${p.source}.${queryName}`);
    if (!got) {
      // The source gave nothing at all: say what the connector said about it.
      const why = notices.find(
        (n) => n.connector === `db:${p.source}` && n.kind !== "advice",
      )?.message;
      results[index] = {
        ...base(p),
        status: "could-not-check",
        message: `The assertion "${id}" could not be checked. ${why ?? "The database was not read."}`,
      };
      return;
    }
    if (got.status !== "ok") {
      results[index] = {
        ...base(p),
        status: "could-not-check",
        message: renamed(got.message ?? "It could not be checked.", queryName, id),
      };
      return;
    }
    if (got.rows.length === 0) {
      results[index] = { ...base(p), status: "passed" };
      return;
    }
    const missing = p.assertion.evidence.filter((c) => !got.columns.includes(c));
    if (missing.length > 0) {
      results[index] = {
        ...base(p),
        status: "config-error",
        message: `assertion "${id}" lists the evidence column ${missing.map((c) => `"${c}"`).join(", ")}, which its query does not return (it returns ${got.columns.length > 0 ? got.columns.join(", ") : "no columns"}). Name the column with "as" in the query, or fix the evidence list.`,
      };
      return;
    }
    results[index] = {
      ...base(p),
      status: "failed",
      count: got.rows.length,
      atLeast: got.truncated,
      columns: [...p.assertion.evidence],
      rows: got.rows
        .slice(0, EVIDENCE_ROWS)
        .map((row) =>
          Object.fromEntries(
            p.assertion.evidence.map((c) => [c, cellText(row[c] ?? null, redact)]),
          ),
        ),
    };
  });

  const out: AssertionsRead = {
    results: results.filter((r): r is AssertionResult => r !== undefined),
    notices: notices.map((n) => ({ ...n, message: redact(n.message) })),
  };
  return out;
}

/** The read, done once on first use and shared by every check in the run. */
export function lazyAssertions(
  settings: AssertionsSettings,
  fetcher: Fetcher,
  options: { debug?: (line: string) => void } = {},
): () => Promise<AssertionsRead> {
  let pending: Promise<AssertionsRead> | undefined;
  return () =>
    (pending ??= readAssertions(settings, fetcher, options).then((read) => {
      settings.onAssertions?.(read);
      return read;
    }));
}
