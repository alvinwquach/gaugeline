/**
 * The model config (AG-19): a provider, a model id per tier, the NAME of the variable that holds the key, and
 * limits. Strict, like the main config: a setting this file does not know is refused, so a file can never carry
 * a key, a host, an address or a switch for the fetcher's guard. An error names where the problem is and never
 * repeats what was written there (a person may have pasted a key into the wrong place).
 */
import * as z from "zod";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
  MAX_PROMPT_CHARS,
  MODEL_TIERS,
  type GatewayConfig,
} from "./types.js";

import { KNOWN_KEY_ENVS, isKnownKeyEnv, isNameShaped, mayShowSetting } from "./known.js";

const KNOWN_KEY_ENV_LIST = KNOWN_KEY_ENVS.join(", ");

const modelId = z
  .string({ error: "must be a model id" })
  .refine(
    isNameShaped,
    "must be a model id: words and short version numbers in lower case, joined by dashes, dots or colons (a key is never one)",
  );

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
      .refine(isNameShaped, "must be a provider name: lower case words, joined by dashes"),
    keyEnv: z
      .string({ error: "must be the name of an environment variable" })
      .refine(
        isKnownKeyEnv,
        `must be a variable a model key is kept in (${KNOWN_KEY_ENV_LIST}); add yours to the known list in the code, never the key itself`,
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
const mayShow = (k: string): boolean => mayShowSetting(k, SETTINGS);

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
