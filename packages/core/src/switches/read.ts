import { readField } from "../connectors/sanity.js";
import type { Env } from "../connectors/types.js";
import { parseSourceRef, ruleName, scopePaths, type SwitchesConfig } from "./config.js";
import { createSourceReader, type SourceDeps, type SwitchDatabases } from "./source.js";
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

export type { SwitchDatabases };

/** What the switches reader needs: the run's fetcher, its databases and the redactor. */
export type SwitchesDeps = SourceDeps;

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
  const { redact, shown, fromSanity, fromQuery, single } = createSourceReader(env, deps);

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
