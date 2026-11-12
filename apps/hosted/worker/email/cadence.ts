/**
 * How often the worker looks at the morning email, apart from the loop that runs the checks.
 *
 * The step is started from the pool's claim, never awaited there: a slow mail service must not hold a free
 * slot while a job is due (the pool's rule, see pool.ts). It runs at most once at a time, at most once per
 * `everyMs` on the worker's clock, and a failure of any kind is swallowed here so it never reaches the pool.
 * The worker waits for the step in hand when it stops (`settled`), like it does for a job.
 */
export interface MorningCadence {
  /** Start the step if it is due and none is running. Returns at once. */
  tick: () => void;
  /** Resolves when no step is running. */
  settled: () => Promise<void>;
}

export function morningCadence(
  step: (now: Date) => Promise<unknown>,
  clock: () => Date,
  everyMs: number,
): MorningCadence {
  let last = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | undefined;
  return {
    tick() {
      if (inFlight) return;
      const now = clock();
      if (now.getTime() - last < everyMs) return;
      last = now.getTime();
      const run: Promise<void> = (async () => {
        try {
          await step(now);
        } catch {
          // A fixed line: the error's own words could carry an address or a key.
          console.error(
            "worker: the morning email step failed; it is tried again at the next look",
          );
        }
      })().finally(() => {
        if (inFlight === run) inFlight = undefined;
      });
      inFlight = run;
    },
    settled: async () => {
      await inFlight;
    },
  };
}
