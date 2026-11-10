import type { Env } from "./types.js";

/** True only when every name is set to a non-empty string. The check a connector's `configured` makes. */
export function isConfigured(env: Env, names: readonly string[]): boolean {
  return names.every((n) => {
    const v = env[n];
    return typeof v === "string" && v !== "";
  });
}

/** The names that are missing or empty, in the order given. */
export function missingVars(env: Env, names: readonly string[]): string[] {
  return names.filter((n) => !isConfigured(env, [n]));
}

/**
 * A frozen copy of the named variables. The CLI calls this with its own environment, so core gets
 * the variables the connectors declared and not the whole environment, and a later change to the
 * original cannot reach a run that has started. Unset variables stay absent.
 */
export function freezeEnv(
  source: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): Env {
  const copy: Record<string, string | undefined> = {};
  for (const n of names) {
    const v = source[n];
    if (v !== undefined) copy[n] = v;
  }
  return Object.freeze(copy);
}
