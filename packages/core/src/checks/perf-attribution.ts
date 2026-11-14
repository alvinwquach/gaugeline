import type { CheckContext, Finding } from "../model.js";
import { defineCheck } from "../model.js";
import {
  attributeSpeed,
  type Measure,
  type Move,
  type VariantName,
  VARIANT_NAMES,
} from "../render/attribution.js";
import type { RenderRequest, RenderResult, RenderedPage } from "../render/types.js";
import type { PageSnapshot } from "../snapshot.js";
import { escapeInvisible } from "./hidden-text/escape.js";

const clip = (text: string): string => escapeInvisible(text, 120);

/** What each load takes away, as the request to the renderer says it. */
const REQUESTS: Record<VariantName, Pick<RenderRequest, "variant">> = {
  "reduced-motion": { variant: { reducedMotion: true } },
  "no-javascript": { variant: { javaScript: false } },
  "no-third-party": { variant: { blockThirdPartyScripts: true } },
};

const WITH: Record<VariantName, string> = {
  "reduced-motion": "With reduced motion forced",
  "no-javascript": "With JavaScript off",
  "no-third-party": "With scripts from other sites blocked",
};

const METRIC_NAME = { lcp: "Largest Contentful Paint", tbt: "total blocking time" } as const;

/** Without JavaScript a page may show far less; under this share of its text, the timings are not like for like. */
const SAME_PAGE_SHARE = 0.5;

const textLength = (page: RenderedPage): number => String(page.text ?? "").length;

function describeMove(m: Move): string {
  const name = m.metric === "lcp" ? "Largest Contentful Paint" : "total blocking time";
  const size = Math.abs(m.change);
  return `${WITH[m.variant]}, ${name} went from ${m.from} ms to ${m.to} ms (${size} ms ${m.change < 0 ? "faster" : "slower"}; the two plain loads differed by ${m.noise} ms). Measured in this computer's browser, unthrottled: compare the changes with each other, not with Lighthouse.`;
}

