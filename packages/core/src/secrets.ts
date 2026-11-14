/**
 * Shapes of secrets Gaugeline must never store or print. Shared by the cassette scrubber and
 * cassette scan (packages/testkit) and, later, the leaked-key check (G12).
 * Every pattern is global so it can be used with String.prototype.replace and matchAll.
 */
import { findLeaks } from "./checks/leaks/detectors.js";

export interface KeyPattern {
  name: string;
  pattern: RegExp;
}

export const KEY_PATTERNS: readonly KeyPattern[] = Object.freeze([
  { name: "stripe-secret", pattern: /\b(?:sk|rk)_(?:live|test)_\w{16,}/g },
  { name: "stripe-webhook", pattern: /\bwhsec_\w{16,}/g },
  { name: "sanity-token", pattern: /\bsk\w{60,}/g },
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
  {
    // A long hex or base64 run with the word key, token or secret within a few characters before it.
    name: "generic-secret",
    pattern:
      /(?:key|token|secret)["'\s:=_-]{1,12}["']?(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9+/]{32,}={0,2})(?![A-Za-z0-9+/=])/gi,
  },
]);

/** Fresh copies: a global RegExp keeps lastIndex between test() calls. */
export function keyPatterns(): KeyPattern[] {
  return KEY_PATTERNS.map((k) => ({
    name: k.name,
    pattern: new RegExp(k.pattern.source, k.pattern.flags),
  }));
}

/** The names of the patterns that match somewhere in the text. */
export function findKeys(text: string): string[] {
  return keyPatterns()
    .filter((k) => k.pattern.test(text))
    .map((k) => k.name);
}

/** Environment variables whose names say they hold a secret. */
const SECRET_NAME =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|DSN|WEBHOOK|AUTH|CONNECTION_STRING|DATABASE_URL)/i;
/** A shorter value is a word, a flag or a number, not a key: matching it would reject innocent text. */
const SECRET_MIN_LENGTH = 8;

/** Every string in a parsed value, decoded as the receiver will read it: values and object keys, at any depth. */
export function stringsOf(value: unknown): string[] {
  const out: string[] = [];
  // A list, not recursion: a body nested 100,000 deep must not overflow the stack.
  const todo: unknown[] = [value];
  while (todo.length > 0) {
    const v = todo.pop();
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) todo.push(x);
    else if (typeof v === "object" && v !== null)
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        todo.push(x);
      }
  }
  return out;
}

/**
 * What in `value` (a parsed JSON value, or a string) must never be sent to the hosted service or printed:
 * the names of the environment variables (key, token, secret, password, webhook, connection string) whose
 * value appears in any decoded string of it, then the names of the key shapes it matches (the patterns above
 * and the leak detectors' own, the ones the secret-in-js check uses). Never the values.
 *
 * It reads the decoded strings, never the JSON text: JSON writes a quote or a backslash with an escape and
 * any character as \uXXXX, so a value with one of them is not in the text as the variable holds it.
 * The generic shape is left out (it would take a long hex string next to the word "key" for a secret).
 * Pass the environment to compare with: the CLI passes its own; a server passes only what it must keep
 * out (a presented token), never its whole environment, or the scan becomes a way to guess its secrets.
 */
export function secretsInValue(
  value: unknown,
  env: Record<string, string | undefined> = {},
): string[] {
  const strings = stringsOf(value);
  // One text for the shapes and the values. NUL cannot be inside a name or a key, so no match spans two strings.
  const text = strings.join("\u0000");
  const names: string[] = [];
  for (const [name, secret] of Object.entries(env)) {
    if (secret === undefined || secret.length < SECRET_MIN_LENGTH || !SECRET_NAME.test(name))
      continue;
    if (text.includes(secret)) names.push(name);
  }
  for (const k of findKeys(text)) if (k !== "generic-secret") names.push(k);
  for (const leak of findLeaks(text)) if (!names.includes(leak.detector)) names.push(leak.detector);
  return names;
}

/** secretsInValue for one piece of text. */
export function secretsIn(text: string, env: Record<string, string | undefined>): string[] {
  return secretsInValue(text, env);
}
