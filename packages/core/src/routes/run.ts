import { createRoutesRegistry, type RoutesInput } from "../checks/route-hidden-not-protected.js";
import type { Fetcher } from "../fetcher.js";
import { buildResult, type Result } from "../result.js";
import { runChecks } from "../run.js";
import { readRoutes, type RouteEntry } from "./discover.js";
import { probeRouteDetails, type RouteAnswer, type SkippedRoute } from "./probe.js";

export interface RoutesRunOptions {
  /** The folder with the Next.js app directory in it. */
  dir: string;
  /** The running site to ask. */
  base: string;
  fetcher: Fetcher;
  now: Date;
  /** The owner agreed to probing checks. Without it nothing is asked and the check says so. */
  ownerConsent: boolean;
  /** The folder as typed, put before each file name. */
  prefix?: string;
}

export interface RoutesRun {
  result: Result;
  /** Every route found, sorted by path. */
  routes: RouteEntry[];
  /** What each asked route answered. */
  answers: Map<string, RouteAnswer>;
  skipped: SkippedRoute[];
  /** The app folder read, relative to `dir`; undefined when there is none. */
  appDir?: string;
  /** What was not read or not relied on (a middleware with no matcher, a broad matcher). */
  notes: string[];
}

/**
 * `gaugeline check <folder> --routes --base <address>`: read the routes from the folder, ask each
 * one that expects a session for its page with no session, and report the ones that hand it over.
 * Nothing is asked without consent, and no request is made when the folder has no app directory.
 */
export async function checkRoutes(options: RoutesRunOptions): Promise<RoutesRun> {
  const discovery = await readRoutes(options.dir);
  const asked =
    options.ownerConsent && discovery.appDir !== undefined
      ? await probeRouteDetails(discovery.routes, options.base, options.fetcher)
      : { answers: new Map<string, RouteAnswer>(), skipped: [] as SkippedRoute[] };
  const input: RoutesInput = {
    routes: discovery.routes,
    answers: asked.answers,
    skipped: asked.skipped,
    base: options.base,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    ownerConsent: options.ownerConsent,
  };
  const checked = await runChecks(input, createRoutesRegistry());
  return {
    result: buildResult({
      url: options.base,
      startedAt: options.now,
      findings: checked.findings,
      passed: checked.passed,
      failed: checked.failed.map((f) => f.id),
      couldNotCheck: checked.couldNotCheck,
    }),
    routes: discovery.routes,
    answers: asked.answers,
    skipped: asked.skipped,
    ...(discovery.appDir === undefined ? {} : { appDir: discovery.appDir }),
    notes: discovery.notes,
  };
}
