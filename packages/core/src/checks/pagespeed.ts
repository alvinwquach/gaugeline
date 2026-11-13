import type { CheckContext, Finding } from "../model.js";
import { defineCheck } from "../model.js";
import { PAGESPEED_PAGE_CAP, sendableAddress } from "../pagespeed/reader.js";
import { VITALS, VITAL_IDS, type FieldMetric, type VitalId } from "../pagespeed/vitals.js";
import type { PageSnapshot } from "../snapshot.js";
import { escapeInvisible } from "./hidden-text/escape.js";

const clip = (text: string): string => escapeInvisible(text, 120);

/** Lighthouse's own "good" band starts at 90; a lab score under it is worth a line of advice, nothing more. */
const LAB_ADVICE_BELOW = 90;

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`;
const limit = (id: VitalId, value: number): string =>
  id === "cls" ? String(value) : value >= 1000 ? seconds(value) : `${value} ms`;
const percent = (permille: number): string =>
  permille % 10 === 0 ? `${permille / 10}%` : `${(permille / 10).toFixed(1)}%`;

/**
 * The pages a run sends to PageSpeed Insights: the checked page, then the same-site pages of the run's sample, in
 * the order the run has them, each address once, at most PAGESPEED_PAGE_CAP. The same pages give the same list.
 */
async function keyPages(
  page: PageSnapshot,
  ctx: CheckContext,
): Promise<{ urls: string[]; left: number }> {
  const seen = new Set<string>();
  const urls: string[] = [];
  let left = 0;
  const others = ctx.pages ? await ctx.pages().catch(() => []) : [];
  for (const p of [page, ...others]) {
    const sendable = sendableAddress(p.finalUrl);
    const key = sendable.ok ? sendable.url : p.finalUrl;
    if (seen.has(key)) continue;
    seen.add(key);
    if (urls.length < PAGESPEED_PAGE_CAP) urls.push(p.finalUrl);
    else left += 1;
  }
  return { urls, left };
}

function describe(m: FieldMetric): string {
  const v = VITALS[m.id];
  const verdict = m.verdict === "poor" ? "is poor" : "needs improvement";
  const best = m.id === "cls" ? "or lower" : "or faster";
  const worst = m.id === "cls" ? "were worse than" : "took longer than";
  return `${v.name} ${verdict}. ${percent(m.goodPermille)} of loads were ${limit(m.id, v.good)} ${best}; 75% are needed. ${percent(m.poorPermille)} ${worst} ${limit(m.id, v.poor)}.`;
}

function fieldEvidence(url: string, m: FieldMetric, scope: "page" | "origin"): string {
  const who =
    scope === "origin"
      ? "the whole site's visitors, because this page has too few of its own; Chrome, 75th percentile"
      : "Chrome, 75th percentile";
  return `Real visitors (${who}), ${clip(url)}: ${describe(m)}`;
}

export const pagespeedFieldVitals = defineCheck<PageSnapshot>({
  id: "pagespeed-field-vitals",
  size: "L",
  done: "Real visitors' 75th-percentile Largest Contentful Paint, Interaction to Next Paint and Cumulative Layout Shift are all in web.dev's good range, as Google's PageSpeed Insights reports them for the page; running Gaugeline with --pagespeed again shows the shares.",
  estimateChanges:
    "A day or two for one slow image, a late font or a layout shift from an ad or embed with no reserved space. A week or more when the cause is the framework, a tag manager full of tags or a plugin stack, and it has to be measured after each change.",
  area: "Visitors",
  severity: "medium",
  title: "Real visitors' Core Web Vitals are not all good on a page",
  what: "Google's PageSpeed Insights reports, from real Chrome visitors, that fewer than 75% of loads of a page have a good Largest Contentful Paint, Interaction to Next Paint or Cumulative Layout Shift.",
  why: "These are what visitors actually lived through, measured by their own browsers, and Google uses them as a ranking signal. A page that feels slow or jumps as it loads loses visitors before they read it, and the cost is greatest on phones and slow connections.",
  fix: "Start with the vital that is poor. Largest Contentful Paint: make the biggest image or heading on the page small and load it first (the lab advice shows how long it takes). Interaction to Next Paint: break up long scripts and remove tags that run on every click. Cumulative Layout Shift: give images, embeds and ads a width and height so nothing jumps. Real-user figures move over weeks, so judge a fix after a few weeks of visits.",
  tech: "Only with --pagespeed. One GET per page to pagespeedonline.googleapis.com (strategy MOBILE, category PERFORMANCE; no key and no other host or method) for the checked page and the first same-site pages of the run's sample, at most 5. The page's address without its query string, fragment, user name or path parameter is sent to Google, and only a public page's: nothing is sent with --allow-private, and a numeric address, a name with no dot or a reserved or private-use ending (a trailing dot dropped), a wildcard-DNS name, a name that resolves to any private, loopback, link-local or metadata address (or does not resolve) and a path that is not made of plain lowercase word-like parts (at most 6 and 120 characters) are never sent and are could-not-check. The calls go one at a time. The Chrome UX Report's figures in the answer decide: a vital is good when at least 75% of loads (the raw share, not rounded) are in the good bucket (the 75th percentile is within web.dev's limit: 2.5 s, 200 ms, 0.1) and poor when more than 25% are in the poor bucket (over 4 s, 500 ms, 0.25); the answer's own percentile value is not used. Poor is medium, needs improvement is low. Lab scores never decide. A page with too few visitors uses the whole site's figures and says so; no real-user data, a vital that is missing or whose buckets are not those limits, a refusal (HTTP 429 when the shared keyless quota is used up) and an unreachable Google are could-not-check, never a pass. The same answers give the same findings",
  async run(page, ctx) {
    const pageSpeed = ctx.pageSpeed;
    if (!pageSpeed) return [];
    const { urls, left } = await keyPages(page, ctx);
    const reads = await Promise.all(urls.map((u) => pageSpeed.read(u)));
    const out: Finding[] = [];
    urls.forEach((url, i) => {
      const read = reads[i];
      if (!read) return;
      if (!read.ok) {
        ctx.couldNotCheck?.(url, read.reason);
        return;
      }
      const field = read.answer.field;
      if (field.kind === "none") {
        ctx.couldNotCheck?.(url, field.reason);
        return;
      }
      for (const id of field.missing)
        ctx.couldNotCheck?.(
          url,
          `Google's real-user data for this page has no ${VITALS[id].name}, so it was not judged.`,
        );
      for (const u of field.unreadable)
        ctx.couldNotCheck?.(
          url,
          `Google's real-user data for ${VITALS[u.id].name} could not be read (${u.why}), so it was not judged.`,
        );
      for (const id of VITAL_IDS) {
        const m = field.metrics.find((x) => x.id === id);
        if (!m || m.verdict === "good") continue;
        out.push({
          checkId: "pagespeed-field-vitals",
          severity: m.verdict === "poor" ? "medium" : "low",
          title: this.title,
          evidence: fieldEvidence(url, m, field.scope),
          url: clip(url),
        });
      }
    });
    if (left > 0)
      ctx.couldNotCheck?.(
        page.finalUrl,
        `${left} more ${left === 1 ? "page was" : "pages were"} not sent to Google: at most ${PAGESPEED_PAGE_CAP} are.`,
      );
    return out;
  },
});

