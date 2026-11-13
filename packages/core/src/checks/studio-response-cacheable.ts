import { NetworkError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

/** Bytes of each answer read: the headers decide, and the body is never kept. */
const PEEK_BYTES = 4096;
const NO_STORE = /(?:^|[\s,])no-store(?=[\s,=]|$)/i;

export const NO_CONSENT_REASON =
  "this check asks the site for its editor studio, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";
/** One set of answers per run and address: the first page that asks reports it. */
const asked = new WeakMap<object, Set<string>>();

/**
 * FF-19 (advice). A studio is where editors work on content that changes every day. A response that
 * can be stored (no `Cache-Control: no-store`) can be served again from a browser or a shared cache
 * after the studio has been updated, so an editor can be handed an old shell. The routes asked are the
 * ones the owner names in gaugeline.studio.json: Gaugeline never chooses an admin path itself
 * (CLAUDE.md rule 14), and it asks only with --owner-consent. One GET each, no cookie, nothing sent.
 *
 * // [docs] MDN > HTTP caching, "Don't cache" - https://raw.githubusercontent.com/mdn/content/92395f809c3067b56ef5ea031faf864cdaee1c55/files/en-us/web/http/guides/caching/index.md (line 310: "The no-cache directive does not prevent the storing of responses but instead prevents the reuse of responses without revalidation"; line 312: "If you don't want a response stored in any cache, use no-store". Read at that commit of the MDN content repository; the site was unreachable.)
 * // [docs] next@16.4.1 > next.config.js headers - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/03-api-reference/05-config/01-next-config-js/headers.mdx, line 1: headers are set "on the response to an incoming request on a given path". Supports the fix only.
 * // [GC] no source found (uncited): that an editor is handed a stale studio because of it. It is the owner's reason for the check; the finding says only that nothing in the response forbids storing it.
 */
export const studioResponseCacheable = defineCheck<PageSnapshot>({
  id: "studio-response-cacheable",
  size: "S",
  done: "Every studio route you listed answers with no-store in its Cache-Control header.",
  estimateChanges:
    "One headers() entry in the framework's config for an embedded studio. A studio served from another host is set in that host's settings, and a hosting platform's default cache rules may need a rule of their own.",
  area: "Launch day",
  severity: "low",
  title: "The editor studio can be cached",
  what: "A studio route you listed answers 200 with no no-store in its Cache-Control header (no header at all, or one with other directives).",
  why: "A response that may be stored can be shown again from a browser or a shared cache after the studio has changed, so an editor can be handed an old page of it. no-store is the directive that says a response must not be stored in any cache. (Gaugeline has not confirmed from Sanity's documentation how a studio is cached.)",
  fix: "Send Cache-Control: no-store for the studio's route: a headers() entry in next.config for an embedded studio, or a rule in the settings of the host that serves it.",
  tech: `probing check, off without --owner-consent and a gaugeline.studio.json that names the studio's route (studioRoutes, at most 4): one GET of each, no cookie or Authorization, at most ${PEEK_BYTES} bytes of each answer read and never kept, once per run; Gaugeline never picks a route such as /studio itself. A 2xx answer, after redirects, whose Cache-Control has no no-store directive is a finding; 401 and 403 are not; a route that answers 404, 410, 429, a 5xx or nothing is could-not-check; the finding names the route and the status, never a header value`,
  async run(page, ctx) {
    if (!isHtmlPage(page)) return [];
    const origin = new URL(page.finalUrl).origin;
    const key: object | undefined = ctx.fetcher ?? ctx.budget;
    if (key === undefined || !ctx.fetcher) return [];
    const seen = asked.get(key) ?? new Set<string>();
    asked.set(key, seen);
    if (seen.has(origin)) return [];
    seen.add(origin);
    // Only a site whose owner named the studio is asked about it.
    const config = ctx.studio;
    if (config === undefined) return [];
    if (ctx.ownerConsent !== true) {
      ctx.couldNotCheck?.(origin, NO_CONSENT_REASON);
      return [];
    }
    const out: Finding[] = [];
    for (const route of new Set(config.studioRoutes)) {
      const url = `${origin}${route}`;
      const hop = await answer(ctx.fetcher, url);
      if (hop === undefined) {
        ctx.couldNotCheck?.(url, "the address did not answer");
        continue;
      }
      const status = hop.status;
      if (status === 401 || status === 403) continue;
      if (status < 200 || status >= 300) {
        ctx.couldNotCheck?.(url, `the address answered ${status}, which is not a clear answer`);
        continue;
      }
      const header = hop.headers["cache-control"];
      if (header !== undefined && NO_STORE.test(header)) continue;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence:
          header === undefined
            ? `${route} answers ${status} with no Cache-Control header, so nothing says it must not be stored`
            : `${route} answers ${status} with a Cache-Control header that has no no-store`,
        url,
      });
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
