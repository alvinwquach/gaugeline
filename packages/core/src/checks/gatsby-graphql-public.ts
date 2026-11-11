import { defineCheck } from "../model.js";
import { isGatsbySite, isGraphiqlPage } from "../gatsby/detect.js";
import { getOrNull } from "../probe.js";
import type { PageSnapshot } from "../snapshot.js";

export const NO_CONSENT_REASON =
  "this check asks for the GraphQL explorer address, which no visitor needs, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

/** The origins asked in this run, keyed by the run's budget: one request per site, not per page. */
const asked = new WeakMap<object, Set<string>>();

export const gatsbyGraphqlPublic = defineCheck<PageSnapshot>({
  id: "gatsby-graphql-public",
  size: "S",
  done: "/___graphql answers 404 on the live address.",
  estimateChanges:
    "A host that runs gatsby develop needs to be moved to the built site; a proxy rule that forwards /___graphql needs removing.",
  area: "Security & email",
  severity: "high",
  title: "The GraphQL explorer is reachable on the live site",
  what: "The address /___graphql of this Gatsby site answers with the GraphiQL page (titled Gatsby - GraphiQL), which only `gatsby develop` serves.",
  why: "That explorer can read every node in your content layer, drafts and private fields included, from any browser.",
  fix: "Serve the built site (`gatsby build`) on the live address and keep `gatsby develop` on your own machine. If a proxy forwards /___graphql, remove the rule.",
  tech: "Probing check: off unless --owner-consent or gaugeline.consent.json; run only on sites you own or have permission to test. Gatsby sites only: one GET of /___graphql per run, no query sent and no POST ever; a 2xx HTML answer whose title contains GraphiQL is a finding. A production build does not serve this address",
  async run(page, ctx) {
    if (!ctx.fetcher || !ctx.budget || !isGatsbySite(page)) return [];
    if (ctx.ownerConsent !== true) {
      ctx.couldNotCheck?.(page.finalUrl, NO_CONSENT_REASON);
      return [];
    }
    const origin = new URL(page.finalUrl).origin;
    const done = asked.get(ctx.budget) ?? new Set<string>();
    asked.set(ctx.budget, done);
    if (done.has(origin)) return [];
    done.add(origin);
    const last = (await getOrNull(ctx.fetcher, `${origin}/___graphql`)).at(-1);
    if (
      !last ||
      last.status < 200 ||
      last.status >= 300 ||
      !/html/i.test(last.headers["content-type"] ?? "") ||
      !isGraphiqlPage(last.body ?? "")
    )
      return [];
    return [
      {
        checkId: "gatsby-graphql-public",
        severity: "high",
        title: this.title,
        evidence: "/___graphql answers the GraphiQL page (Gatsby - GraphiQL)",
        url: `${origin}/___graphql`,
      },
    ];
  },
});
