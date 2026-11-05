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
