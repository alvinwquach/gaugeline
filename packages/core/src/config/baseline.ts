import { ConfigError } from "../errors.js";
import { fingerprint } from "../fingerprint.js";
import type { Finding } from "../model.js";

/** The schema this version writes. */
export const FINDINGS_BASELINE_SCHEMA = 1;

export interface FindingsBaselineEntry {
  /** From core's one fingerprint function: check, path without host, evidence without numbers. */
  fingerprint: string;
  checkId: string;
  /** Path only (no host, no query, never evidence): so the file says where without saying what. */
  path: string;
}

export interface FindingsBaseline {
  schema: number;
  /** The day it was written, for the reader of the file. */
  at?: string;
  findings: FindingsBaselineEntry[];
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return "";
  }
}

/** What `--baseline` writes: sorted and de-duplicated, so the same findings give the same file. */
export function buildFindingsBaseline(findings: readonly Finding[], now: Date): FindingsBaseline {
  const byPrint = new Map<string, FindingsBaselineEntry>();
  for (const f of findings) {
    const fp = fingerprint(f);
    if (!byPrint.has(fp))
      byPrint.set(fp, { fingerprint: fp, checkId: f.checkId, path: pathOf(f.url) });
  }
  const entries = [...byPrint.values()].sort(
    (a, b) =>
      a.checkId.localeCompare(b.checkId) ||
      a.path.localeCompare(b.path) ||
      a.fingerprint.localeCompare(b.fingerprint),
  );
  return {
    schema: FINDINGS_BASELINE_SCHEMA,
    at: now.toISOString().slice(0, 10),
    findings: entries,
  };
}

/** One step from a schema to the next. None exist yet: schema 1 is the first. */
export type FindingsBaselineMigration = (old: FindingsBaseline) => FindingsBaseline;
const MIGRATIONS: Readonly<Record<number, FindingsBaselineMigration>> = Object.freeze({});

export interface ParseFindingsBaselineOptions {
  /** The schema this reader understands (tests give a later one). */
  current?: number;
  migrations?: Readonly<Record<number, FindingsBaselineMigration>>;
}

const HEX16 = /^[0-9a-f]{16}$/;

/**
 * Read a baseline: validated by hand (the file is small and the message names the key). An older
 * schema is migrated step by step; a newer one, or an old one with no step, is refused in a sentence.
 */
export function parseFindingsBaseline(
  json: unknown,
  source: string,
  opts: ParseFindingsBaselineOptions = {},
): FindingsBaseline {
  const current = opts.current ?? FINDINGS_BASELINE_SCHEMA;
  const migrations = opts.migrations ?? MIGRATIONS;
  const fail = (where: string, what: string): never => {
    throw new ConfigError(`${source}: ${where}: ${what}.`, {
      hint: `Write a fresh baseline with --baseline ${source} --update-baseline.`,
    });
  };
  if (json === null || typeof json !== "object" || Array.isArray(json))
    return fail("the file", "must be a baseline written by --baseline");
  const o = json as { schema?: unknown; at?: unknown; findings?: unknown };
  if (typeof o.schema !== "number" || !Number.isInteger(o.schema) || o.schema < 1)
    return fail("schema", "must be a whole number from 1");
  if (o.schema > current)
    throw new ConfigError(
      `${source} was written with baseline schema ${o.schema}, newer than this version reads (schema ${current}).`,
      {
        hint: `Update Gaugeline, or write a fresh baseline with --baseline ${source} --update-baseline.`,
      },
    );
  if (!Array.isArray(o.findings)) return fail("findings", "must be a list");
  const findings = o.findings.map((e, i): FindingsBaselineEntry => {
    const x = (e ?? {}) as Record<string, unknown>;
    if (typeof x.fingerprint !== "string" || !HEX16.test(x.fingerprint))
      return fail(`findings.${i}.fingerprint`, "must be 16 hex characters");
    if (typeof x.checkId !== "string" || x.checkId === "")
      return fail(`findings.${i}.checkId`, "must be a check id");
    if (typeof x.path !== "string") return fail(`findings.${i}.path`, "must be a path");
    return { fingerprint: x.fingerprint, checkId: x.checkId, path: x.path };
  });
  let baseline: FindingsBaseline = {
    schema: o.schema,
    ...(typeof o.at === "string" ? { at: o.at } : {}),
    findings,
  };
  while (baseline.schema < current) {
    const step = migrations[baseline.schema];
    if (!step)
      throw new ConfigError(
        `${source} was written with baseline schema ${baseline.schema} and cannot be read by schema ${current}: there is no migration.`,
        { hint: `Write a fresh baseline with --baseline ${source} --update-baseline.` },
      );
    baseline = step(baseline);
  }
  return baseline;
}

/** Split findings by one Set lookup each: already in the baseline, or new. */
export function diffFindingsBaseline(
  findings: readonly Finding[],
  baseline: FindingsBaseline,
): { fresh: Finding[]; known: Finding[] } {
  const seen = new Set(baseline.findings.map((e) => e.fingerprint));
  const fresh: Finding[] = [];
  const known: Finding[] = [];
  for (const f of findings) (seen.has(fingerprint(f)) ? known : fresh).push(f);
  return { fresh, known };
}
