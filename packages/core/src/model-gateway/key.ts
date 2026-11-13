/**
 * The key, held so it cannot be printed by accident, and the scrub that removes it from anything said about a
 * call. A key lives only in the call that reads it from the environment (key.ts is not given the environment).
 */
import { inspect } from "node:util";
import { redactForTrace } from "../agent-trace.js";
import { sanitise } from "../untrusted.js";

const SHOWN = "[redacted key]";
/** A secret shorter than this is a word, not a key: scrubbing it would damage ordinary text. */
const MIN_SECRET = 8;
/** The most characters an error message keeps. */
const MAX_MESSAGE = 300;

/** A key. `reveal()` is the only way to read it; printing, JSON and inspect all show a marker. */
export class ApiKey {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return SHOWN;
  }
  toJSON(): string {
    return SHOWN;
  }
  [inspect.custom](): string {
    return SHOWN;
  }
}

/** The forms a request writes a secret in: as is, in a URL, as base64 (Basic auth) and inside a JSON string. */
function forms(secret: string): string[] {
  return [
    ...new Set([
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString("base64"),
      JSON.stringify(secret).slice(1, -1),
    ]),
  ];
}

/**
 * Text that is safe to put in an error: every secret removed in every form, key shapes and personal data
 * replaced (the same redaction the trace uses), control and hidden characters shown, and cut short.
 */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets)
    if (s.length >= MIN_SECRET) for (const f of forms(s)) out = out.split(f).join(SHOWN);
  return sanitise(redactForTrace(out), MAX_MESSAGE).text;
}
