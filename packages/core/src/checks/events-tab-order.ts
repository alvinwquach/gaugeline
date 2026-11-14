import { judgeFocusOrder, positiveTabindex, tabindexes } from "../events/observation.js";
import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { linkName, namedList, ordinal } from "./events-labels.js";

/**
 * NAV-09. Whether the keyboard reaches the links the plan lists, and in the order they come in the page. A
 * positive tabindex is read from the HTML the run fetched, so it needs no browser. Whether the Tab key reaches
 * each link, and where, is read in the browser at the desktop width: without it, or for a link that could not
 * be watched, that part is could not check, never a pass.
 */
export const eventsTabOrder = defineCheck<PageSnapshot>({
  id: "events-tab-order",
  size: "S",
  done: "Every tracked link can be reached with the Tab key, in the order it comes in the page, with no positive tabindex.",
  estimateChanges:
    "Removing a tabindex or restoring a link's place in the page is a one-line edit in the menu component.",
  area: "Leads",
  severity: "medium",
  title: "A tracked link is hard to reach with the keyboard",
  what: "A link your tracking plan lists is never reached when you press Tab, takes focus in a different place than it comes in the page, or carries a positive tabindex (1 or more), which moves it ahead of every link that has none.",
  why: "Someone who cannot use a mouse moves through the page with the Tab key. A link they cannot reach cannot be used and cannot be tracked, and a link that jumps the queue makes the page's order surprising; a positive tabindex is the usual cause.",
  fix: "Take the positive tabindex off (use no tabindex, or tabindex=0 to make a custom element focusable), keep the links in the order you want them read, and do not remove a link from the Tab order with tabindex=-1 unless something else gives the same action.",
  tech: "The links the plan lists (at most 20) are read in two ways. First, a tabindex of 1 or more on a listed element, read from the HTML as sent (a tabindex a script adds later is not seen here). Second, in the browser you installed at 1280 px, the Tab key is pressed from the top of the page (at most 200 times; nothing else is typed) and the order the listed links take focus in is read: a link never reached is listed, and so is a link whose place in that order differs from its place in the page's HTML (only the links that moved, by the longest run of links that stay in order). The order of the page's HTML stands for the visual order; a layout that moves a link on the screen is not read. A link that could not be clicked at 1280 px, or a keyboard read that could not be made, is could not check. The second part needs --renderer playwright",
  async run(page, ctx) {
    if (!ctx.events || ctx.eventsConfig?.events.length === 0) return [];
    const read = await ctx.events();
    const origin = new URL(page.finalUrl).origin;
    const findings: Finding[] = [];
    const add = (severity: Finding["severity"], evidence: string) =>
      findings.push({
        checkId: "events-tab-order",
        severity,
        title: this.title,
        evidence,
        url: page.finalUrl,
      });
    const count = (n: number, one: string, many: string) =>
      `${n} of the plan's links ${n === 1 ? one : many}`;

    const tabbed = tabindexes(read, page);
    const unreachable: string[] = [];
    const moved: string[] = [];
    if (!("unchecked" in read.result)) {
      if (read.result.focusOrder === undefined) {
        ctx.couldNotCheck?.(
          page.finalUrl,
          read.result.focusUnchecked ?? "the keyboard was not read",
        );
      } else {
        const report = judgeFocusOrder(read, page);
        for (const t of report.unreachable) {
          const v = tabbed.get(t.path);
          unreachable.push(
            linkName(t, origin, v !== undefined && v < 0 ? `tabindex="${v}"` : undefined),
          );
        }
        for (const o of report.outOfOrder)
          moved.push(
            `${linkName(o.target, origin)} is reached ${ordinal(o.focusIndex + 1)} but comes ${ordinal(o.documentIndex + 1)}`,
          );
        if (report.notRead.length > 0)
          ctx.couldNotCheck?.(
            page.finalUrl,
            `${report.notRead.length} of the plan's links could not be looked at with the keyboard (${namedList(
              report.notRead.map((n) => `${linkName(n.target, origin)}: ${n.reason}`),
            )})`,
          );
      }
    } else ctx.couldNotCheck?.(page.finalUrl, read.result.unchecked);

    if (unreachable.length > 0)
      add(
        "medium",
        `${count(unreachable.length, "is", "are")} never reached by the Tab key: ${namedList(unreachable)}`,
      );
    if (moved.length > 0)
      add(
        "low",
        `${count(moved.length, "takes", "take")} focus in a different place than ${moved.length === 1 ? "it comes" : "they come"} in the page: ${namedList(moved)}`,
      );
    const positive = positiveTabindex(read, page)
      .filter((x) => x.target.destination !== undefined)
      .map((x) => `${linkName(x.target, origin)} has tabindex="${x.value}"`);
    if (positive.length > 0)
      add(
        "low",
        `${count(positive.length, "has", "have")} a positive tabindex, which puts ${positive.length === 1 ? "it" : "them"} ahead of every link without one: ${namedList(positive)}`,
      );
    return findings;
  },
});
