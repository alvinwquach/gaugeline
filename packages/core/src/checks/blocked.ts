import { defineCheck } from "../model.js";
import { classifyHop, describeRefusal } from "../refusal.js";
import type { PageSnapshot } from "../snapshot.js";

export const blocked = defineCheck<PageSnapshot>({
  id: "blocked",
  size: "S",
  done: "The site lets crawlers read the page, or the block is accepted as on purpose.",
  estimateChanges:
    "A firewall or bot-protection setting on a host you do not control is a support request.",
  area: "Search & sharing",
  severity: "low",
  title: "The site wouldn't let Gaugeline read the page",
  what: "The page answered with a refusal (401, 403, 429, 503 with Retry-After) or a bot-challenge page instead of its content.",
  why: "A firewall or bot protection is in front of the site. That isn't a broken site, but it can also stop search engines' and AI assistants' crawlers, and nothing else could be checked.",
  fix: "If the site should be readable by crawlers, allow them in the firewall or bot-protection settings. Gaugeline never retries or disguises itself to get through.",
  tech: "The final answer for the page is 401, 403, 429, 503 with a Retry-After header, or a 200 under 60 words with a known challenge marker (Just a moment, Attention Required, cf-chl, a captcha form). Every check that needs the page is then listed as could not check; only robots.txt and DNS checks run",
  run(page) {
    const outcome = classifyHop(page.hops.at(-1));
    if (outcome.kind !== "refused") return [];
    return [
      {
        checkId: "blocked",
        severity: "low",
        title: this.title,
        evidence: `${page.finalUrl} answered ${outcome.status}: it ${outcome.reason === "challenge" ? "showed a bot challenge page" : outcome.reason === "rate-limit" ? "asked automated readers to slow down" : "refuses automated readers"}, so the page was not checked`,
        url: page.finalUrl,
      },
    ];
  },
});

/** Checks that need no page: they read robots.txt, DNS or a database, so they still run when the page is refused. */
export const NO_PAGE_CHECKS: readonly string[] = Object.freeze([
  "blocked",
  "robots-block",
  "ai-crawlers-blocked",
  "email-spf-missing",
  "email-spf-multiple",
  "email-dmarc-missing",
  "email-dmarc-none",
  "data-assertion-failed",
]);

export { describeRefusal };
