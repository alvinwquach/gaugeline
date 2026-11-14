import { defineCheck } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import {
  appSegments,
  disallowLine,
  disallowed,
  parentSetting,
  robotsSource,
  routePath,
} from "./indexing-source.js";

/**
 * FF-01. A page can carry noindex (its own robots metadata, or the nearest layout's) and also be
 * disallowed in robots.txt. This reads both from the folder; the deployed half (a live robots.txt and a
 * live page) is not built here.
 *
 * // [docs] next@16.4.1 > robots.txt file convention - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/03-api-reference/03-file-conventions/01-metadata/robots.mdx (page: https://nextjs.org/docs/app/api-reference/file-conventions/metadata/robots). Describes where the file lives (app/robots.txt, app/robots.ts) and nothing about noindex.
 * // [GC] no source found (uncited): that a crawler which may not fetch a page never sees its noindex (RFC 9309 and Google's block-indexing page were unreachable). The check text says the noindex "may never be read" and does not state more.
 */
export const robotsDisallowHidesNoindex = defineCheck<LocalSourceInput>({
  id: "robots-disallow-hides-noindex",
  size: "S",
  done: "No page that carries noindex is blocked in robots.txt.",
  estimateChanges:
    "Removing a Disallow line is one edit. Deciding which of the two a hidden section should keep is a conversation first.",
  area: "Search & sharing",
  severity: "high",
  title: "Pages marked noindex are also blocked in robots.txt",
  what: "robots.txt tells crawlers not to fetch pages that also carry noindex in their metadata.",
  why: "A crawler that may not fetch a page cannot read the noindex in it, so the instruction may never be seen. The address can still turn up in search results, from links elsewhere, with no description. For a page meant to stay out of search, noindex only works where the crawler is allowed to read it.",
  fix: "Take the page out of robots.txt's Disallow rules and keep noindex, so the instruction can be read. A login is the other reliable way to keep a page out.",
  tech: "static, reads public/robots.txt, app/robots.txt or app/robots.ts and the app router's layout and page files as text and makes no request; a page is noindex when its own robots (or the closest layout's) is index: false or a noindex string; a page is blocked when a Disallow rule for * matches its address up to its first dynamic segment; one finding names the first three pages; an app/robots.ts built from code, or a robots value built from code, is not sure; no noindex page passes",
  run(input, ctx) {
    const tree = input.tree;
    const url = `source:${tree.label}`;
    const segments = appSegments(tree);
    const pages = segments.flatMap((s) => {
      if (s.kind !== "page") return [];
      const value = (s.robots ?? parentSetting(segments, s)?.robots)?.value;
      return value === undefined ? [] : [{ s, value }];
    });
    const noindex = pages.filter((p) => p.value === "noindex");
    const maybe = pages.filter((p) => p.value === "dynamic");
    const src = robotsSource(tree);
    if (src?.robots === undefined || (noindex.length === 0 && maybe.length === 0)) return [];
    const robots = src.robots;
    const blocked = noindex.filter((p) => disallowed(robots, routePath(p.s.rel)));
    if (blocked.length === 0) {
      if (src.dynamic || maybe.some((p) => disallowed(robots, routePath(p.s.rel))))
        ctx.couldNotCheck?.(
          url,
          `${src.dynamic ? `${src.file} is built from code` : "a page's robots value is built from code"} that Gaugeline does not run, so it cannot tell whether a noindex page is blocked`,
        );
      return [];
    }
    const paths = blocked.map((p) => routePath(p.s.rel));
    const rule = robots.groups
      .flatMap((g) => g.rules)
      .find((r) => !r.allow && paths.some((p) => p.startsWith(r.path.replace(/\*.*$/, ""))));
    const first = paths.slice(0, 3).join(", ");
    return [
      {
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${blocked.length} ${blocked.length === 1 ? "page carries" : "pages carry"} noindex and ${blocked.length === 1 ? "is" : "are"} blocked in ${src.file}: ${first}${blocked.length > 3 ? ` and ${blocked.length - 3} more` : ""}`,
        url,
        source: { file: src.file, line: disallowLine(tree, src.file, rule?.path ?? "") },
      },
    ];
  },
});
