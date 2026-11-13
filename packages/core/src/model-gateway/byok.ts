/**
 * Bring your own key (AG-20, ADR-0005 as amended on 13 Nov 2026, modes 1 and 2). The key is the person's: it
 * stays in the person's own environment and is read when a call is made. Mode 1 is the command line, in the
 * person's own process. Mode 2 is the hosted tier, where the call runs in the customer's own worker with the
 * customer's own key, never in Gaugeline's service. Gaugeline stores no key, so there is nothing to metering or
 * a vault here: mode 3 is parked with billing and refused by name. Nothing in this file sends a request.
 */
import { secretsInValue, stringsOf } from "../secrets.js";
import { parseGatewayConfig } from "./config.js";
import { createGateway } from "./gateway.js";
import { isUsableKey } from "./key.js";
import { RECORDED_PROVIDER } from "./recorded.js";
import type { GatewayConfig, GatewayConfigInput, GatewayOptions, ModelGateway } from "./types.js";

/** The one file a person keeps their model settings in. It holds a variable's name, never a key. */
export const LLM_CONFIG_FILE = "gaugeline.llm.json";
export const MAX_LLM_CONFIG_CHARS = 20_000;
/** Mode 1 (cli) and mode 2 (worker). There is no mode 3. */
export const BYOK_MODES = ["cli", "worker"] as const;
export type ByokMode = (typeof BYOK_MODES)[number];

export class ByokError extends Error {
  readonly code: "mode-not-supported" | "bad-config";
  constructor(code: ByokError["code"], message: string) {
    super(message);
    this.name = "ByokError";
    this.code = code;
  }
}

/**
 * The gateway config in `text` (JSON). Refused: a file over 20000 characters, text that is not JSON, anything
 * that looks like a key, and anything the config shape refuses. An error names where the problem is and never
 * repeats what was written there.
 */
export function readByokConfig(
  text: string,
  env: Readonly<Record<string, string | undefined>> = {},
): GatewayConfig {
  if (text.length > MAX_LLM_CONFIG_CHARS)
    throw new ByokError(
      "bad-config",
      `${LLM_CONFIG_FILE} is over ${MAX_LLM_CONFIG_CHARS} characters.`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ByokError("bad-config", `${LLM_CONFIG_FILE} is not valid JSON.`);
  }
  // The value of the variable the file names is a key whatever its shape: it may be in no field of the file.
  const named =
    raw !== null && typeof raw === "object" ? (raw as { keyEnv?: unknown }).keyEnv : undefined;
  const own = typeof named === "string" ? env[named] : undefined;
  const ownKey = own !== undefined && own.length >= 8 ? own : undefined;
  if (
    secretsInValue(raw).length > 0 ||
    (ownKey !== undefined && stringsOf(raw).some((s) => s.includes(ownKey)))
  )
    throw new ByokError(
      "bad-config",
      `${LLM_CONFIG_FILE} holds something that looks like a key. Put the key in your environment and name the variable in keyEnv.`,
    );
  const parsed = parseGatewayConfig(raw);
  if (!parsed.ok)
    throw new ByokError("bad-config", `${LLM_CONFIG_FILE}: ${parsed.problems.join("; ")}`);
  return parsed.config;
}

export interface ByokStatus {
  mode: ByokMode;
  provider: string;
  tiers: GatewayConfig["tiers"];
  /** The variable's name, or null when the provider needs none or the config names none. */
  keyEnv: string | null;
  /** Whether that variable holds something that can be a key. null when no key is needed. Never the value. */
  keySet: boolean | null;
}

/** What is set up, from the config and the environment handed in. Reads only the one variable the config names. */
export function describeByok(
  config: GatewayConfig,
  env: Readonly<Record<string, string | undefined>>,
  mode: ByokMode,
): ByokStatus {
  const keyEnv = config.keyEnv ?? null;
  // A last line of defence: a config string that holds the key is never put in the status.
  const own = keyEnv === null ? undefined : env[keyEnv];
  const shown = (v: string) =>
    own !== undefined && own.length >= 8 && v.includes(own) ? "[redacted key]" : v;
  const needsKey = config.provider !== RECORDED_PROVIDER;
  return {
    mode,
    provider: shown(config.provider),
    tiers: Object.fromEntries(Object.entries(config.tiers).map(([t, m]) => [t, shown(m)])),
    keyEnv: keyEnv === null ? null : shown(keyEnv),
    keySet: !needsKey ? null : keyEnv === null ? false : isUsableKey(own),
  };
}

/** The status as plain lines. It says what is set, where the call runs and what Gaugeline keeps; never a key. */
export function renderByokStatus(s: ByokStatus): string {
  const where =
    s.mode === "cli"
      ? "this command line, in your own process, with your own key"
      : "your own worker, with your own key, and never in Gaugeline's service";
  const key =
    s.keySet === null
      ? "key: this provider needs no key"
      : s.keyEnv === null
        ? "key: the config names no key variable (keyEnv)"
        : s.keySet
          ? `key: ${s.keyEnv} is set (its value is never shown)`
          : `key: ${s.keyEnv} is not set, or does not hold a usable key`;
  return [
    `Model setup (mode ${s.mode === "cli" ? 1 : 2})`,
    `provider: ${s.provider}`,
    ...Object.entries(s.tiers).map(([tier, model]) => `${tier}: ${model}`),
    key,
    `The call runs in: ${where}.`,
    "Gaugeline keeps no key: it reads yours from your environment when a call is made, and prints or logs none.",
    "This sent nothing.",
  ].join("\n");
}

/** The gateway for mode 1 or 2. Any other mode (a managed key, a vault, metering) is parked and refused. */
export function createByokGateway(
  options: GatewayOptions & { mode: ByokMode; config: GatewayConfigInput },
): ModelGateway {
  const { mode, ...rest } = options;
  if (!(BYOK_MODES as readonly string[]).includes(mode))
    throw new ByokError(
      "mode-not-supported",
      "Only your own key is supported (mode 1, the command line, and mode 2, your own worker). A key Gaugeline holds (mode 3) is parked.",
    );
  return createGateway(rest);
}
