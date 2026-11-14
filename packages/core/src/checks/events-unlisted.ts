import { EVENT_WAIT_MS, NO_OBSERVER, eventsOf } from "../events/observe.js";
import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { shortUrl } from "./site-helpers.js";

/** The tag manager's own events (gtm.js, gtm.click, gtm.linkClick): they are not the site's events. */
const OWN = /^gtm\./;

/**
 * NAV-06. The other half of the tracking spec: events the click sent that no line of the plan names.
 * The observer is the same seam events-fire reads, so without one this is could-not-check, never a
 * pass; the spec's events that never fire are events-fire's (a silent element).
 */
export const eventsUnlisted = defineCheck<PageSnapshot>({
  id: "events-unlisted",
  size: "S",
  done: "Every event a click sends is one the tracking plan lists, or the plan is updated to list it.",
  estimateChanges:
    "Often one tag in the tag manager; an event that was added on purpose is a row in the plan.",
  area: "Leads",
  severity: "low",
  title: "A click sends an event your tracking plan does not list",
  what: "Clicking an element the plan selects makes the page push an event to dataLayer whose name no line of gaugeline.events.json (or the CSV spec) lists.",
  why: "An event nobody planned is usually a tag someone added or a second install: the numbers it feeds are not the ones the plan describes, and a before-and-after comparison cannot tell the two apart.",
  fix: "Add the event to the plan if it is wanted, or remove the tag or handler that sends it.",
  tech: `Each element a plan line selects is clicked in the rendered page with analytics requests intercepted and never delivered (the same read as events-fire, at most 20 elements), and the dataLayer pushes within ${EVENT_WAIT_MS} ms are read. A pushed event name that no events line names is listed; the tag manager's own gtm.* events and pushes with no event name are left out; the same event on several links is one finding. The spec's events that never fire are events-fire's. Needs a rendered read (G39): until then it is could not check`,
  async run(page, ctx) {
    if (!ctx.events || ctx.eventsConfig?.events.length === 0) return [];
    const read = await ctx.events();
    if ("unchecked" in read.result) {
      ctx.couldNotCheck?.(page.finalUrl, read.result.unchecked || NO_OBSERVER);
      return [];
    }
    const listed = new Set(read.config.events.map((e) => e.event));
    const origin = new URL(page.finalUrl).origin;
    const byEvent = new Map<string, { what: string; sent: Record<string, unknown> }[]>();
    for (const click of read.result.clicks) {
      const target = read.targets.find((t) => t.path === click.path);
      if (!target) continue;
      const what = `"${target.text}"${target.destination ? ` (${shortUrl(target.destination, origin)})` : ""}`;
      const seen = new Set<string>();
      for (const p of eventsOf(click)) {
        const name = p.data.event;
        if (typeof name !== "string" || name === "" || p.atMs > EVENT_WAIT_MS) continue;
        if (listed.has(name) || OWN.test(name) || seen.has(name)) continue;
        seen.add(name);
        byEvent.set(name, [...(byEvent.get(name) ?? []), { what, sent: p.data }]);
      }
    }
    const out: Finding[] = [];
    for (const [name, items] of byEvent) {
      const first = items[0];
      out.push({
        checkId: "events-unlisted",
        severity: "low",
        title: this.title,
        evidence:
          items.length === 1 && first
            ? `${first.what} sent ${name}, which is not in the plan: ${JSON.stringify(first.sent)}`
            : `${items.length} links sent ${name}, which is not in the plan: ${items.map((i) => i.what).join(", ")}`,
        url: page.finalUrl,
      });
    }
    return out;
  },
});
