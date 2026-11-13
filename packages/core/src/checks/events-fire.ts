import { asSent, observedEvents } from "../events/observe.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { shortUrl } from "./site-helpers.js";

export const eventsFire = defineCheck<PageSnapshot>({
  id: "events-fire",
  size: "M",
  done: "The click handler or tag fires for that element with every parameter the plan names.",
  estimateChanges:
    "The element may have been rebuilt, and the tag manager and the code both need checking.",
  area: "Leads",
  severity: "medium",
  title: "A click your tracking plan expects isn't reported",
  what: "An element in gaugeline.events.json sends no event when clicked, sends it twice, or sends it without a parameter the plan requires.",
  why: "Tracking breaks quietly when templates change: the report for that menu or button just goes empty, and before-and-after comparisons stop meaning anything.",
  fix: "Restore the click handler or tag for that element, and fill every parameter the plan names (for a menu: link text, destination and parent menu).",
  tech: "Each element a plan line selects (a CSS selector, or every link in nav, header, footer or main; at most 20) is clicked in the rendered page with analytics requests intercepted and never delivered, and dataLayer pushes are read for 1500 ms. One push with the event name and every listed parameter filled passes. Needs a rendered read (G39): until then it is could not check",
  async run(page, ctx) {
    // A plan with only attribute rules has no click to wait for.
    if (!ctx.events || ctx.eventsConfig?.events.length === 0) return [];
    const read = await ctx.events();
    if ("unchecked" in read.result) {
      ctx.couldNotCheck?.(page.finalUrl, read.result.unchecked);
      return [];
    }
    const origin = new URL(page.finalUrl).origin;
    return observedEvents(read).flatMap(({ target, rule, verdict }) => {
      const what = `"${target.text}"${target.destination ? ` (${shortUrl(target.destination, origin)})` : ""}`;
      let evidence: string;
      if (verdict.state === "ok") return [];
      if (verdict.state === "silent")
        evidence =
          verdict.lateMs === undefined
            ? `${what} sent no ${rule.event} event`
            : `${what} sent ${rule.event} after ${verdict.lateMs} ms, later than the 1500 ms the check waits`;
      else if (verdict.state === "twice")
        evidence = `${what} sent ${rule.event} ${verdict.count} times: ${asSent(verdict.sent)}`;
      else
        evidence = `${what} sent ${rule.event} without ${verdict.params.join(", ")}: ${asSent(verdict.sent)}`;
      return [
        {
          checkId: "events-fire",
          severity: "medium" as const,
          title: this.title,
          evidence,
          url: page.finalUrl,
        },
      ];
    });
  },
});
