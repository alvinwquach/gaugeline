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
import {
  parseSourceRef,
  resolveQuery,
  ruleName,
  scopePaths,
  type SourceRef,
  type SwitchesConfig,
} from "./config.js";
import type {
  AvailabilityResult,
  CapacityResult,
  ItemName,
  SwitchResult,
  SwitchesRead,
} from "./types.js";
import { capacityValue, switchValue } from "./values.js";

/** What the run was told about switches: the file, and the Sanity variables it may read, already copied. */
export interface SwitchesSettings {
  config: SwitchesConfig;
  env: Env;
}

/** The databases a `db:` source reads from: the sources file and the run's one shared read of it. */
export interface SwitchDatabases {
  config: SourcesConfig;
  read: () => Promise<DatabasesRead>;
}

export interface SwitchesDeps {
  fetcher: Fetcher;
  databases?: SwitchDatabases;
  /** Blanks every key and connection string; every reason and every value shown passes through it. */
  redact: (text: string) => string;
}

/** The longest value of a source shown in a reason. */
const SHOWN = 40;

type Got = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Read each rule's source once and turn it into a state. Nothing here throws for a source being
 * down: a source that cannot be read, or that gives something that is not a state, makes its rules
 * "unknown", and a check lists that as could not check. It is never a pass and never a finding.
 */
export async function readSwitches(
  settings: SwitchesSettings,
  deps: SwitchesDeps,
): Promise<SwitchesRead> {
  const { config, env } = settings;
  const blankToken = createRedactor(env, [SANITY_TOKEN]);
  const redact = (text: string): string => blankToken(deps.redact(text));

  const sanity = new Map<string, Promise<Got>>();
  const fromSanity = (
    ref: Extract<SourceRef, { kind: "sanity" }>,
    source: string,
  ): Promise<Got> => {
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

  const fromQuery = async (
    ref: Extract<SourceRef, { kind: "db" }>,
    source: string,
  ): Promise<{ ok: true; result: DatabaseQueryResult } | { ok: false; reason: string }> => {
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

  /** One value: a Sanity field, or the one cell a query returns. */
  const single = async (source: string): Promise<Got> => {
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

  const switches: SwitchResult[] = [];
  for (const rule of config.switches ?? []) {
    const base = { id: rule.id, source: rule.source, rule };
    const got = await single(rule.source);
    if (!got.ok) {
      switches.push({ ...base, state: "unknown", reason: redact(got.reason) });
      continue;
    }
    const state = switchValue(got.value);
    switches.push(
      state
        ? { ...base, state }
        : {
            ...base,
            state: "unknown",
            reason: `${rule.source} gave "${shown(got.value)}", which is not an on or off value. Use true or false, on or off, yes or no, open or closed, or 1 or 0.`,
          },
    );
  }

  const capacity: CapacityResult[] = [];
  for (const rule of config.capacity ?? []) {
    const base = { id: ruleName(rule), source: rule.source, rule };
    const got = await single(rule.source);
    if (!got.ok) {
      capacity.push({ ...base, state: "unknown", reason: redact(got.reason) });
      continue;
    }
    const remaining = capacityValue(got.value);
    capacity.push(
      remaining === undefined
        ? {
            ...base,
            state: "unknown",
            reason: `${rule.source} gave "${shown(got.value)}", which is not a whole number of places left.`,
          }
        : { ...base, state: "known", remaining },
    );
  }

  const availability: AvailabilityResult[] = [];
  for (const rule of config.availability ?? []) {
    const base = { id: ruleName(rule), source: rule.source, rule };
    const unknown = (reason: string): AvailabilityResult => ({
      ...base,
      state: "unknown",
      reason: redact(reason),
    });
    const names = (raw: unknown[]): ItemName[] =>
      [...new Set(raw.filter((n): n is string => typeof n === "string" && n.trim() !== ""))].map(
        (name) => ({ name, shown: shown(name) }),
      );
    const ref = parseSourceRef(rule.source);
    if (ref.kind === "sanity") {
      const got = await fromSanity(ref, rule.source);
      if (!got.ok) {
        availability.push(unknown(got.reason));
        continue;
      }
      let value = got.value;
      if (value === null || value === undefined) {
        // Sanity leaves an empty list out of the document. If the document is there, nothing is unavailable.
        const there = await readField(env, deps.fetcher, ref.type, ["_id"]).catch(() => undefined);
        if (typeof there !== "string") {
          availability.push(
            unknown(
              `${rule.source} is not set: Sanity has no published ${ref.type} document to read the list from.`,
            ),
          );
          continue;
        }
        value = [];
      }
      if (!Array.isArray(value)) {
        availability.push(unknown(`${rule.source} is not a list of names.`));
        continue;
      }
      availability.push({ ...base, state: "known", items: names(value) });
      continue;
    }
    const q = await fromQuery(ref, rule.source);
    if (!q.ok) {
      availability.push(unknown(q.reason));
      continue;
    }
    const column = rule.items ?? "";
    if (!q.result.columns.includes(column) && q.result.rows.length > 0) {
      availability.push(
        unknown(
          `${rule.source} does not return the column "${column}" (it returns ${q.result.columns.join(", ")}).`,
        ),
      );
      continue;
    }
    availability.push({
      ...base,
      state: "known",
      items: names(q.result.rows.map((r) => r[column] ?? null)),
    });
  }

  return { switches, availability, capacity, paths: scopePaths(config) };
}

/** The read, done once on first use and shared by every check of the run. */
export function lazySwitches(
  settings: SwitchesSettings,
  deps: SwitchesDeps,
): () => Promise<SwitchesRead> {
  let pending: Promise<SwitchesRead> | undefined;
  return () => (pending ??= readSwitches(settings, deps));
}
