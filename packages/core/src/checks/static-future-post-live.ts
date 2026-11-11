import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { cutShort, generatorOf, pageDates, parseWhen } from "../static-generators/detect.js";
import { isHtmlPage } from "./page.js";

const DAY = 86_400_000;

export const staticFuturePostLive = defineCheck<PageSnapshot>({
  id: "static-future-post-live",
  size: "S",
  done: "The live site is built without future-dated posts, and the post's date is the day it should appear.",
  estimateChanges:
    "A build that runs on a schedule needs the date filter in every build command, not only this one.",
  area: "Launch day",
  severity: "high",
  title: "A post dated in the future is already live",
  what: "This page, built with a static site generator, gives a publish date more than a day after today.",
  why: "A post dated for later (a sale, a menu, an announcement) is public now: anyone with the address, a search engine or a feed reader can read it before you meant them to.",
  fix: "Build the live site without future posts (Hugo: drop --buildFuture; Jekyll: drop --future; Eleventy: skip pages whose date is ahead) and rebuild, or correct the date.",
  tech: "Sites with a Hugo, Jekyll, Eleventy, Docusaurus or VitePress generator tag only: the page's article:published_time and JSON-LD datePublished, compared with the run's clock plus one day (a date with no zone is UTC, and the day absorbs any time zone). Only the date is shown, never the title or text. The Hugo and Jekyll flags are from memory of their docs, which could not be reached: uncited",
  run(page, ctx) {
    if (!isHtmlPage(page) || generatorOf(page) === undefined) return [];
    if (cutShort(page)) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        "the page was cut short, so its dates were not read in full",
      );
      return [];
    }
    const limit = (ctx.now?.() ?? new Date()).getTime() + DAY;
    const ahead = pageDates(page).find((d) => (parseWhen(d.raw) ?? -Infinity) > limit);
    if (!ahead) return [];
    return [
      {
        checkId: "static-future-post-live",
        severity: "high",
        title: this.title,
        evidence: `${ahead.source} is ${ahead.raw.trim().slice(0, 10)}, in the future`,
        url: page.finalUrl,
      },
    ];
  },
});
