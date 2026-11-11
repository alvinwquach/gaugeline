import { defineCheck } from "../model.js";
import {
  INTROSPECTION_PROBE,
  graphqlCandidates,
  isHeadlessWordPress,
  readIntrospection,
  readOnlyProbe,
} from "../headless-wordpress/detect.js";
import { NO_CONSENT_INTROSPECTION, ask } from "../headless-wordpress/read.js";
import type { PageSnapshot } from "../snapshot.js";

export const headlessWpIntrospectionOpen = defineCheck<PageSnapshot>({
  id: "headless-wp-introspection-open",
  size: "S",
  done: "The WordPress GraphQL endpoint refuses an introspection query from a visitor who is not logged in.",
  estimateChanges:
    "One setting in WPGraphQL; a tool that reads the schema (a code generator) then needs a logged-in request or a copy of the schema.",
  area: "Security & email",
  severity: "medium",
  title: "Anyone can read the schema of your WordPress GraphQL API",
  what: "The GraphQL endpoint behind this headless WordPress site answers an introspection query with its schema to a visitor who is not logged in.",
  why: "WPGraphQL turns public introspection off by default, so someone turned it on. The schema lists every post type, custom field and relation, including ones the site never shows, and tells a stranger exactly what to ask for.",
  fix: "In WordPress, open GraphQL, then Settings, and turn off public introspection (leave it on for logged-in users and local development). If a build tool needs the schema, save a copy in the repository instead.",
  tech: "Probing check: off unless --owner-consent or gaugeline.consent.json; run only on sites you own or have permission to test. Headless WordPress sites only (a front end with WPGraphQL state in its embedded data, or Next.js serving /wp-content/uploads/). One GET of /graphql on the site, and of the back end its images come from, with the query {__schema{queryType{name}}} in the address: the smallest query that says whether introspection is on. It is parsed with the GraphQL parser and refused unless it is one query; never a mutation, never a full schema, never a POST. An answer holding __schema.queryType.name is a finding (only the root type name is shown); an errors answer means introspection is off. An endpoint that answers a GET with an error status, or not in JSON, is could not check (a POST-only endpoint is). The setting's name and default are from the WPGraphQL security documentation, as quoted in a search result: its exact label was not confirmed (uncited)",
  async run(page, ctx) {
    if (!ctx.fetcher || !ctx.budget || !isHeadlessWordPress(page)) return [];
    if (ctx.ownerConsent !== true) {
      ctx.couldNotCheck?.(page.finalUrl, NO_CONSENT_INTROSPECTION);
      return [];
    }
    const query = readOnlyProbe(INTROSPECTION_PROBE);
    const out = [];
    for (const base of ctx.budget.take("draftRoutes", graphqlCandidates(page).slice(0, 2))) {
      const url = `${base}?query=${encodeURIComponent(query)}`;
      const a = await ask(ctx, url, { accept: "application/json" });
      if ("none" in a) {
        ctx.couldNotCheck?.(base, `the endpoint could not be read: ${a.none}`);
        continue;
      }
      const last = a.hops.at(-1);
      if (!last || last.status === 404) continue;
      if (last.status >= 400 || last.status < 200) {
        ctx.couldNotCheck?.(base, `the endpoint answered ${last.status} to a GET`);
        continue;
      }
      const read = readIntrospection(
        last.body ?? "",
        last.truncated === true,
        last.headers["content-type"] ?? "",
      );
      if (read.state === "unread") {
        ctx.couldNotCheck?.(base, read.reason);
        continue;
      }
      if (read.state === "closed") continue;
      out.push({
        checkId: "headless-wp-introspection-open",
        severity: "medium" as const,
        title: this.title,
        evidence: `${new URL(base).origin}/graphql answers an introspection query with its schema (root type ${read.rootType}) with no login`,
        url: page.finalUrl,
      });
    }
    return out;
  },
});
