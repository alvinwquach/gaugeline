import { defineCheck } from "../model.js";
import { getOrNull } from "../probe.js";
import type { PageSnapshot } from "../snapshot.js";
import { frameworkOf } from "./qwik-solid-shared.js";

/**
 * Routes Qwik City and SolidStart projects conventionally use for a preview or draft switch. Neither
 * framework has a built-in draft mode (checked in the package source), so these names and the cookie
 * rule are conventions of CMS starters: uncited.
 */
export const QWIK_SOLID_DRAFT_ROUTES: readonly string[] = Object.freeze([
  "/api/preview",
  "/api/draft",
  "/preview",
  "/draft",
]);

const cookieName = (setCookie: string | undefined): string | undefined => {
  for (const part of (setCookie ?? "").split(/,(?=\s*[A-Za-z0-9_.-]+=)/)) {
    const name = part.trim().split("=")[0] ?? "";
    if (name.length <= 80 && /preview|draft/i.test(name)) return name;
  }
  return undefined;
};

export const NO_CONSENT_REASON =
  "this check asks preview routes for a draft cookie with no secret, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

export const qwikSolidDraftPublic = defineCheck<PageSnapshot>({
  id: "qwik-solid-draft-public",
  size: "S",
  done: "The preview route checks a secret and answers 401 without it.",
  estimateChanges:
    "Several preview routes, or preview tools in the CMS that call the route, need the secret as well.",
  area: "Launch day",
  severity: "high",
  title: "Anyone can switch on preview mode",
  what: "A preview or draft route on this Qwik or SolidStart site sets a preview or draft cookie for a request that carries no secret.",
  why: "Anyone who visits that address sees unpublished content (prices, announcements, pages nobody approved) as if it were live.",
  fix: "Make the route check a secret (compare a token from the request with one from your environment) before it sets the cookie, and answer 401 otherwise.",
  tech: "Probing check: off unless --owner-consent or gaugeline.consent.json; run only on sites you own or have permission to test. Qwik and SolidStart sites only: one GET per conventional route (/api/preview, /api/draft, /preview, /draft), no secret sent or guessed; a Set-Cookie whose name contains preview or draft on any hop is a finding, and only its name is shown. The routes and the cookie rule are conventions, not the frameworks' own (uncited)",
  async run(page, ctx) {
    if (!ctx.fetcher || !ctx.budget || frameworkOf(page) === undefined) return [];
    if (ctx.ownerConsent !== true) {
      ctx.couldNotCheck?.(page.finalUrl, NO_CONSENT_REASON);
      return [];
    }
    const origin = new URL(page.finalUrl).origin;
    const out = [];
    for (const route of ctx.budget.take("draftRoutes", [...QWIK_SOLID_DRAFT_ROUTES])) {
      const hops = await getOrNull(ctx.fetcher, `${origin}${route}`);
      const cookie = hops
        .map((h) => cookieName(h.headers["set-cookie"]))
        .find((c) => c !== undefined);
      if (!cookie) continue;
      out.push({
        checkId: "qwik-solid-draft-public",
        severity: "high" as const,
        title: this.title,
        evidence: `${route} set ${cookie} with no secret`,
        url: page.finalUrl,
      });
    }
    return out;
  },
});
