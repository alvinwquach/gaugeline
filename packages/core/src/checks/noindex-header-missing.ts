import { NetworkError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { buildSnapshot } from "../snapshot.js";
import { NOT_FOUND_PATH } from "./not-found-200.js";
import { isHtmlPage } from "./page.js";

/** Bytes of each answer read: the headers decide, and a robots meta tag sits near the top. */
const PEEK_BYTES = 16384;
const NOINDEX = /\b(?:noindex|none)\b/i;

export const NO_CONSENT_REASON =
  "this check asks the site for addresses its pages do not cover, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";
/** One set of answers per run and address: the first page that asks reports it. */
const asked = new WeakMap<object, Set<string>>();

/**
 * FF-03. While a site is meant to stay out of search, a robots meta tag only covers HTML pages that
 * set it. Routes the page metadata does not reach (a not-found page, the editor studio, an API route,
 * a file) can only be kept out by an X-Robots-Tag header. The routes asked are the made-up address
 * every not-found check uses and the ones the owner names in gaugeline.hidden.json (`noindexRoutes`):
 * Gaugeline never chooses an admin path itself (CLAUDE.md rule 14).
 *
 * // [docs] next@16.4.1 > next.config.js headers - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/03-api-reference/05-config/01-next-config-js/headers.mdx (page: https://nextjs.org/docs/app/api-reference/config/next-config-js/headers), line 1: headers are set "on the response to an incoming request on a given path". Supports the fix only.
 * // [docs] next@16.4.1 > proxy - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/03-api-reference/03-file-conventions/proxy.mdx, line 75: without a matcher the proxy runs on every request, `_next/static` and `public/` assets included. Supports the fix only.
 * // [GC] no source found (uncited): X-Robots-Tag semantics, and that a robots meta tag covers only pages that set it (MDN and Google's pages were unreachable). The check text says what it saw and does not state more.
 */
export const noindexHeaderMissing = defineCheck<PageSnapshot>({
  id: "noindex-header-missing",
  size: "S",
  done: "Every route you listed, and the not-found page, answers with noindex in the X-Robots-Tag header while the site is hidden.",
  estimateChanges:
    "One headers() entry in the framework's config per route, or one rule in the proxy that covers them all. A studio served from another host is set in that host's settings.",
  area: "Search & sharing",
  severity: "high",
  title: "A route the page metadata does not reach has no noindex header",
  what: "The site is set to stay out of search, and an address its pages' metadata does not reach (the made-up not-found address, and each route you listed: the editor studio, an API route, a file) answers without noindex in the X-Robots-Tag header or in the page.",
  why: "A robots meta tag only covers HTML pages that set it. A not-found page, the studio, an API route or a file is not one of those, so only a header can keep it out of search. Without it a site that is meant to be hidden can still be found through those addresses.",
  fix: "Send X-Robots-Tag: noindex for those routes while the site is hidden: in Next.js a headers() entry in next.config for each route, or one rule in the proxy for every response, switched by the same setting as the rest of indexing. Remove it at launch.",
  tech: `probing check, off without --owner-consent, and without a gaugeline.hidden.json section that hides the whole site ("match": "/*"): one GET each of ${NOT_FOUND_PATH} and of the routes named in noindexRoutes there (at most 8), no cookie, no Authorization, no query, at most ${PEEK_BYTES} bytes of each answer read and never kept, once per run; Gaugeline never picks a route such as /studio itself. A 2xx answer with no noindex or none in X-Robots-Tag and no robots meta tag with it is a finding; 401, 403, 404 and 410 on the made-up address are not (a login, or an address that does not exist); a listed route that answers 404, a 5xx, 429 or nothing is could-not-check. The fetcher refuses private addresses unless --allow-private`,
  async run(page, ctx) {
    if (!isHtmlPage(page)) return [];
    const origin = new URL(page.finalUrl).origin;
    const key: object | undefined = ctx.fetcher ?? ctx.budget;
    if (key === undefined || !ctx.fetcher) return [];
    const seen = asked.get(key) ?? new Set<string>();
    asked.set(key, seen);
    if (seen.has(origin)) return [];
    seen.add(origin);
    // Only a site that says it is hidden is asked about: the consent note below is for those alone.
    const config = ctx.hidden;
    if (config === undefined || !config.hidden.some((s) => s.match === "/*")) return [];
    if (ctx.ownerConsent !== true) {
      ctx.couldNotCheck?.(origin, NO_CONSENT_REASON);
      return [];
    }
    const routes = [...new Set([NOT_FOUND_PATH, ...(config.noindexRoutes ?? [])])];
    const out: Finding[] = [];
    for (const route of routes) {
      const url = `${origin}${route}`;
      const hop = await answer(ctx.fetcher, url);
      if (hop === undefined) {
        ctx.couldNotCheck?.(url, "the address did not answer");
        continue;
      }
      if (NOINDEX.test(hop.headers["x-robots-tag"] ?? "")) continue;
      const status = hop.status;
      if (route === NOT_FOUND_PATH && [401, 403, 404, 410].includes(status)) continue;
      if (status >= 200 && status < 300) {
        if (
          /html/i.test(hop.headers["content-type"] ?? "") &&
          NOINDEX.test(buildSnapshot([hop]).metaRobots ?? "")
        )
          continue;
        out.push({
          checkId: this.id,
          severity: this.severity,
          title: this.title,
          evidence: `${route} answers ${status} with no noindex in the X-Robots-Tag header or in the page`,
          url,
        });
      } else if (status === 401 || status === 403) {
        continue;
      } else {
        ctx.couldNotCheck?.(url, `the address answered ${status}, which is not a clear answer`);
      }
    }
    return out;
  },
});

async function answer(fetcher: Fetcher, url: string) {
  try {
    const hops = await fetcher.get(url, { anonymous: true, maxBytes: PEEK_BYTES });
    const last = hops.at(-1);
    return last && !last.error ? last : undefined;
  } catch (err) {
    if (err instanceof NetworkError) return undefined;
    throw err;
  }
}
