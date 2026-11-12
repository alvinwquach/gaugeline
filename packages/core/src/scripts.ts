import type { Fetcher } from "./fetcher.js";
import type { Budget } from "./limits.js";
import { getOrNull } from "./probe.js";
import { isSameSite, sampleUrls } from "./sample.js";
import type { PageSnapshot } from "./snapshot.js";

/** One same-site JavaScript file, as sent (up to the fetcher's body cap). */
export interface ScriptRead {
  url: string;
  /** The final status, or null when it could not be reached. */
  status: number | null;
  text: string;
  /** The body was longer than the cap (LIMITS.bodyBytes) and only its start was read. */
  truncated: boolean;
  /** The address its SourceMap (or older X-SourceMap) response header names, as written. */
  sourceMap?: string;
}

export interface ScriptOptions {
  page: PageSnapshot;
  fetcher: Fetcher;
  budget: Budget;
}

/**
 * The page's same-site script files (script src), first ones in document order, at most
 * LIMITS.scripts, each fetched once with GET. Third-party scripts are not the site's to fix.
 */
export async function readScripts({ page, fetcher, budget }: ScriptOptions): Promise<ScriptRead[]> {
  const sameSite = page.scripts.filter((u) => isSameSite(u, page.finalUrl));
  const urls = sampleUrls(
    sameSite.map((url) => ({ url })),
    Number.MAX_SAFE_INTEGER,
  ).taken.map((t) => t.url);
  return Promise.all(
    budget.take("scripts", urls).map(async (url) => {
      const last = (await getOrNull(fetcher, url)).at(-1);
      const ok = last !== undefined && last.status >= 200 && last.status < 300;
      const sourceMap = ok ? (last.headers.sourcemap ?? last.headers["x-sourcemap"]) : undefined;
      return {
        url,
        status: last?.status ?? null,
        text: ok ? (last.body ?? "") : "",
        truncated: last?.truncated ?? false,
        ...(sourceMap ? { sourceMap: sourceMap.trim() } : {}),
      };
    }),
  );
}

export function lazyScripts(opts: ScriptOptions): () => Promise<ScriptRead[]> {
  let pending: Promise<ScriptRead[]> | undefined;
  return () => (pending ??= readScripts(opts));
}
