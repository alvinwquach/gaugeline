import { defineCheck } from "../model.js";
import { isNextSite } from "../next/detect.js";
import { getOrNull } from "../probe.js";
import type { PageSnapshot } from "../snapshot.js";

/** The routes Next.js projects conventionally use to turn draft or preview mode on. */
export const DRAFT_ROUTES: readonly string[] = Object.freeze([
  "/api/draft",
  "/api/preview",
  "/api/draft-mode/enable",
  "/api/enable-draft",
]);

/** The cookies Next.js sets when draft mode (App Router) or preview mode (Pages Router) is on. */
const DRAFT_COOKIE = /(?:^|[\s,;])(__prerender_bypass|__next_preview_data)=/;

export const nextDraftPublic = defineCheck<PageSnapshot>({
  id: "next-draft-public",
  size: "S",
  done: "The draft mode route checks a secret and answers 401 without it.",
  estimateChanges:
    "Several draft routes, or preview tools that call the route, need the secret as well.",
  area: "Launch day",
  severity: "high",
  title: "Anyone can switch on draft mode",
  what: "A draft or preview route on this Next.js site turns draft mode on for a request that carries no secret.",
  why: "Anyone who visits that address sees unpublished content (prices, announcements, pages nobody approved) as if it were live.",
  fix: "Make the route check a secret (compare a token from the request with one from your environment) before it enables draft mode, and return 401 otherwise.",
  tech: "Next.js sites only: one GET per conventional route (/api/draft, /api/preview, /api/draft-mode/enable, /api/enable-draft), no secret sent or guessed; a Set-Cookie of __prerender_bypass or __next_preview_data on any hop is a finding",
  async run(page, ctx) {
    if (!ctx.fetcher || !ctx.budget || !isNextSite(page)) return [];
    const origin = new URL(page.finalUrl).origin;
    const out = [];
    for (const route of ctx.budget.take("draftRoutes", [...DRAFT_ROUTES])) {
      const hops = await getOrNull(ctx.fetcher, `${origin}${route}`);
      const cookie = hops
        .map((h) => DRAFT_COOKIE.exec(h.headers["set-cookie"] ?? "")?.[1])
        .find((c) => c !== undefined);
      if (!cookie) continue;
      out.push({
        checkId: "next-draft-public",
        severity: "high" as const,
        title: this.title,
        evidence: `${route} set ${cookie} with no secret`,
        url: page.finalUrl,
      });
    }
    return out;
  },
});