export const pagespeedLabAdvice = defineCheck<PageSnapshot>({
  id: "pagespeed-lab-advice",
  size: "M",
  done: "Lighthouse's simulated-phone performance score for the page is 90 or more, or the owner has decided with the developer that the lower score is acceptable because real visitors' figures are good.",
  estimateChanges:
    "An hour to read the numbers and find the one script or image behind them. The fixes are the same as for real visitors' figures.",
  area: "Visitors",
  severity: "low",
  title: "A simulated phone load of a page scores under 90 (advice, not a verdict)",
  what: "Lighthouse, run by Google's PageSpeed Insights on a simulated mid-range phone with a throttled connection, scores a page's performance under 90 out of 100. This is a lab test of one load, kept apart from what real visitors measured.",
  why: "A lab run is repeatable, so it shows where time goes (largest contentful paint, total blocking time, layout shift, speed index) and whether a change helped. It is not what visitors experienced: a page can score badly in the lab and be fine for real people, or the reverse, so it never decides pass or fail.",
  fix: "Use it to find the cause once real visitors' figures say there is a problem: the largest element, the long scripts behind total blocking time, and what moves the layout. Do not chase the score on its own.",
  tech: "Only with --pagespeed, from the same one GET per page as pagespeed-field-vitals (Lighthouse, mobile, performance category, run on Google's servers; Gaugeline runs no browser for it). A score under 90 is one low-severity finding with the score, largest contentful paint, total blocking time, layout shift and speed index as Lighthouse reports them. It is advice and never a pass or a fail; an answer with no Lighthouse run is could-not-check. A failed read is reported once, by pagespeed-field-vitals",
  async run(page, ctx) {
    const pageSpeed = ctx.pageSpeed;
    if (!pageSpeed) return [];
    const { urls } = await keyPages(page, ctx);
    const reads = await Promise.all(urls.map((u) => pageSpeed.read(u)));
    const out: Finding[] = [];
    urls.forEach((url, i) => {
      const read = reads[i];
      if (!read?.ok) return;
      const lab = read.answer.lab;
      if (lab.kind === "none") {
        ctx.couldNotCheck?.(url, lab.reason);
        return;
      }
      if (lab.score >= LAB_ADVICE_BELOW) return;
      const numbers = [
        lab.lcpMs === undefined ? undefined : `largest contentful paint ${seconds(lab.lcpMs)}`,
        lab.tbtMs === undefined ? undefined : `total blocking time ${lab.tbtMs} ms`,
        lab.clsThousandths === undefined ? undefined : `layout shift ${lab.clsThousandths / 1000}`,
        lab.speedIndexMs === undefined ? undefined : `speed index ${seconds(lab.speedIndexMs)}`,
      ].filter((n): n is string => n !== undefined);
      out.push({
        checkId: "pagespeed-lab-advice",
        severity: "low",
        title: this.title,
        evidence: `Lab run, not real visitors: Lighthouse on Google's servers scored ${clip(url)} ${lab.score} out of 100 on a simulated phone${numbers.length > 0 ? ` (${numbers.join(", ")})` : ""}. Advice only: one simulated load never passes or fails a page.`,
        url: clip(url),
      });
    });
    return out;
  },
});

export const PAGESPEED_CHECKS = [pagespeedFieldVitals, pagespeedLabAdvice] as const;
