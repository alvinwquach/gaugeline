/**
 * The model config (AG-19): a provider, a model id per tier, the NAME of the variable that holds the key, and
 * limits. Strict, like the main config: a setting this file does not know is refused, so a file can never carry
 * a key, a host, an address or a switch for the fetcher's guard. An error names where the problem is and never
 * repeats what was written there (a person may have pasted a key into the wrong place).
 */
import * as z from "zod";
import { redactForTrace } from "../agent-trace.js";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
  MAX_PROMPT_CHARS,
  MODEL_TIERS,
  type GatewayConfig,
} from "./types.js";

const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
/** An environment variable's name: capitals, digits and underscores. A key is never one of these (checked below). */
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
/** A model id is printed back, so its shape is strict: lower case, digits, dots, colons and dashes, up to 64. */
const MODEL_ID = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
/**
 * No real provider or model name has twenty letters and digits in a row; a key does. A value with such a run is
 * refused, whatever its shape, so a key pasted into a field that is printed back is never accepted.
 */
const LONG_RUN = /[A-Za-z0-9]{20,}/;
const noRun = (v: string) => !LONG_RUN.test(v);

const modelId = z
  .string({ error: "must be a model id" })
  .regex(
    MODEL_ID,
    "must be a model id: lower case letters, digits, dots, colons and dashes, up to 64",
  )
  .refine(noRun, "must be a model id, never a key");

const tiers = z
  .object(Object.fromEntries(MODEL_TIERS.map((t) => [t, modelId.optional()])), {
    error: "must be an object of tier to model id",
  })
  .strict()
  .refine(
    (t) => Object.values(t).some((v) => v !== undefined),
    "must name a model for at least one tier",
  );

export const gatewayConfigSchema = z
  .object({
    provider: z
      .string({ error: "must be a provider name" })
      .regex(PROVIDER, "must be a provider name")
      .refine(noRun, "must be a provider name, never a key"),
    keyEnv: z
      .string({ error: "must be the name of an environment variable" })
      .regex(
        ENV_NAME,
        "must be the name of an environment variable, in capitals, never the key itself",
      )
      // A key in capitals and digits fits the pattern above; the redaction rules know the shapes of real ones.
      .refine(
        (v) => redactForTrace(v) === v,
        "must be the name of an environment variable, never the key itself",
      )
      .optional(),
    tiers,
    timeoutMs: z
      .number({ error: "must be a whole number of milliseconds" })
      .int("must be a whole number of milliseconds")
      .min(100, "must be 100 to 120000 milliseconds")
      .max(120_000, "must be 100 to 120000 milliseconds")
      .default(DEFAULT_TIMEOUT_MS),
    maxInputChars: z
      .number({ error: "must be a whole number of characters" })
      .int("must be a whole number of characters")
      .min(1, `must be 1 to ${MAX_PROMPT_CHARS}`)
      .max(MAX_PROMPT_CHARS, `must be 1 to ${MAX_PROMPT_CHARS}`)
      .default(MAX_PROMPT_CHARS),
    maxOutputTokens: z
      .number({ error: "must be a whole number of tokens" })
      .int("must be a whole number of tokens")
      .min(1, "must be 1 to 8192")
      .max(8_192, "must be 1 to 8192")
      .default(DEFAULT_MAX_OUTPUT_TOKENS),
  })
  .strict();

export type GatewayConfigResult =
  { ok: true; config: GatewayConfig } | { ok: false; problems: string[] };

/** The settings this file has. */
const SETTINGS = ["provider", "keyEnv", "tiers", "timeoutMs", "maxInputChars", "maxOutputTokens"];
/** Mistakes people make, shown by name: a key, a host, a mode. */
const KNOWN_MISTAKES: ReadonlySet<string> = new Set(
  [
    "apiKey",
    "api_key",
    "key",
    "token",
    "secret",
    "password",
    "authorization",
    "bearer",
    "host",
    "baseUrl",
    "url",
    "endpoint",
    "proxy",
    "allowPrivate",
    "mode",
    "managed",
    "vault",
    "metered",
    "metering",
  ].map((n) => n.toLowerCase()),
);

/** The edit distance between two short words (insert, delete, change one letter). */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        row[j]! + 1,
        next[j - 1]! + 1,
        row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return row[b.length]!;
}

/**
 * Whether an unknown setting's name may be shown: only a mistake this page recognises, or a near miss (two edits)
 * of a real setting. Any other name is never printed: a person may have pasted a key as a name, and a key
 * can look like anything.
 */
const mayShow = (k: string): boolean =>
  k.length <= 24 &&
  /^[A-Za-z][A-Za-z0-9_]*$/.test(k) &&
  (KNOWN_MISTAKES.has(k.toLowerCase()) ||
    SETTINGS.some((s) => distance(k.toLowerCase(), s.toLowerCase()) <= 2));

/** The config if `raw` is one, or the problems, one per line, each with where it is. */
export function parseGatewayConfig(raw: unknown): GatewayConfigResult {
  const r = gatewayConfigSchema.safeParse(raw);
  if (r.success) {
    const { keyEnv, ...rest } = r.data;
    return { ok: true, config: { ...rest, ...(keyEnv === undefined ? {} : { keyEnv }) } };
  }
  const problems = r.error.issues.flatMap((issue) => {
    const where = issue.path.map(String).join(".");
    if (issue.code === "unrecognized_keys")
      return issue.keys.map((k, i) => {
        const at = where === "" ? "" : `${where}.`;
        const hint =
          /host|url|endpoint|proxy|private|address/i.test(k) && mayShow(k)
            ? "where a provider is reached is kept in code, never in a file"
            : "name the environment variable in keyEnv, never the key itself";
        return mayShow(k)
          ? `${at}"${k}": is not a setting; ${hint}`
          : `${where === "" ? "" : `${where}: `}setting ${i + 1} is not one this file knows; ${hint}`;
      });
    return [`${where === "" ? "the config" : where}: ${issue.message}`];
  });
  return { ok: false, problems };
}
