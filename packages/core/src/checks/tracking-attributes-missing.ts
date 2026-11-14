import { missingAttributes } from "../events/attributes.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew, shortUrl } from "./site-helpers.js";

/**
 * NAV-05. The attribute rules of gaugeline.events.json, read from the HTML already fetched: no
 * request, nothing clicked. Rule 6 and rule 14: this is a static read of the page's own markup.
 *
 * // [docs] uncited: that a tag manager click trigger can read a data attribute (Google Tag Manager's variable and trigger documentation was not reachable from this session). The check states only what the page has and the plan requires.
 */
export const trackingAttributesMissing = defineCheck<PageSnapshot>({
  id: "tracking-attributes-missing",
  size: "S",
  done: "Every element the plan selects carries each attribute the plan requires, with a value.",
  estimateChanges:
    "Links built by one shared component are one edit; links typed into a template are edited one by one.",
  area: "Leads",
  severity: "medium",
  title: "Some links are missing an attribute your tracking plan requires",
  what: "A link or element that a line under attributes in gaugeline.events.json selects has no value for an attribute the plan requires, such as data-track on every nav link.",
  why: "A tag that reads the attribute to name the click gets nothing for these links, so their clicks go unnamed or unreported and before-and-after comparisons of the menu stop meaning anything.",
  fix: "Add the attribute, with a value, to those links, ideally in the one component or template that renders the menu.",
  tech: "no request. Each attributes line of gaugeline.events.json: every a[href] in the region (nav, header, footer or main, as the click plan reads regions; javascript: links left out), or every element the CSS selector matches. An attribute with no value, or only spaces, is missing. One finding per line, with the count and the first three",
  run(page, ctx) {
    const config = ctx.eventsConfig;
    if (!config || config.attributes.length === 0) return [];
    const origin = new URL(page.finalUrl).origin;
    return missingAttributes(page, config).map((gap) => {
      const names = [...new Set(gap.missing.flatMap((m) => m.attributes))];
      const items = gap.missing.map(
        (m) => `"${m.text}"${m.destination ? ` (${shortUrl(m.destination, origin)})` : ""}`,
      );
      return {
        checkId: "tracking-attributes-missing",
        severity: "medium" as const,
        title: this.title,
        evidence: `${gap.label}: ${gap.missing.length} of ${gap.total} have no ${names.join(", ")}: ${firstFew(items)}`,
        url: page.finalUrl,
      };
    });
  },
});
