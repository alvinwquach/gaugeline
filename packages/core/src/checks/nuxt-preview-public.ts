import { defineCheck } from "../model.js";
import { LIMITS } from "../limits.js";
import { isNuxtSite } from "../nuxt/detect.js";
import { readNuxtState } from "../nuxt/read.js";
import { findDataScript, parseFlat, previewState } from "../nuxt/state.js";
import { getOrNull } from "../probe.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

/** The token the probe sends: a fixed word that is not a secret and opens nothing. */
export const PREVIEW_PROBE_TOKEN = "gaugeline-probe";

export const NO_PREVIEW_CONSENT_REASON =
  "this check asks a page once with Nuxt's preview query (?preview=true), so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

export const nuxtPreviewPublic = defineCheck<PageSnapshot>({
  id: "nuxt-preview-public",
  size: "S",
  done: "A request with ?preview=true and no secret is rendered as an ordinary page: usePreviewMode only turns on after the app checks a secret.",
  estimateChanges:
    "Often one shouldEnable function that compares a token from the request with one in runtimeConfig. Allow longer if preview links are shared with editors who then need the token.",
  area: "Launch day",
  severity: "high",
  title: "Anyone can switch on Nuxt preview mode",
  what: "This Nuxt page, asked with ?preview=true and no secret, is rendered on the server with preview mode switched on (the page's own state says enabled: true).",
  why: "Pages that show unpublished content in preview mode (prices before an announcement, drafts nobody approved) show it to anyone who adds the query to the address.",
  fix: "Give usePreviewMode a shouldEnable that checks a secret (compare a token from the request with one from runtimeConfig, server side) and returns false otherwise, and fetch draft content only from server routes that check the same secret.",
  tech: `probing check, off without --owner-consent: Nuxt sites only; one GET of the page's own address with ?preview=true&token=${PREVIEW_PROBE_TOKEN} (the documented default query of usePreviewMode; the token is a fixed word, not a secret), at most ${LIMITS.nuxtAddresses} Nuxt addresses per run, no cookie and no header added; the answer's __NUXT_DATA__ is read as a flat JSON array and its $s_preview-state useState value is looked at for enabled being true. A page that never sends that state, a cached copy that ignores the query, a payload held in a separate file or one that is cut or not JSON is could-not-check, never a pass. The preview state's contents are never shown`,
  async run(page, ctx) {
    if (!isNuxtSite(page) || !isHtmlPage(page)) return [];
    if (ctx.ownerConsent !== true) {
      ctx.couldNotCheck?.(page.finalUrl, NO_PREVIEW_CONSENT_REASON);
      return [];
    }
    if (!ctx.fetcher || !ctx.budget) return [];
    const base = await readNuxtState(page, ctx);
    const already = base.flats.some((f) => previewState(f) === "on");
    const url = new URL(page.finalUrl);
    url.searchParams.set("preview", "true");
    url.searchParams.set("token", PREVIEW_PROBE_TOKEN);
    if (ctx.budget.take("nuxtAddresses", [url.href]).length === 0) {
      ctx.couldNotCheck?.(page.finalUrl, "left out by the limit on Nuxt addresses");
      return [];
    }
    const hop = (await getOrNull(ctx.fetcher, url.href)).at(-1);
    if (!hop) {
      ctx.couldNotCheck?.(page.finalUrl, "the preview request did not answer");
      return [];
    }
    if (hop.status !== 200 || !/html/i.test(hop.headers["content-type"] ?? "text/html")) {
      ctx.couldNotCheck?.(page.finalUrl, `the preview request answered ${hop.status}, not a page`);
      return [];
    }
    const script = findDataScript(hop.body ?? "", hop.truncated === true);
    let state: "on" | "off" | "unknown" = "unknown";
    let why = "the response has no data script, so preview mode cannot be told";
    if (script.kind === "unread") why = script.reason;
    else if (script.kind === "external") why = "its state is held in a separate payload file";
    else if (script.kind === "inline") {
      const parsed = parseFlat(script.text);
      if ("reason" in parsed) why = parsed.reason;
      else {
        state = previewState(parsed.flat);
        if (state === "unknown")
          why =
            "the response carries no preview state: this page may never call usePreviewMode while rendering, or a cached copy ignored the query";
      }
    }
    if (state === "unknown") {
      ctx.couldNotCheck?.(page.finalUrl, why);
      return [];
    }
    if (state !== "on") return [];
    return [
      {
        checkId: "nuxt-preview-public",
        severity: "high",
        title: this.title,
        evidence: already
          ? "the page is rendered with preview mode on for an ordinary request"
          : "asked with ?preview=true and no secret, the page was rendered with preview mode on (enabled: true)",
        url: page.finalUrl,
      },
    ];
  },
});
