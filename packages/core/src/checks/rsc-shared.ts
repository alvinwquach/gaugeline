import type { CheckContext, Finding } from "../model.js";
import { isNextSite } from "../next/detect.js";
import type { PageSnapshot } from "../snapshot.js";
import { judge, parseVary, prefetchOf } from "../verify/recheck.js";

const cache = new WeakMap<PageSnapshot, Promise<RscRead>>();

/** The findings, or why the prefetch request couldn't be read (each check records that itself). */
export type RscRead = { findings: Finding[]; unread?: string };

/**
 * Both RSC checks for one page of a plain site check: the page itself is the normal request, so
 * only the prefetch request is made, once, shared by the two checks.
 */
function rscRead(page: PageSnapshot, ctx: CheckContext): Promise<RscRead> {
  const hit = cache.get(page);
  if (hit) return hit;
  const run = async (): Promise<RscRead> => {
    const last = page.hops.at(-1);
    const type = (last?.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
    const vary = parseVary(last?.headers.vary);
    // Only a React framework page answers RSC: 1 differently: anything else makes no request.
    if (!ctx.fetcher || !(isNextSite(page) || /x-component/i.test(type) || vary.includes("rsc")))
      return { findings: [] };
    const pre = await prefetchOf(ctx.fetcher, page.requestedUrl);
    if (typeof pre === "string") return { findings: [], unread: pre };
    const findings = judge({
      url: page.finalUrl,
      normal: { status: last?.status ?? 0, contentType: type, words: page.wordCount },
      prefetch: { status: pre.status, contentType: pre.contentType },
      vary: [...new Set([...vary, ...pre.vary])],
      exportLines: [],
      ...(pre.cdn.length > 0 ? { cdn: pre.cdn } : {}),
    });
    return { findings };
  };
  const p = run();
  cache.set(page, p);
  return p;
}

/** One check's share: its own findings, and its own could-not-check line. */
export async function rscFindings(
  page: PageSnapshot,
  ctx: CheckContext,
  id: string,
): Promise<Finding[]> {
  const read = await rscRead(page, ctx);
  if (read.unread) ctx.couldNotCheck?.(page.finalUrl, read.unread);
  return read.findings.filter((f) => f.checkId === id);
}
