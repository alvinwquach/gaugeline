/**
 * The per-job deadline (M3). Core's checks take no abort signal, so the deadline reaches them through the
 * one thing they all go through: the fetcher. Once the signal aborts, a request in flight is let go and
 * every later request is refused before anything is sent, so the checks run out of work in moments
 * instead of finishing a slow site's last pages. The worker does not wait for them: processJob frees the
 * job's slot at the deadline whatever the checks are doing.
 */
import type { Fetcher } from "@gaugeline/core";

/** The job ran past its deadline. Stored as the short code `deadline`. */
export class DeadlineError extends Error {
  constructor() {
    super("The job passed its deadline.");
    this.name = "DeadlineError";
  }
}

/** `work`, or a DeadlineError the moment `signal` aborts (at once when it already has). */
export function bounded<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new DeadlineError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DeadlineError());
    signal.addEventListener("abort", onAbort, { once: true });
    // A late answer or failure after the deadline lands here and is dropped.
    work()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The same fetcher (same limits, same history, same counters) that stops at the deadline. */
export function guardFetcher(fetcher: Fetcher, signal: AbortSignal): Fetcher {
  const guarded: Fetcher = {
    get: (url, opts) => bounded(signal, () => fetcher.get(url, opts)),
    getSite: (address, opts) => bounded(signal, () => fetcher.getSite(address, opts)),
    get stats() {
      return fetcher.stats;
    },
  };
  if (fetcher.query) {
    const query = fetcher.query.bind(fetcher);
    guarded.query = (url, opts) => bounded(signal, () => query(url, opts));
  }
  if (fetcher.history) {
    const history = fetcher.history.bind(fetcher);
    guarded.history = () => history();
  }
  return guarded;
}
