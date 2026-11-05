import { createPageRegistry } from "./checks/index.js";
import type { Severity } from "./model.js";
import { RESULT_SCHEMA_VERSION } from "./result.js";

/**
 * What will not change without a major version (STABILITY.md), derived from the code. Sorted
 * arrays so a change is a one-line diff in public-surface.lock.json.
 */
export interface PublicSurface {
  /** Flag names by command ("" is the root command). */
  flags: Record<string, string[]>;
  checkIds: string[];
  /** Severity per check id: a change can turn a passing --ci run into a failing one. */
  severities: Record<string, Severity>;
  envVars: string[];
  exitCodes: number[];
  jsonSchema: number;
}

/** Environment variables the CLI reads, other than those named in the flag table. */
export const PUBLIC_ENV_VARS: readonly string[] = Object.freeze(["CI", "FORCE_COLOR", "NO_COLOR"]);

export const EXIT_CODES: readonly number[] = Object.freeze([0, 1, 2]);

/**
 * Core cannot import the CLI, so the flag table is passed in by whoever can see it
 * (scripts/check-surface.ts passes packages/cli/src/flags.ts).
 */
export function publicSurface(
  input: { flags?: Record<string, string[]>; envVars?: string[] } = {},
): PublicSurface {
  const checks = createPageRegistry().all();
  const flags: Record<string, string[]> = {};
  for (const cmd of Object.keys(input.flags ?? {}).sort())
    flags[cmd] = [...new Set(input.flags?.[cmd] ?? [])].sort();
  return {
    flags,
    checkIds: checks.map((c) => c.id).sort(),
    severities: Object.fromEntries(
      checks.map((c) => [c.id, c.severity] as const).sort(([a], [b]) => a.localeCompare(b)),
    ),
    envVars: [...new Set([...PUBLIC_ENV_VARS, ...(input.envVars ?? [])])].sort(),
    exitCodes: [...EXIT_CODES].sort((a, b) => a - b),
    jsonSchema: RESULT_SCHEMA_VERSION,
  };
}
