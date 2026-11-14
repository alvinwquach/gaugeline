import type { CheckContext, Finding } from "../model.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { containerIds, findTrackers, type Tracker } from "../trackers/fingerprints.js";
import { CONTAINER_CAP } from "../trackers/reader.js";
import { sensitiveReason } from "../trackers/sensitive.js";
import { escapeInvisible } from "./hidden-text/escape.js";

const clip = (text: string): string => escapeInvisible(text, 120);

/** "Meta pixel (id 1234567890)", "Meta pixel (ids 1, 2)" or "Meta pixel" when no id is in the page's code. */
export function describeTracker(t: Pick<Tracker, "label" | "ids">): string {
  if (t.ids.length === 0) return t.label;
  return `${t.label} (${t.ids.length === 1 ? "id" : "ids"} ${t.ids.map((i) => clip(i)).join(", ")})`;
}

const pathOf = (page: PageSnapshot): string => new URL(page.finalUrl).pathname;

/** Why this page counts, or undefined: also the gate for both checks. Without --trackers they do nothing. */
function reasonFor(page: PageSnapshot, ctx: CheckContext): string | undefined {
  if (!ctx.trackers) return undefined;
  return sensitiveReason(page, ctx.trackers.config.sensitivePaths ?? []);
}

export const trackerOnSensitivePage = defineCheck<PageSnapshot>({
  id: "tracker-on-sensitive-page",
  size: "M",
  done: "The client has seen the list of trackers on this page, with their ids, and has decided with their own counsel which stay; running Gaugeline again shows the list they chose.",
  estimateChanges:
    "An hour to go through the list with the client. More when a tag manager adds trackers that have to be taken out one by one, or the form service's own tracking cannot be turned off.",
  area: "Security & email",
  severity: "low",
  title: "Trackers load on a page with a form or a listed path",
  what: "Gaugeline lists the advertising pixels, analytics, session replay tools and tag managers that load on a page with a form, an embedded form service or a path you listed as sensitive, with the id each one carries.",
  why: "A form or a page about a health condition, a booking or an intake is where visitors share details, and anything that loads there can receive information about the visit. Clients are often surprised to find what the site loads. This is a list of facts: whether any of it is allowed is for the client and their own counsel to decide, and Gaugeline does not say.",
  fix: "Show the client the list. For each tracker, ask who set it up and what it is for; where it is not needed on this page, move it out of the page template or restrict it in the tag manager. For the question of whether a tracker is allowed here, the client should ask their own counsel.",
  tech: 'Only with --trackers. A page counts when it has a form that collects details (a search box, a GET form whose visible fields are named like a search, does not count), an embedded form service, or a path listed under "sensitivePaths" in gaugeline.trackers.json. Trackers are read from the script addresses and inline scripts in the HTML (and the noscript fallback tags) by a fixed table of patterns: Meta pixel, TikTok pixel, LinkedIn Insight Tag, Google Analytics 4, Google Tag Manager, five session replay tools (Hotjar, Microsoft Clarity, FullStory, LogRocket, Mouseflow) and the tracking code of HubSpot, Pardot and Marketo. Each finding shows the kind and the id the page\'s own code carries, never page content or a form field. A tag a script adds after the page loads is not seen (a run that fires scripts is a later branch); the same page gives the same findings',
  run(page, ctx) {
    const reason = reasonFor(page, ctx);
    if (reason === undefined) return [];
    return findTrackers(page).map((t): Finding => ({
      checkId: "tracker-on-sensitive-page",
      severity: "low",
      title: this.title,
      evidence: `${describeTracker(t)} ${t.how === "script" ? "loads on" : "is in the HTML of"} ${clip(pathOf(page))}, ${reason}`,
      url: clip(page.finalUrl),
    }));
  },
});

export const trackerInTagManager = defineCheck<PageSnapshot>({
  id: "tracker-in-tag-manager",
  size: "M",
  done: "The client has seen what each Tag Manager container on this page holds and has decided with their own counsel which tags stay; running Gaugeline again shows the list they chose.",
  estimateChanges:
    "An hour in the Tag Manager workspace per container, with the client. More when tags are built from templates and the triggers are long.",
  area: "Security & email",
  severity: "low",
  title: "A Tag Manager container on a page with a form or a listed path holds trackers",
  what: "A Google Tag Manager container loads on a page with a form, an embedded form service or a path you listed as sensitive, and its public file contains tracker ids (Meta, TikTok, LinkedIn, session replay, Google Analytics 4).",
  why: "A tag manager hides what the page loads: the page's own code shows one container id, and the trackers are inside it. They are the same kind of fact as the ones in the page's code, and the same question for the client and their own counsel. Gaugeline lists them and does not say whether any is allowed.",
  fix: "Open the container in Tag Manager and look at the tags the finding names and their triggers. Where a tracker is not needed on this page, change its trigger so it does not fire here, or remove it. For the question of whether a tracker is allowed here, the client should ask their own counsel.",
  tech: "Only with --trackers, on the pages the first check counts. The container's public file (GET www.googletagmanager.com/gtm.js?id=GTM-XXXX, the file every visitor receives) is read as text, once per container, at most three per page, and never run; its escaped characters are decoded and the same table of patterns is applied, with Google Analytics 4's measurement id read from a tag's settings. What the file holds is what the container could load: whether a tag fires on this page depends on its triggers, which Gaugeline does not run, and the finding says so. A tag built from a template that keeps its id out of the file is not seen. A container that cannot be read, or is longer than the size cap, is could-not-check with the reason",
  async run(page, ctx) {
    const reason = reasonFor(page, ctx);
    const trackers = ctx.trackers;
    if (reason === undefined || !trackers) return [];
    const ids = containerIds(findTrackers(page));
    for (const extra of ids.slice(CONTAINER_CAP))
      ctx.couldNotCheck?.(
        page.finalUrl,
        `${extra} was not read: at most ${CONTAINER_CAP} Tag Manager containers are read for one page.`,
      );
    const out: Finding[] = [];
    for (const id of ids.slice(0, CONTAINER_CAP)) {
      const read = await trackers.container(id);
      if (!read.ok) {
        ctx.couldNotCheck?.(
          page.finalUrl,
          `The Tag Manager container ${read.reason} What it holds was not listed.`,
        );
        continue;
      }
      if (read.truncated)
        ctx.couldNotCheck?.(
          page.finalUrl,
          `The Tag Manager container ${id} is longer than Gaugeline reads, so its list may be incomplete.`,
        );
      for (const t of read.trackers)
        out.push({
          checkId: "tracker-in-tag-manager",
          severity: "low",
          title: this.title,
          evidence: `Tag Manager container ${clip(id)} holds ${describeTracker(t)}; it loads on ${clip(pathOf(page))}, ${reason}. Whether it fires there depends on the container's triggers, which Gaugeline does not run`,
          url: clip(page.finalUrl),
        });
    }
    return out;
  },
});

export const TRACKER_CHECKS = [trackerOnSensitivePage, trackerInTagManager] as const;
