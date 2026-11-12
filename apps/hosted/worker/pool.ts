/**
 * The worker's pool: at most `limit` jobs run at once, and a slot that frees claims the next due job at
 * once, so one slow site never holds the others back. It is the loop only (no database, no clock): the
 * caller says how to claim and how to work, so the loop can be tested with gated stand-ins.
 *
 * The rule the loop keeps: it never sleeps while a slot is free and a job may be due. A job that settles
 * while the loop is claiming bumps `settled`, and the loop looks again before it waits, so a wake-up is
 * never lost between "count the free slots" and "wait". It waits on a promise replaced each pass (not on
 * a snapshot of the running jobs, which a job that finished meanwhile has already left). The idle timer
 * runs only when a claim came back with fewer jobs than there were free slots, i.e. the queue is drained.
 */
export interface PoolOptions<J> {
  signal: AbortSignal;
  limit: number;
  /** How long to wait before looking again when the queue is drained. */
  idleMs: number;
  /** Takes up to `free` due jobs (already marked as ours). */
  claim: (free: number) => Promise<J[]>;
  /** Runs one job. A rejection stops the pool (after the jobs in hand settle). */
  work: (job: J) => Promise<unknown>;
}

export async function runPool<J>(o: PoolOptions<J>): Promise<void> {
  const { signal, limit, idleMs } = o;
  const running = new Set<Promise<void>>();
  let settled = 0;
  let failure: { error: unknown } | undefined;
  let freed: () => void = () => {};
  const aborted = new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
  try {
    while (!signal.aborted && !failure) {
      // Replaced every pass: it resolves on the first job that settles after this line.
      const slotFreed = new Promise<void>((resolve) => (freed = resolve));
      const seen = settled;
      const free = limit - running.size;
      if (free > 0) {
        const jobs = await o.claim(free);
        for (const job of jobs) {
          const p: Promise<void> = o.work(job).then(
            () => undefined,
            (error: unknown) => {
              failure ??= { error };
            },
          );
          const done = p.finally(() => {
            running.delete(done);
            settled += 1;
            freed();
          });
          running.add(done);
        }
      }
      if (signal.aborted) break;
      // A job settled while this pass was claiming: its slot may be free and a job due. Look again.
      if (settled !== seen) continue;
      if (running.size >= limit) {
        await Promise.race([aborted, slotFreed]);
      } else {
        // The claim came back short: the queue is drained. Wait for the next look, a freed slot or an abort.
        let timer: NodeJS.Timeout | undefined;
        const tick = new Promise<void>((resolve) => (timer = setTimeout(resolve, idleMs)));
        await Promise.race([aborted, slotFreed, tick]);
        clearTimeout(timer);
      }
    }
  } finally {
    await Promise.allSettled(running);
  }
  if (failure) throw failure.error;
}
