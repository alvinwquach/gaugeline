import { NetworkError } from "../errors.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

/** The one address asked: made up, and fixed so the same site gives the same answer every run. */
export const NOT_FOUND_PATH = "/gaugeline-not-found-3f9c2a71";

/** Bytes of the answer read: the status is what matters, the body is never kept. */
const PEEK_BYTES = 4096;

/** Why a run without consent did not ask. Reads after "could not be checked:". */
export const NO_CONSENT_REASON =
  "this check asks the site for an address that does not exist, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

export const notFound200 = defineCheck<PageSnapshot>({
  id: "not-found-200",
  area: "Search & sharing",
  severity: "medium",
  title: "Pages that do not exist answer 200",
  what: "An address that cannot exist on this site (made up from the site's own address) answers 200, or sends the visitor to another page that answers 200, instead of 404 or 410.",
  why: "Google calls this a soft 404: every mistyped or deleted address looks like a real page, search engines spend visits on it and may index the empty result, and you never hear about dead links because nothing reports an error.",
  fix: "Make the not-found route answer 404 (410 for pages removed on purpose). In Next.js use notFound() and a not-found page, in Nuxt createError with statusCode 404, in SvelteKit error(404), and on a host with a catch-all rewrite (a single-page app) add a 404 rule for unknown paths.",
  tech: `probing check, off without --owner-consent: one GET of ${NOT_FOUND_PATH} on the checked page's own origin, no cookie, no Authorization, no query, at most ${PEEK_BYTES} bytes of the answer read and never kept. A final status of 200 is a finding, also after a redirect (a redirect to the home page is the same soft 404); 404 and 410 pass; 401, 403, 429, 5xx and an unreachable site are could not check. The fetcher refuses private addresses unless --allow-private`,
  size: "S",
  done: "The made-up address answers 404 or 410 and the page it shows says so.",
  estimateChanges:
    "A framework's not-found route is one change. A host rewrite that sends every path to one file is a rule in the host's settings, and a single-page app may need a server answer for the first time.",
  async run(page, ctx) {
    if (!isHtmlPage(page)) return [];
    const origin = new URL(page.finalUrl).origin;
    const url = `${origin}${NOT_FOUND_PATH}`;
    if (ctx.ownerConsent !== true) {
      ctx.couldNotCheck?.(url, NO_CONSENT_REASON);
      return [];
    }
    const fetcher = ctx.fetcher;
    if (!fetcher) return [];
    let hops;
    try {
      hops = await fetcher.get(url, { anonymous: true, maxBytes: PEEK_BYTES });
    } catch (err) {
      if (err instanceof NetworkError) {
        ctx.couldNotCheck?.(url, "the site did not answer the request");
        return [];
      }
      throw err;
    }
    const last = hops.at(-1);
    if (!last || last.error) {
      ctx.couldNotCheck?.(url, "the site did not answer the request");
      return [];
    }
    if (last.status === 404 || last.status === 410) return [];
    if (last.status !== 200) {
      ctx.couldNotCheck?.(url, `the site answered ${last.status}, which is not a clear answer`);
      return [];
    }
    const redirected = hops.length > 1;
    return [
      {
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: redirected
          ? `${NOT_FOUND_PATH} redirects, then answers 200 at ${new URL(last.url).pathname}, not 404`
          : `${NOT_FOUND_PATH} answers 200, not 404`,
        url,
      },
    ];
  },
});
