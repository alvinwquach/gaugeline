import { defineCheck } from "../model.js";
import { LIMITS } from "../limits.js";
import { isNuxtSite } from "../nuxt/detect.js";
import { getOrNull } from "../probe.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

/** Where the Nuxt DevTools module serves its client (base URL + /__nuxt_devtools__/client). */
export const DEVTOOLS_CLIENT_PATH = "/__nuxt_devtools__/client/";

export const NO_DEVTOOLS_CONSENT_REASON =
  "this check asks for the Nuxt DevTools address, which is not a page the site links to, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

/** One answer per run and address: the first page that asks reports it. */
const asked = new WeakMap<object, Set<string>>();

export const nuxtDevtoolsPublic = defineCheck<PageSnapshot>({
  id: "nuxt-devtools-public",
  size: "S",
  done: "/__nuxt_devtools__/client/ answers 404 on the live site.",
  estimateChanges:
    "Normally the same fix as nuxt-dev-build-live: deploy the output of nuxt build instead of the dev server.",
  area: "Security & email",
  severity: "high",
  title: "The Nuxt DevTools are reachable",
  what: "This Nuxt site answers at /__nuxt_devtools__/client/ with the Nuxt DevTools page.",
  why: "The DevTools show the app's files, routes, runtime config, server routes and modules to whoever opens the address.",
  fix: "Run the live site from a production build (nuxt build, then the server output or the static files), never nuxt dev, and keep the @nuxt/devtools module to development.",
  tech: `probing check, off without --owner-consent: Nuxt sites only; one GET of ${DEVTOOLS_CLIENT_PATH} on the site's origin (the route the Nuxt DevTools module registers; a site under a base URL prefix is not asked at its prefix), once per address in a run, at most ${LIMITS.nuxtAddresses} Nuxt addresses; a finding needs a 200 HTML answer whose text includes "Nuxt DevTools" (that title is uncited: it comes from the module's own branding, not from the documentation). Any other answer, including a 200 page that is the site's own, is not reported; no answer is could-not-check`,
  async run(page, ctx) {
    if (!isNuxtSite(page) || !isHtmlPage(page)) return [];
    if (ctx.ownerConsent !== true) {
      ctx.couldNotCheck?.(page.finalUrl, NO_DEVTOOLS_CONSENT_REASON);
      return [];
    }
    if (!ctx.fetcher || !ctx.budget) return [];
    const url = `${new URL(page.finalUrl).origin}${DEVTOOLS_CLIENT_PATH}`;
    const key = ctx.budget;
    const seen = asked.get(key) ?? new Set<string>();
    asked.set(key, seen);
    if (seen.has(url)) return [];
    seen.add(url);
    if (ctx.budget.take("nuxtAddresses", [url]).length === 0) {
      ctx.couldNotCheck?.(url, "left out by the limit on Nuxt addresses");
      return [];
    }
    const hop = (await getOrNull(ctx.fetcher, url)).at(-1);
    if (!hop) {
      ctx.couldNotCheck?.(url, "the address did not answer");
      return [];
    }
    if (hop.status !== 200 || !/html/i.test(hop.headers["content-type"] ?? "")) return [];
    if (!(hop.body ?? "").includes("Nuxt DevTools")) return [];
    return [
      {
        checkId: "nuxt-devtools-public",
        severity: "high",
        title: this.title,
        evidence: `${DEVTOOLS_CLIENT_PATH} answered 200 with the Nuxt DevTools page`,
        url,
      },
    ];
  },
});
