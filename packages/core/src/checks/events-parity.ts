import { DESKTOP_VIEWPORT, PHONE_VIEWPORT, judgeParity } from "../events/observation.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { linkName, namedList } from "./events-labels.js";

const D = DESKTOP_VIEWPORT.width;
const P = PHONE_VIEWPORT.width;

/**
 * NAV-09. A tracked link reports on a desktop and not on a phone, or under another name, or with a parameter
 * empty: the plan's numbers are then right for half the visitors. The same click is observed at both widths
 * (the click observer's one run), and the two are compared as plain rules. A link that could not be watched at
 * both widths is could not check: never a pass.
 */
export const eventsParity = defineCheck<PageSnapshot>({
  id: "events-parity",
  size: "S",
  done: "Every tracked link sends the same event, with the same parameters filled, on a phone as on a desktop.",
  estimateChanges:
    "Usually one handler in the mobile menu component, or one tag condition that only matches on a wide screen.",
  area: "Leads",
  severity: "medium",
  title: "A tracked link reports differently on a phone than on a desktop",
  what: "A link your tracking plan lists sends its event at one screen width and not the other, sends a different event name, sends it twice, or fills a parameter at one width and leaves it empty at the other.",
  why: "Many visitors are on a phone. When the phone menu is a separate template, its links often lose the handler or send another name, and the report counts only the desktop: a before-and-after comparison of a new menu then measures the wrong people.",
  fix: "Make the phone menu send the same event as the desktop menu: the same handler or tag on both templates, with the same parameters filled.",
  tech: `Each link the plan lists is clicked once at ${D} px and once at ${P} px in the browser you installed (links only, analytics requests recorded and never delivered; the same observation as events-fire). For each link the plan's event is compared between the two widths: sent or not within 1500 ms, the event name another link-click event was sent under, how many times, whether each parameter the plan lists is filled (compared by kind: text, number, true or false, empty; never by exact text), and which other parameters one width sends and the other does not. A link silent at both widths is events-fire's. A link that could not be clicked at either width is could not check. Needs --renderer playwright: without it, or if the page cannot be loaded at ${P} px, it is could not check`,
  async run(page, ctx) {
    if (!ctx.events || ctx.eventsConfig?.events.length === 0) return [];
    const read = await ctx.events();
    if ("unchecked" in read.result) {
      ctx.couldNotCheck?.(page.finalUrl, read.result.unchecked);
      return [];
    }
    if (read.result.phone === undefined) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        read.result.phoneUnchecked ?? `the plan's links were not read at ${P} px`,
      );
      return [];
    }
    const origin = new URL(page.finalUrl).origin;
    const { rows, notCompared } = judgeParity(read);
    if (notCompared.length > 0)
      ctx.couldNotCheck?.(
        page.finalUrl,
        `${notCompared.length} of the plan's links could not be compared at both widths (${namedList(
          notCompared.map((n) => `${linkName(n.target, origin)} ${n.reason}`),
        )})`,
      );
    return rows.map((row) => ({
      checkId: "events-parity",
      severity: "medium" as const,
      title: this.title,
      evidence: `${linkName(row.target, origin)} reports differently at ${P} px than at ${D} px: ${row.differences.join("; ")}`,
      url: page.finalUrl,
    }));
  },
});
