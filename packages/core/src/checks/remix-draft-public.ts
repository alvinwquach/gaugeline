import { defineCheck } from "../model.js";
import { getOrNull } from "../probe.js";
import { isRemixSite } from "../remix/detect.js";
import type { PageSnapshot } from "../snapshot.js";

/**
 * Routes Remix and React Router projects conventionally use for a preview or draft switch. Neither
 * framework has a built-in draft mode (they have sessions and cookies), so these names are
 * conventions of CMS starters: uncited, and so is the cookie rule below.
 */
export const REMIX_DRAFT_ROUTES: readonly string[] = Object.freeze([
  "/api/preview",
  "/api/draft",
  "/preview",
  "/draft",
]);

/** A cookie whose name says preview or draft, set by an address that asked for no secret. */
const cookieName = (setCookie: string | undefined): string | undefined => {
  for (const part of (setCookie ?? "").split(/,(?=\s*[A-Za-z0-9_.-]+=)/)) {
    const name = part.trim().split("=")[0] ?? "";
    if (name.length <= 80 && /preview|draft/i.test(name)) return name;
  }
  return undefined;
};

export const NO_CONSENT_REASON =
  "this check asks preview routes for a draft cookie with no secret, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

export const remixDraftPublic = defineCheck<PageSnapshot>({
  id: "remix-draft-public",
  size: "S",
  done: "The preview route checks a secret and answers 401 without it.",
  estimateChanges:
    "Several preview routes, or preview tools in the CMS that call the route, need the secret as well.",
  area: "Launch day",
  severity: "high",
  title: "Anyone can switch on Remix preview mode",
  what: "A preview or draft route on this Remix or React Router site sets a preview or draft cookie for a request that carries no secret.",
  why: "Anyone who visits that address sees unpublished content (prices, announcements, pages nobody approved) as if it were live.",
  fix: "Make the loader check a secret (compare a token from the request with one from your environment) before it sets the cookie, and answer 401 otherwise.",
  tech: "Probing check: off unless --owner-consent or gaugeline.consent.json; run only on sites you own or have permission to test. Remix and React Router sites only: one GET per conventional route (/api/preview, /api/draft, /preview, /draft), no secret sent or guessed, never a POST (actions are not called); a Set-Cookie whose name contains preview or draft on any hop is a finding, and only its name is shown. The routes and the cookie rule are conventions, not the frameworks' own (uncited)",
  async run(page, ctx) {
    if (!ctx.fetcher || !ctx.budget || !isRemixSite(page)) return [];
    if (ctx.ownerConsent !== true) {
      ctx.couldNotCheck?.(page.finalUrl, NO_CONSENT_REASON);
      return [];
    }
    const origin = new URL(page.finalUrl).origin;
    const out = [];
    for (const route of ctx.budget.take("draftRoutes", [...REMIX_DRAFT_ROUTES])) {
      const hops = await getOrNull(ctx.fetcher, `${origin}${route}`);
      const cookie = hops
        .map((h) => cookieName(h.headers["set-cookie"]))
        .find((c) => c !== undefined);
      if (!cookie) continue;
      out.push({
        checkId: "remix-draft-public",
        severity: "high" as const,
        title: this.title,
        evidence: `${route} set ${cookie} with no secret`,
        url: page.finalUrl,
      });
    }
    return out;
  },
});
