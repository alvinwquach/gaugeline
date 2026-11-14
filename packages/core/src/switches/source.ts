import { ConnectorRateLimitedError, ConnectorRefusedError } from "../connectors/http.js";
import type { DatabaseQueryResult } from "../connectors/postgres/connector.js";
import type { SourcesConfig } from "../connectors/postgres/config.js";
import type { DatabasesRead } from "../connectors/postgres/read.js";
import { isConfigured } from "../connectors/env.js";
import { createRedactor } from "../connectors/redact.js";
import { SANITY_PROJECT_ID, SANITY_TOKEN, readField } from "../connectors/sanity.js";
import type { Env } from "../connectors/types.js";
import { escapeInvisible } from "../checks/hidden-text/escape.js";
import type { Fetcher } from "../fetcher.js";
import { parseSourceRef, resolveQuery, type SourceRef } from "./config.js";

/** The databases a `db:` source reads from: the sources file and the run's one shared read of it. */
export interface SwitchDatabases {
  config: SourcesConfig;
  read: () => Promise<DatabasesRead>;
}

export interface SourceDeps {
  fetcher: Fetcher;
  databases?: SwitchDatabases;
  /** Blanks every key and connection string; every reason and every value shown passes through it. */
  redact: (text: string) => string;
}

/** The longest value of a source shown in a reason. */
const SHOWN = 40;

export type Got = { ok: true; value: unknown } | { ok: false; reason: string };
export type GotQuery = { ok: true; result: DatabaseQueryResult } | { ok: false; reason: string };

export interface SourceReader {
  /** Every reason and every value shown passes through this: keys and connection strings are blanked. */
  redact: (text: string) => string;
  /** A value made safe to print in a reason. */
  shown: (value: unknown) => string;
  fromSanity: (ref: Extract<SourceRef, { kind: "sanity" }>, source: string) => Promise<Got>;
  fromQuery: (ref: Extract<SourceRef, { kind: "db" }>, source: string) => Promise<GotQuery>;
  /** One value: a Sanity field, or the one cell a query returns. Read once per source. */
  single: (source: string) => Promise<Got>;
}

/**
 * Reading the places a rule's state lives (a published Sanity field, a named query of the read-only
 * database source), once each however many rules name them. Shared by the switches and the freshness
 * rules. Nothing here throws for a source being down: it says why it could not be read.
 */
export function createSourceReader(env: Env, deps: SourceDeps): SourceReader {
  const blankToken = createRedactor(env, [SANITY_TOKEN]);
  const redact = (text: string): string => blankToken(deps.redact(text));

  const sanity = new Map<string, Promise<Got>>();
  const fromSanity: SourceReader["fromSanity"] = (ref, source) => {
    const k = `${ref.type}.${ref.fields.join(".")}`;
    let pending = sanity.get(k);
    if (!pending) {
      pending = (async (): Promise<Got> => {
        if (!isConfigured(env, [SANITY_PROJECT_ID]))
          return {
            ok: false,
            reason: `${source} could not be read: ${SANITY_PROJECT_ID} is not set. Set it to the project id from sanity.io/manage.`,
          };
        try {
          return { ok: true, value: await readField(env, deps.fetcher, ref.type, ref.fields) };
        } catch (err) {
          if (err instanceof ConnectorRefusedError)
            return {
              ok: false,
              reason: `${source} could not be read. Sanity refused the key (HTTP ${err.status}). ${err.hint ?? "Check it can read."}`,
            };
          if (err instanceof ConnectorRateLimitedError)
            return { ok: false, reason: `${source} could not be read: Sanity asked to slow down.` };
          return {
            ok: false,
            reason: `${source} could not be read. ${err instanceof Error ? err.message : "Sanity did not answer."}`,
          };
        }
      })();
      sanity.set(k, pending);
    }
    return pending;
  };

  const fromQuery: SourceReader["fromQuery"] = async (ref, source) => {
    if (!deps.databases)
      return { ok: false, reason: `${source} could not be read: no database source is set up.` };
    const found = resolveQuery(ref, deps.databases.config);
    if (!found.ok) return { ok: false, reason: `${source} could not be read: ${found.message}.` };
    const read = await deps.databases.read();
    const got = read.byName.get(found.key);
    if (!got) {
      const name = found.key.split(".")[0] ?? "";
      const why = read.notices.find(
        (n) => n.connector === `db:${name}` && n.kind !== "advice",
      )?.message;
      return {
        ok: false,
        reason: `${source} could not be read. ${why ?? "The database was not read."}`,
      };
    }
    if (got.status !== "ok")
      return { ok: false, reason: got.message ?? `${source} could not be read.` };
    return { ok: true, result: got };
  };

  const single: SourceReader["single"] = async (source) => {
    const ref = parseSourceRef(source);
    if (ref.kind === "sanity") {
      const got = await fromSanity(ref, source);
      if (got.ok && (got.value === null || got.value === undefined))
        return {
          ok: false,
          reason: `${source} is not set: Sanity has no published ${ref.type} document with ${ref.fields.join(".")} filled in.`,
        };
      return got;
    }
    const q = await fromQuery(ref, source);
    if (!q.ok) return q;
    const { rows, columns } = q.result;
    if (rows.length !== 1)
      return {
        ok: false,
        reason: `${source} returned ${rows.length === 0 ? "no rows" : `${rows.length} rows`}; it must return exactly one.`,
      };
    const column = columns.includes("value")
      ? "value"
      : columns.length === 1
        ? columns[0]
        : undefined;
    if (column === undefined)
      return {
        ok: false,
        reason: `${source} returns ${columns.length} columns; name the one that holds the state "value" (select ... as value).`,
      };
    return { ok: true, value: rows[0]?.[column] ?? null };
  };

  const shown = (value: unknown): string =>
    redact(
      escapeInvisible(typeof value === "string" ? value : (JSON.stringify(value) ?? "null"), SHOWN),
    );

  return { redact, shown, fromSanity, fromQuery, single };
}
