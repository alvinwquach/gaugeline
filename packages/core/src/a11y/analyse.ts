import type { Focusable, Landmark, MotionRead, Rgba, TextSample } from "./types.js";

/**
 * The accessibility rules (N16), as plain functions over what the browser computed. WCAG 2 formulas, whole numbers
 * where a person reads them: the same input always gives the same answer.
 */

const linear = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (r: number, g: number, b: number): number =>
  0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/** WCAG 2 contrast of a text colour over an opaque background; a translucent text colour is laid over it first. */
export function contrastRatio(fg: Rgba, bg: readonly [number, number, number]): number {
  const a = fg[3];
  const r = fg[0] * a + bg[0] * (1 - a);
  const g = fg[1] * a + bg[1] * (1 - a);
  const b = fg[2] * a + bg[2] * (1 - a);
  const l1 = luminance(r, g, b);
  const l2 = luminance(bg[0], bg[1], bg[2]);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG 2.1: 3 for large text (24 px, or 18.66 px and bold), 4.5 for the rest. */
export const isLarge = (t: Pick<TextSample, "px" | "bold">): boolean =>
  t.px >= 24 || (t.bold && t.px >= 18.66);

export interface LowContrast {
  /** The ratio, in whole hundredths cut down (4.477 is 447). */
  ratioHundredths: number;
  required: 3 | 4.5;
  fg: Rgba;
  bg: readonly [number, number, number];
  count: number;
  examples: string[];
}

/** The text that fails, grouped by colours and size, worst first; and how many elements sat on an image. */
export function findLowContrast(samples: readonly TextSample[]): {
  low: LowContrast[];
  unknown: number;
} {
  const groups = new Map<string, LowContrast>();
  let unknown = 0;
  for (const s of samples) {
    if (s.px <= 0) continue;
    if (s.bg === null) {
      unknown += 1;
      continue;
    }
    const ratio = contrastRatio(s.fg, s.bg);
    const required = isLarge(s) ? 3 : 4.5;
    if (ratio >= required) continue;
    const key = `${s.fg.join(",")}|${s.bg.join(",")}|${required}`;
    const g = groups.get(key);
    if (g) {
      g.count += 1;
      if (g.examples.length < 3 && s.text !== "") g.examples.push(s.text);
    } else
      groups.set(key, {
        ratioHundredths: Math.floor(ratio * 100),
        required,
        fg: s.fg,
        bg: s.bg,
        count: 1,
        examples: s.text === "" ? [] : [s.text],
      });
  }
  return {
    low: [...groups.values()].sort((a, b) => a.ratioHundredths - b.ratioHundredths),
    unknown,
  };
}

const label = (f: Focusable): string => (f.name !== "" ? f.name : `<${f.tag}>`);

/** A positive tabindex (it reorders focus), and each place the order goes back up the page by more than 40 pixels. */
export function focusJumps(focusables: readonly Focusable[]): {
  positive: { name: string; tabindex: number }[];
  jumps: { from: string; to: string }[];
} {
  const positive = focusables
    .filter((f) => f.tabindex !== null && f.tabindex > 0)
    .map((f) => ({ name: label(f), tabindex: f.tabindex as number }));
  const jumps: { from: string; to: string }[] = [];
  for (let i = 1; i < focusables.length; i++) {
    const a = focusables[i - 1] as Focusable;
    const b = focusables[i] as Focusable;
    if (b.y < a.y - 40) jumps.push({ from: label(a), to: label(b) });
  }
  return { positive, jumps };
}

/** Controls the keyboard reaches that have no accessible name. */
export const unnamedControls = (focusables: readonly Focusable[]): Focusable[] =>
  focusables.filter((f) => f.name.trim() === "");

export type LandmarkProblem =
  | { kind: "no-main" }
  | { kind: "many-main"; count: number }
  | { kind: "same-role"; role: string; count: number };

/** A page with no main landmark, more than one, or several of a role that nothing tells apart. */
export function landmarkProblems(landmarks: readonly Landmark[]): LandmarkProblem[] {
  const out: LandmarkProblem[] = [];
  const mains = landmarks.filter((l) => l.role === "main").length;
  if (mains === 0) out.push({ kind: "no-main" });
  else if (mains > 1) out.push({ kind: "many-main", count: mains });
  const byRole = new Map<string, string[]>();
  for (const l of landmarks) {
    if (l.role === "main") continue;
    byRole.set(l.role, [...(byRole.get(l.role) ?? []), l.name.trim().toLowerCase()]);
  }
  for (const [role, names] of byRole) {
    if (names.length < 2) continue;
    if (names.some((n) => n === "") || new Set(names).size < names.length)
      out.push({ kind: "same-role", role, count: names.length });
  }
  return out;
}

export type MotionProblem =
  { kind: "no-rule"; animations: number; endless: number } | { kind: "unreadable"; sheets: number };

/** Motion on the page and no `prefers-reduced-motion` rule, or no way to tell because a stylesheet could not be read. */
export function motionProblem(m: MotionRead): MotionProblem | undefined {
  if (m.animations === 0 || m.reducedMotionRule) return undefined;
  if (m.unreadableSheets > 0) return { kind: "unreadable", sheets: m.unreadableSheets };
  return { kind: "no-rule", animations: m.animations, endless: m.endless };
}
