/**
 * Shapes of secrets Gaugeline must never store or print. Shared by the cassette scrubber and
 * cassette scan (packages/testkit) and, later, the leaked-key check (G12).
 * Every pattern is global so it can be used with String.prototype.replace and matchAll.
 */
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

/**
 * What in `text` must never be sent to the hosted service or printed: the names of the environment
 * variables (key, token, secret, password, webhook, connection string) whose value appears in it, then
 * the names of the key shapes above that it matches. Never the values. The generic shape is left out
 * (it would take a long hex string next to the word "key" for a secret); the others are specific.
 */
export function secretsIn(text: string, env: Record<string, string | undefined>): string[] {
  const names: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < SECRET_MIN_LENGTH || !SECRET_NAME.test(name))
      continue;
    if (text.includes(value)) names.push(name);
  }
  for (const k of findKeys(text)) if (k !== "generic-secret") names.push(k);
  return names;
}
