import { createPageRegistry } from "./checks/index.js";
import type { Fetcher } from "./fetcher.js";
import { createBudget, type Budget } from "./limits.js";
import type { CheckRegistry } from "./model.js";
import type { ProgressSink } from "./progress.js";
import { runChecks, type RunOptions, type RunResult } from "./run.js";
import { dedupeUrls } from "./sample.js";
import { lazySiteContext } from "./site-context.js";
import { buildSnapshot, type PageSnapshot } from "./snapshot.js";

export interface SiteCheckOptions {
  /** What the person typed: a bare domain or a full address. */
  address: string;
  fetcher: Fetcher;
  registry?: CheckRegistry;
  budget?: Budget;
  onProgress?: ProgressSink;
  only?: RunOptions["only"];
  skip?: RunOptions["skip"];
}

export interface SiteCheck {
  snapshot: PageSnapshot;
  result: RunResult;
  budget: Budget;
}

/**
 * One full check of a site, in the order the docs describe: load the page without JavaScript,
 * read robots.txt and the sitemap, check the links, scan the JavaScript, then run every check.
 * Each step is announced once through onProgress.
 */
export async function checkSite(opts: SiteCheckOptions): Promise<SiteCheck> {
  const sink = opts.onProgress ?? (() => undefined);
  const budget = opts.budget ?? createBudget();
  sink({ step: "load-page" });
  const snapshot = buildSnapshot(await opts.fetcher.getSite(opts.address));
  sink({ step: "robots-sitemap" });
  const sameSite = dedupeUrls(snapshot.links.filter((l) => l.sameSite).map((l) => l.href));
  sink({ step: "links", count: Math.min(sameSite.length, budget.remaining("links")) });
  sink({ step: "scripts" });
  const result = await runChecks(snapshot, opts.registry ?? createPageRegistry(), {
    ctx: {
      fetcher: opts.fetcher,
      budget,
      site: lazySiteContext({ page: snapshot, fetcher: opts.fetcher, budget }),
    },
    onProgress: sink,
    ...(opts.only ? { only: opts.only } : {}),
    ...(opts.skip ? { skip: opts.skip } : {}),
  });
  return { snapshot, result, budget };
}
