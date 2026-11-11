import type { Env } from "../connectors/types.js";
import { SANITY_TOKEN } from "../connectors/sanity.js";
import type { Fetcher, Hop } from "../fetcher.js";
import { VERCEL_TOKEN_VAR } from "../renewals/tokens.js";
import type { PageSnapshot } from "../snapshot.js";
import { detectBuilder, type HostedBuilder } from "./builders.js";
import { DEFAULT_DELAY_MS, DEFAULT_MULTIPLE, DEFAULT_WINDOW, type CostConfig } from "./config.js";
import type { Observation, PageRead } from "./judge.js";
import { readSanityUsage, readVercelUsage } from "./providers.js";
import type { UsageRead } from "./usage.js";

/** The variables a cost run reads: the usage tokens. Names only, never values. */
export const COST_ENV_VARS = [VERCEL_TOKEN_VAR, SANITY_TOKEN] as const;

export interface CostSettings {
  config: CostConfig;
  /** The variables in COST_ENV_VARS, already copied from the environment. */
  env: Env;
  /** The clock the usage days are counted from. */
  now: () => Date;
  /** Milliseconds between the two visits to a page. Default 3000. */
  delayMs?: number;
  /** Wait that long. Tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * What the cost checks read, once each and shared: every page visited twice a few seconds apart (the
 * page checked and any listed in gaugeline.cost.json), and the account usage of the providers whose
 * tokens the user set. Every request is a GET through the fetcher; nothing here keeps more than a status,
 * headers, a body held only for the comparison and usage figures.
 */
export interface Cost {
  readonly config: CostConfig;
  /** The trailing window and the multiple, with their defaults filled in. */
  readonly usageSettings: { window: number; multiple: number };
  pages(page: PageSnapshot): Promise<PageRead[]>;
  /** The hosted builder the page is served by, if any: a fixed plan, so no usage to read. */
  builder(page: PageSnapshot): HostedBuilder | undefined;
  usage(): Promise<UsageRead>;
}

const observe = (hop: Hop): Observation => ({
  status: hop.status,
  headers: hop.headers,
  ...(hop.body !== undefined ? { body: hop.body } : {}),
});

/** A path is marked static by the settings: exactly, or under a "/folder/*". The query is not part of it. */
export function isMarkedStatic(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? path.startsWith(p.slice(0, -1)) : path === p));
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createCost(settings: CostSettings, fetcher: Fetcher): Cost {
  const { config, env } = settings;
  const delayMs = settings.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = settings.sleep ?? defaultSleep;
  const usageSettings = {
    window: config.usage?.window ?? DEFAULT_WINDOW,
    multiple: config.usage?.multiple ?? DEFAULT_MULTIPLE,
  };
  const staticPatterns = config.static ?? [];
  const reads = new Map<string, Promise<PageRead[]>>();
  let usage: Promise<UsageRead> | undefined;

  const visit = async (url: string): Promise<Hop> => {
    const hops = await fetcher.get(url, { fresh: true });
    const last = hops.at(-1);
    if (!last) throw new Error("No answer.");
    return last;
  };

  const failed = (url: string, path: string, err: unknown): PageRead => ({
    ok: false,
    url,
    path,
    reason: `${path} could not be visited: ${err instanceof Error ? err.message : "the request failed"}`,
  });

  const read = async (url: string, first: Hop | undefined): Promise<PageRead> => {
    const path = new URL(url).pathname;
    try {
      const a = first ?? (await visit(url));
      await sleep(delayMs);
      const b = await visit(url);
      return {
        ok: true,
        url,
        path,
        markedStatic: isMarkedStatic(path, staticPatterns),
        first: observe(a),
        second: observe(b),
        gapMs: delayMs,
      };
    } catch (err) {
      return failed(url, path, err);
    }
  };

  return {
    config,
    usageSettings,
    pages(page) {
      let p = reads.get(page.finalUrl);
      if (!p) {
        const origin = new URL(page.finalUrl).origin;
        const own = new URL(page.finalUrl);
        const listed = [
          ...new Set((config.pages ?? []).map((path) => new URL(path, origin).href)),
        ].filter((u) => new URL(u).pathname !== own.pathname);
        p = Promise.all([
          read(page.finalUrl, page.hops.at(-1)),
          ...listed.map((u) => read(u, undefined)),
        ]);
        reads.set(page.finalUrl, p);
      }
      return p;
    },
    builder: detectBuilder,
    usage() {
      usage ??= (async (): Promise<UsageRead> => {
        const now = settings.now();
        const args = { env, fetcher, now, window: usageSettings.window };
        return {
          providers: await Promise.all([
            readVercelUsage({ ...args, teamId: config.vercel?.teamId }),
            readSanityUsage(args),
          ]),
        };
      })();
      return usage;
    },
  };
}
