/**
 * A seeded shuffle, so a sample of a large site is the same sample when a failure is replayed.
 * Integers throughout: a 32-bit generator (mulberry32), a rejection-sampled `below` so no position
 * is favoured by a modulo, and a Fisher-Yates pass over a copy.
 */

/** A seed as a 32-bit unsigned integer: FNV-1a over the seed's text, so 7 and "7" are one seed. */
export function seedToUint32(seed: string | number): number {
  let hash = 0x811c9dc5;
  for (const ch of String(seed)) {
    for (let byte = ch.codePointAt(0) ?? 0; ; byte >>>= 8) {
      hash = Math.imul(hash ^ (byte & 0xff), 0x01000193) >>> 0;
      if (byte <= 0xff) break;
    }
  }
  return hash;
}

/** mulberry32: a small generator of 32-bit unsigned integers from a 32-bit seed. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** A whole number in [0, bound), without modulo bias: values past the last whole multiple are redrawn. */
function below(next: () => number, bound: number): number {
  const limit = 0x100000000 - (0x100000000 % bound);
  let x = next();
  while (x >= limit) x = next();
  return x % bound;
}

/** The list in an order fixed by the seed. The input is not changed. */
export function shuffleSeeded<T>(items: readonly T[], seed: string | number): T[] {
  const out = [...items];
  const next = generator(seedToUint32(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = below(next, i + 1);
    const held = out[i] as T;
    out[i] = out[j] as T;
    out[j] = held;
  }
  return out;
}

/** Throws unless `n` is a whole number of at least 1. */
export function assertSampleSize(n: number): void {
  if (!Number.isSafeInteger(n) || n < 1)
    throw new RangeError(`The sample size must be a whole number of at least 1, not ${String(n)}.`);
}

/** The first `n` items of the seeded shuffle: all of them when `n` is larger than the list. */
export function sampleSeeded<T>(items: readonly T[], n: number, seed: string | number): T[] {
  assertSampleSize(n);
  return shuffleSeeded(items, seed).slice(0, n);
}
