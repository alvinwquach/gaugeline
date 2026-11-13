import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import { appSegments, parentSetting, type RobotsValue } from "./indexing-source.js";

const says = (v: RobotsValue): string =>
  v === "index" ? "says index: true" : "has no index value, so the page can be indexed";

/**
 * FF-04. Next.js merges the metadata of a route's layouts and page shallowly: a key set in a deeper
 * segment replaces the same key from a shallower one, whole. So a page that sets `robots` at all
 * replaces the layout's `robots` (and its noindex) with its own.
 *
 * // [docs] next@16.4.1 > generate-metadata > Merging - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/03-api-reference/04-functions/generate-metadata.mdx (page: https://nextjs.org/docs/app/api-reference/functions/generate-metadata). Lines 1346 and 1348: segments are "shallowly" merged, duplicate keys are "replaced", and nested fields such as `robots` from an earlier segment are "overwritten" by the last segment to define them.
 */
export const pageRobotsOverridesLayout = defineCheck<LocalSourceInput>({
  id: "page-robots-overrides-layout",
  size: "S",
  done: "Every page below a noindex layout either sets no robots value or sets noindex itself.",
  estimateChanges:
    "One line per page. A page that really should be indexed while the rest is hidden needs a decision first.",
  area: "Search & sharing",
  severity: "high",
  title: "A page's robots setting replaces the layout's noindex",
  what: "A page (or a nested layout) sets its own robots metadata without noindex, below a layout that says noindex. Next.js does not combine the two: the page's value replaces the layout's.",
  why: "The layout reads as if it keeps the whole site out of search, but this page puts itself back in. It can be indexed while everything else is hidden, and nobody notices because the layout still says noindex. For a site that must stay out of search until launch, that is a page the whole world can find.",
  fix: "Set `index: false` in the page's own robots value, or remove the page's robots so the layout's applies. If the layout reads a setting (an environment variable), read the same one in the page.",
  tech: "static, reads the app router's layout and page files in the folder as text and makes no request; a robots value is noindex (index: false, or a noindex string), index (index: true), unspecified (an object with no index) or dynamic (anything Gaugeline would have to run to know); a page or nested layout whose value is index or unspecified, below the closest layout that sets robots as noindex or dynamic, is a finding; a dynamic value below a noindex layout is not sure; no app folder with a layout is not sure",
  run(input, ctx) {
    const segments = appSegments(input.tree);
    if (!segments.some((s) => s.kind === "layout")) {
      ctx.couldNotCheck?.(
        `source:${input.tree.label}`,
        "no app folder with a layout.tsx was found (the pages router is not read), so the metadata could not be compared",
      );
      return [];
    }
    const out: Finding[] = [];
    for (const s of segments) {
      const mine = s.robots;
      const parent = parentSetting(segments, s);
      if (mine === undefined || parent?.robots === undefined) continue;
      const theirs = parent.robots;
      const url = `source:${input.tree.label}/${s.file}`;
      if (theirs.value === "noindex" && mine.value === "dynamic") {
        ctx.couldNotCheck?.(
          url,
          `${s.file} sets robots from code Gaugeline does not run, below the noindex in ${parent.file}`,
        );
      } else if (
        (theirs.value === "noindex" || theirs.value === "dynamic") &&
        (mine.value === "index" || mine.value === "unspecified")
      ) {
        out.push({
          checkId: this.id,
          severity: this.severity,
          title: this.title,
          evidence: `${s.file}:${mine.line} sets robots and ${says(mine.value)}, which replaces the robots in ${parent.file}:${theirs.line}${theirs.value === "dynamic" ? " (a setting decides it there)" : " (noindex)"}`,
          url,
          source: { file: s.file, line: mine.line },
        });
      }
    }
    return out;
  },
});
