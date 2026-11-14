import {
  buildResult,
  checkSite,
  createFetcher,
  createPageRegistry,
  EMAIL_PRESET,
  progressText,
  Semaphore,
  type CheckRegistry,
  type FetcherOptions,
} from "@gaugeline/core";
import { startAdsRun, type AdsInput } from "./ads.js";
import type { Counts, Run, Store } from "./store.js";

export interface RunnerOptions {
  /** Base fetcher options (tests pass a fixture's hosts map or a transport). */
  fetcher?: FetcherOptions;
  /** The run's clock (tests). */
  now?: () => Date;
  /** The checks to run, and the text the report names them with. Default: every page check. */
  registry?: CheckRegistry;
}

/**
 * Starts checks. Every run has its own fetcher, its target the address that was typed (so a
 * redirect or link to another non-public address is refused), and all of them share one in-flight
 * limit: the app never has more than five requests out at once.
 */
export function createRunner(store: Store, opts: RunnerOptions = {}) {
  const semaphore = new Semaphore(5);
  const registry = opts.registry ?? createPageRegistry();
  const ids = new Set(registry.all().map((c) => c.id));
  // As the CLI without --dns: the mail record checks are listed as not run, never resolved.
  const dnsSkipped = EMAIL_PRESET.filter((id) => ids.has(id));
  async function run(r: Run): Promise<void> {
    const startedAt = new Date(r.startedAt);
    try {
      const fetcher = createFetcher({ ...opts.fetcher, target: r.url, semaphore });
      const { snapshot, result, requests, page, leaks } = await checkSite({
        address: r.url,
        fetcher,
        registry,
        skip: dnsSkipped,
        onProgress: (e) => {
          const text = progressText(e);
          if (text) store.emit(r, { event: "step", data: { text } });
        },
        ...(opts.now ? { now: opts.now } : {}),
      });
      r.result = buildResult({
        url: snapshot.requestedUrl,
        startedAt,
        findings: result.findings,
        passed: result.passed,
        failed: [...result.failed.map((f) => f.id), ...dnsSkipped],
        couldNotCheck: result.couldNotCheck,
        sampled: result.sampled,
      });
      const counts: Counts = { high: 0, medium: 0, low: 0 };
      for (const f of result.findings) counts[f.severity]++;
      // What the Pages checked, Search data and Leaks & access views show. Not part of the versioned result.
      r.checked = { ...(requests ? { requests } : {}), page, leaks };
      r.report = { result, url: snapshot.finalUrl };
      r.counts = counts;
      r.state = "done";
      store.emit(r, { event: "done", data: { counts } });
    } catch (err) {
      r.state = "failed";
      r.reason = err instanceof Error ? err.message : String(err);
      store.emit(r, { event: "failed", data: { reason: r.reason } });
    }
  }
  return {
    /** Add a run for `url` and start it; resolves when it has finished. POST /api/check and the
     * address given to gaugeline open both come here. */
    start(url: string): { run: Run; finished: Promise<void> } {
      const r = store.add(url, opts.now?.() ?? new Date());
      return { run: r, finished: run(r) };
    },
    /** Add a run of kind "ads" for an export that was read at start, sharing this runner's five-request limit. */
    startAds(input: AdsInput): { run: Run; finished: Promise<void> } {
      return startAdsRun(input, store, {
        ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
        semaphore,
        ...(opts.now ? { now: opts.now } : {}),
      });
    },
  };
}
export type Runner = ReturnType<typeof createRunner>;
