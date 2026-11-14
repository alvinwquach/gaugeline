/**
 * Which change moves the numbers (PERF-02). The page is loaded twice as it is, to see how much two identical
 * loads differ, and then once with each of three things taken away: motion (`prefers-reduced-motion: reduce`),
 * JavaScript, and scripts from other sites. A change "moves" a number when it is bigger than the baseline's own
 * spread, than a floor for that number, and than ten percent of the baseline. Pure: whole milliseconds in, whole
 * milliseconds out, the same input always gives the same answer.
 */

/** The changes, in the order they are loaded and reported. */
export const VARIANT_NAMES = ["reduced-motion", "no-javascript", "no-third-party"] as const;
export type VariantName = (typeof VARIANT_NAMES)[number];

/** The numbers compared, in the order they are reported. Speed Index is not one: it needs a video of the load. */
export const METRICS = ["lcpMs", "tbtMs"] as const;
export type MetricName = (typeof METRICS)[number];

export type Measure = Partial<Record<MetricName, number>>;

/** The smallest change, in milliseconds, that is ever called a move. Uncited: a product choice. */
export const MIN_MOVE: Readonly<Record<MetricName, number>> = Object.freeze({
  lcpMs: 200,
  tbtMs: 100,
});

export interface Move {
  variant: VariantName;
  metric: "lcp" | "tbt";
  /** The baseline's mean, whole milliseconds. */
  from: number;
  to: number;
  /** `to - from`: negative is faster. */
  change: number;
  /** How much the baseline loads differed from each other (largest minus smallest). */
  noise: number;
}

export interface Attribution {
  moves: Move[];
  /** Numbers that were missing from the baseline or from a variant, so were not compared. */
  unmeasured: { variant: VariantName; metric: "lcp" | "tbt" }[];
}

const SHORT = { lcpMs: "lcp", tbtMs: "tbt" } as const;

export function attributeSpeed(
  baselines: readonly Measure[],
  variants: Partial<Record<VariantName, Measure | undefined>>,
): Attribution {
  const moves: Move[] = [];
  const unmeasured: Attribution["unmeasured"] = [];
  for (const variant of VARIANT_NAMES) {
    for (const metric of METRICS) {
      const seen = baselines.flatMap((b) => (b[metric] === undefined ? [] : [b[metric] as number]));
      const to = variants[variant]?.[metric];
      // Every baseline load must have the number, or the reference would be a guess.
      if (seen.length === 0 || seen.length !== baselines.length || to === undefined) {
        unmeasured.push({ variant, metric: SHORT[metric] });
        continue;
      }
      const from = Math.round(seen.reduce((a, b) => a + b, 0) / seen.length);
      const noise = Math.max(...seen) - Math.min(...seen);
      const change = to - from;
      const threshold = Math.max(noise, MIN_MOVE[metric], Math.ceil(from / 10));
      if (Math.abs(change) > threshold)
        moves.push({ variant, metric: SHORT[metric], from, to, change, noise });
    }
  }
  return { moves, unmeasured };
}
