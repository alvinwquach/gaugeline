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
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

const modelId = z.string({ error: "must be a model id" }).regex(MODEL_ID, "must be a model id");

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
      .regex(PROVIDER, "must be a provider name"),
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

/** A setting's name, shown only when it is shaped like one; a pasted key used as a name is not shown. */
const shownName = (k: string) =>
  /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(k) && redactForTrace(k) === k ? k : "a setting";

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
      return issue.keys.map((k) => {
        const name = shownName(k);
        const at = where === "" ? "" : `${where}.`;
        const hint = /host|url|endpoint|proxy|private|address/i.test(name)
          ? "where a provider is reached is kept in code, never in a file"
          : "name the environment variable in keyEnv, never the key itself";
        return `${at}${name}: is not a setting; ${hint}`;
      });
    return [`${where === "" ? "the config" : where}: ${issue.message}`];
  });
  return { ok: false, problems };
}
