import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import {
  codePaths,
  enclosingBlock,
  lineOf,
  scanSource,
  sourceUrl,
  unreadReason,
} from "./source-scan.js";

// [docs] next@16.4.1 > fetch, options.next.revalidate and options.next.tags - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/03-api-reference/04-functions/fetch.mdx
// [docs] next@16.4.1 > revalidateTag ("marks the tagged data as stale") - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/03-api-reference/04-functions/revalidateTag.mdx
// [GC] no source found (uncited): that mixing the two makes the caching "hard to reason about". It is the owner's reason for the check; the text says what the code does (it changes on a timer and on publish) and not more.

/** A `revalidate` option or segment setting, and what it is set to. */
const REVALIDATE = /\brevalidate\s*(?::|=(?!=))\s*([^,}\n;]+)/g;

export const revalidateTimeAndTagMixed = defineCheck<LocalSourceInput>({
  id: "revalidate-time-and-tag-mixed",
  size: "S",
  done: "Each read is cached either for a time or by a tag, not both.",
  estimateChanges:
    "One option per read; larger if the time was chosen because publishing does not clear the tag yet.",
  area: "Visitors",
  severity: "medium",
  title: "A read is cached for a time and by a tag",
  what: "One read sets both a revalidate time and tags, or a file sets a revalidate time for a page whose reads use tags.",
  why: "With tags, the content changes when an editor publishes and your webhook clears the tag. With a revalidate time as well, the same read is also refreshed on a timer, so the page can change with no publish, and a missed webhook is hidden until the timer runs out. Both are documented Next.js options for different jobs; together, it is hard to say from the code when a page will change.",
  fix: "Pick one per read. If a publish clears the tag, drop the revalidate time. If you want a timer (for a feed with no webhook), drop the tags.",
  tech: "reads the code files of the folder named, never runs them; a revalidate that is a number above zero, in an object that also has a tags option (a fetch's next option, or unstable_cache's options), or as a file's own `revalidate` setting in a file whose fetches use tags, is a finding naming the file and the line; revalidate false or 0 is not a timer; a revalidate that is not a number or false, in an object with tags, is could-not-check; the finding never prints the tags or the time",
  run(input, ctx) {
    const url = sourceUrl(input);
    const out: Finding[] = [];
    for (const path of codePaths(input)) {
      const { bare } = scanSource(input.tree.files.get(path) ?? "");
      const fileTags = /\btags\s*:/.test(bare);
      for (const m of bare.matchAll(REVALIDATE)) {
        const value = (m[1] ?? "").trim();
        const line = lineOf(bare, m.index);
        const block = enclosingBlock(bare, m.index);
        const segment = m[0].includes("=");
        const sameRead = segment
          ? segment &&
            fileTags &&
            /\bexport\s+const\s*$/.test(bare.slice(Math.max(0, m.index - 20), m.index))
          : block !== undefined && /\btags\s*:/.test(bare.slice(block.start, block.end));
        if (!sameRead) continue;
        if (value === "false" || /^0[\d_]*$/.test(value)) continue;
        if (!/^\d[\d_]*$/.test(value)) {
          ctx.couldNotCheck?.(
            url,
            `${path}:${line} sets revalidate from something other than a number or false, so Gaugeline cannot tell whether it is a timer.`,
          );
          continue;
        }
        out.push({
          checkId: "revalidate-time-and-tag-mixed",
          severity: "medium",
          title: this.title,
          evidence: segment
            ? `${path}:${line}: this file sets a revalidate time and its reads use tags, so they change on a timer and on publish.`
            : `${path}:${line}: this read sets a revalidate time and tags, so it changes on a timer and on publish.`,
          url,
          source: { file: path, line },
        });
      }
    }
    const unread = unreadReason(input);
    if (out.length === 0 && unread !== undefined) ctx.couldNotCheck?.(url, unread);
    return out;
  },
});
