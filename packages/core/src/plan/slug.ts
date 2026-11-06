import type { Finding } from "../model.js";
import { damerau } from "../text/distance.js";
import { isSpellingVariant } from "../text/variants.js";
import type { PlanRow } from "./read.js";

/**
 * A slug that misspells its own heading: each long word of the last path segment, compared with the
 * words of the same row's page name and H1, the author's own spelling of the same thing.
 */
export const MIN_WORD = 5;
/** Distance 2 is accepted only for words this long: below it, two edits are a different word. */
export const LONG_WORD = 8;

/** Lower case, accents removed ("Résumé" -> "resume"). */
function fold(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function words(s: string): string[] {
  return fold(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "");
}

const ENDINGS = ["ing", "ed", "es", "s"] as const;

/** The word, and the word without each trailing s, es, ed or ing it has. */
function forms(w: string): string[] {
  return [
    w,
    ...ENDINGS.filter((e) => w.endsWith(e) && w.length > e.length).map((e) =>
      w.slice(0, -e.length),
    ),
  ];
}

/** Plural and tense: equal once a trailing s, es, ed or ing is removed from either. */
export function sameStem(a: string, b: string): boolean {
  const fb = forms(b);
  return forms(a).some((x) => fb.includes(x));
}

/** The heading word a slug word misspells, or undefined. */
export function misspelling(slugWord: string, heading: ReadonlySet<string>): string | undefined {
  if (slugWord.length < MIN_WORD || heading.has(slugWord)) return undefined;
  const max = slugWord.length >= LONG_WORD ? 2 : 1;
  let best: { word: string; d: number } | undefined;
  for (const h of heading) {
    if (h.length < MIN_WORD) continue;
    const d = damerau(slugWord, h, max);
    if (d === 0 || d > max) continue;
    if (sameStem(slugWord, h) || isSpellingVariant(slugWord, h)) continue;
    if (!best || d < best.d || (d === best.d && h < best.word)) best = { word: h, d };
  }
  return best?.word;
}

/** One finding per row with a misspelled slug word, naming the corrected path. */
export function checkSlugs(rows: readonly PlanRow[], file = "the plan"): Finding[] {
  const out: Finding[] = [];
  for (const row of rows) {
    const segments = row.path.split("/");
    const last = segments.at(-1) === "" ? (segments.at(-2) ?? "") : (segments.at(-1) ?? "");
    if (last === "") continue;
    const heading = new Set(
      [...words(row.page ?? ""), ...words(row.h1 ?? "")].filter((w) => w.length >= MIN_WORD),
    );
    if (heading.size === 0) continue;
    const parts = fold(last).split("-");
    const fixes: { from: string; to: string }[] = [];
    const corrected = parts.map((p) => {
      const to = misspelling(p, heading);
      if (!to) return p;
      fixes.push({ from: p, to });
      return to;
    });
    if (fixes.length === 0) continue;
    const prefix = segments.slice(0, segments.at(-1) === "" ? -2 : -1).join("/");
    out.push({
      checkId: "plan-slug-misspelling",
      severity: "medium",
      title: "A slug misspells its own heading",
      evidence: `line ${row.line}: ${fixes.map((f) => `"${f.from}" in ${row.path}, the heading says "${f.to}"`).join("; ")}; did you mean ${prefix}/${corrected.join("-")}`,
      url: file,
    });
  }
  return out;
}