export const perfAttribution = defineCheck<PageSnapshot>({
  id: "perf-attribution",
  size: "M",
  done: "Running Gaugeline again with --attribution shows no change (reduced motion, no JavaScript, no scripts from other sites) that moves total blocking time or Largest Contentful Paint by more than the page's own spread, or the owner has decided with the developer that the ones listed are acceptable.",
  estimateChanges:
    "An hour to read the numbers and find the one script, tag or intro animation behind them; the fix is the usual one for that cause (delay or remove a third-party tag, shorten the long script, skip the intro for visitors who asked for less motion).",
  area: "Visitors",
  severity: "low",
  title: "Which change moves the page's blocking time or Largest Contentful Paint (advice)",
  what: "The page is loaded in a browser on this computer as it is (twice, to see how much two identical loads differ) and again with reduced motion forced, with JavaScript off and with scripts from other sites blocked. A change that moves total blocking time or Largest Contentful Paint by more than the page's own spread, 10% and a floor is listed with how much it moved.",
  why: "Knowing that a speed problem goes away when third-party scripts are blocked, or that a page waits for an intro animation a visitor who asked for less motion would never see, says where to look first. It is a lab measure from one computer, unthrottled: it says which change matters, not what visitors experienced.",
  fix: "Look at what the change removed. Blocking time that disappears without third-party scripts points at a tag, widget or chat script: load it later or drop it. A paint that gets sooner with reduced motion points at an animation or intro the page waits for: do not hold content back for it. A paint that gets sooner without JavaScript means the page waits for a script to show its main content: render that content on the server.",
  tech: "Only with --attribution and --renderer playwright. The checked page is rendered five times, one after the other, in the browser you installed: twice as it is, then with prefers-reduced-motion forced, with JavaScript off, and with scripts from another site (another registrable domain, judged on the address and on every redirect hop) refused, which counts towards the request cap and is never requested. Largest Contentful Paint is the browser's last candidate, measured in milliseconds from just before the load was started, through the DevTools timeline; total blocking time is the time every long task spent over 50 ms from the start, never more than the load took, collected by an observer our script creates before the page's own scripts run, and not measured with JavaScript off (no script runs, so it is could-not-check for that change, never 0). A change is reported when it is larger than the two plain loads' spread, than 200 ms (100 ms for blocking time) and than 10% of their mean, as low-severity advice, in the order reduced motion, JavaScript, third-party. A page that shows under half its text without JavaScript is not compared for that change. Speed Index is not measured: it needs a video of the load. A load that fails, a missing timing or no browser is could-not-check. The five loads count towards the run's cap of 10 rendered pages, and the numbers are this computer's and unthrottled. A hostile page can call the measurement function itself and lie to its own measurement: reports that cannot be real (too many, under 50 ms, longer than the load, more in all than the load took) make the page's blocking time could-not-check, but a page that invents plausible tasks, or holds the thread unseen, is not caught. This is advice for the owner of a site who runs it on their own site, not a security boundary, and a finding says what the browser saw",
  async run(page, ctx: CheckContext) {
    const url = page.finalUrl;
    const render = ctx.render;
    if (!render) {
      ctx.couldNotCheck?.(
        url,
        "Attribution needs a browser: run with --renderer playwright as well as --attribution.",
      );
      return [];
    }
    const timed = async (
      request: Pick<RenderRequest, "variant" | "measure">,
      what: string,
    ): Promise<RenderedPage | undefined> => {
      const r: RenderResult = await render(request);
      if (r.kind === "could-not-check") {
        ctx.couldNotCheck?.(url, `The page ${what} could not be loaded: ${clip(r.reason)}.`);
        return undefined;
      }
      if (!r.performance) {
        ctx.couldNotCheck?.(
          url,
          `The browser gave no timings for the page ${what}, so it was not compared.`,
        );
        return undefined;
      }
      if (r.performance.tampered)
        ctx.couldNotCheck?.(
          url,
          `The page ${what} reported long tasks that cannot be real, so its blocking time was not compared.`,
        );
      return r;
    };
    // The plain load twice: how far two identical loads differ is the least a change must beat.
    const baselines: RenderedPage[] = [];
    for (const sample of [0, 1]) {
      const r = await timed({ measure: { sample } }, "as it is");
      if (!r) return [];
      baselines.push(r);
    }
    const first = baselines[0] as RenderedPage;
    const measured: Partial<Record<VariantName, Measure>> = {};
    for (const name of VARIANT_NAMES) {
      const r = await timed(
        { ...REQUESTS[name], measure: { sample: 0 } },
        WITH[name].toLowerCase(),
      );
      if (!r) continue;
      if (name === "no-javascript" && textLength(r) < textLength(first) * SAME_PAGE_SHARE) {
        ctx.couldNotCheck?.(
          url,
          `The page shows much less without JavaScript (${textLength(r)} of ${textLength(first)} characters of text), so its timings with JavaScript off are not comparable and were left out.`,
        );
        continue;
      }
      measured[name] = r.performance;
    }
    const { moves, unmeasured } = attributeSpeed(
      baselines.map((b) => b.performance ?? {}),
      measured,
    );
    // Only numbers the page produced and a load that was made are explained; a load that failed was said above.
    const made = new Set(Object.keys(measured));
    for (const metric of ["lcp", "tbt"] as const) {
      const where = unmeasured.filter(
        (u) =>
          u.metric === metric &&
          made.has(u.variant) &&
          !(u.variant === "no-javascript" && metric === "tbt"),
      );
      if (where.length > 0)
        ctx.couldNotCheck?.(
          url,
          `${METRIC_NAME[metric][0]?.toUpperCase()}${METRIC_NAME[metric].slice(1)} could not be compared (${[...new Set(where.map((w) => w.variant))].join(", ")}): the browser reported none.`,
        );
    }
    if (made.has("no-javascript"))
      ctx.couldNotCheck?.(
        url,
        "Total blocking time is not measured with JavaScript off: no script runs, so there are no long tasks to observe, and it is not compared.",
      );
    ctx.couldNotCheck?.(
      url,
      "Speed Index was not measured: it needs a video of the page loading, which Gaugeline does not record.",
    );
    return moves.map((m): Finding => ({
      checkId: "perf-attribution",
      severity: "low",
      title: this.title,
      evidence: describeMove(m),
      url: clip(url),
    }));
  },
});

export const ATTRIBUTION_CHECKS = [perfAttribution] as const;
