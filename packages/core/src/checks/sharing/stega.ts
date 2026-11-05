/** Zero-width characters used to hide data in text (Sanity's stega encoding among them). */
const ZERO_WIDTH = new Set([
  0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff,
]);

/** A run this long is data, not the odd joiner inside an emoji. */
export const STEGA_ZERO_WIDTH_RUN = 4;

/**
 * Hidden characters in a string: any Unicode tag character (U+E0000 to U+E007F), or a run of at
 * least STEGA_ZERO_WIDTH_RUN zero-width characters. Iterates code points with for...of, so the
 * tag characters (outside the Basic Multilingual Plane, as surrogate pairs) are read whole.
 */
export function findStega(text: string): { tags: number; longestRun: number } | undefined {
  let tags = 0;
  let run = 0;
  let longestRun = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xe0000 && cp <= 0xe007f) tags++;
    if (ZERO_WIDTH.has(cp)) {
      run++;
      longestRun = Math.max(longestRun, run);
    } else run = 0;
  }
  return tags > 0 || longestRun >= STEGA_ZERO_WIDTH_RUN ? { tags, longestRun } : undefined;
}

/** Every string inside parsed JSON, explicit stack (see collectUrls). */
export function jsonStrings(json: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [json];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") out.push(v);
    else if (v !== null && typeof v === "object" && !seen.has(v)) {
      seen.add(v);
      for (const c of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>))
        stack.push(c);
    }
  }
  return out;
}
