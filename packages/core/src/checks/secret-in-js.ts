import { load } from "cheerio/slim";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { findLeaks } from "./leaks/detectors.js";
import { shortUrl } from "./site-helpers.js";

/** Script types that hold JavaScript (no type, or a JavaScript or module type). */
const JS_TYPE = /^(?:|text\/javascript|application\/javascript|module|text\/ecmascript)$/i;

/** The page's inline scripts, in order. They ship to every visitor like a file does. */
function inlineScripts(page: PageSnapshot): string[] {
  const $ = load(page.hops.at(-1)?.body ?? "");
  return $("script:not([src])")
    .filter((_, el) => JS_TYPE.test(($(el).attr("type") ?? "").trim()))
    .map((_, el) => $(el).text())
    .get();
}

export const secretInJs = defineCheck<PageSnapshot>({
  id: "secret-in-js",
  area: "Security & email",
  severity: "high",
  title: "A private key is in your site's JavaScript",
  what: "A secret key (a Stripe secret or restricted key, a Sanity token, or a long random value named like a secret) is in JavaScript the site sends to every visitor.",
  why: "Anyone can read it in their browser and use it as you: take payments, read customer data or change your content.",
  fix: "Revoke the key in the provider's dashboard now, make a new one, and keep it on the server: never in code the browser loads.",
  tech: "Inline scripts and up to 15 same-site script files (GET, first 5 MB each) matched against the detectors in checks/leaks/detectors.ts; publishable keys (pk_) are ignored; every value is redacted to its first 6 and last 2 characters before a finding exists",
  async run(page, ctx) {
    const origin = new URL(page.finalUrl).origin;
    const sources: { where: string; text: string }[] = inlineScripts(page).map((text, i) => ({
      where: `inline script ${i + 1} on ${shortUrl(page.finalUrl, origin)}`,
      text,
    }));
    for (const s of (await ctx.scripts?.()) ?? [])
      sources.push({ where: shortUrl(s.url, origin), text: s.text });
    return sources.flatMap(({ where, text }) =>
      findLeaks(text).map((leak) => ({
        checkId: "secret-in-js",
        severity: "high" as const,
        title: this.title,
        evidence: `${leak.label} ${leak.redacted} in ${where} at byte ${leak.offset}`,
        url: page.finalUrl,
      })),
    );
  },
});
