import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import {
  closeOf,
  codePaths,
  lineOf,
  scanSource,
  sourceUrl,
  unreadReason,
  type Scanned,
} from "./source-scan.js";

// [docs] @sanity/client@main > README, client config (`useCdn: true, // set to false to bypass the edge cache`; the drafts perspective requires `useCdn` false) - https://raw.githubusercontent.com/sanity-io/client/main/README.md (read on main, the installed version was not pinned)
// [docs] next@16.4.1 > fetch, options.next.tags; revalidateTag ("marks the tagged data as stale") - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/03-api-reference/04-functions/fetch.mdx
// [GC] no source found (uncited): that a read right after a publish can cache the older CDN copy. It is an inference from the two sources above, so the check text says "can" and does not state it as fact.

interface Read {
  path: string;
  scanned: Scanned;
}

const CLIENT_PACKAGES = /["'](?:@sanity\/client|next-sanity)["']/;
/** What caches a read by tag in Next: the `tags` option of a fetch, or a call that clears a tag. */
const TAG_CACHE = /\bnext\s*:\s*\{[^}]*\btags\s*:|\b(?:revalidateTag|updateTag)\s*\(/;

export const sanityCdnTaggedReads = defineCheck<LocalSourceInput>({
  id: "sanity-cdn-tagged-reads",
  size: "S",
  done: "The Sanity client that reads published pages cached by tag has useCdn set to false.",
  estimateChanges:
    "One option in one client file; it is larger if the pages share the client with reads that do need the CDN.",
  area: "Visitors",
  severity: "high",
  title: "The Sanity client reads through the CDN, and the reads are cached by tag",
  what: "A Sanity client is created with useCdn: true in a site whose reads are cached by tag and cleared when an editor publishes.",
  why: "useCdn: true makes the client read through Sanity's edge cache, which the client's documentation says to switch off to bypass it. A site that clears a tag when an editor publishes, and then reads again, can be handed the copy from before the publish by the edge cache, and then keep it until the next revalidation. The page can then keep showing the old menu or the old event although the publish worked.",
  fix: "Set useCdn: false on the client that reads published content for pages cached by tag. Keep true for reads that are not cached by tag and do not need to show a publish at once, such as a client-side search.",
  tech: "reads the code files of the folder named, never runs them; a client is a createClient call in a file that imports @sanity/client or next-sanity; the useCdn option is read from the call's own options object; reads are cached by tag when any code file has a next option with tags, or calls revalidateTag or updateTag; useCdn true with such a file is a finding naming the client's file and line and the first file that uses tags; useCdn from an expression, a client with no useCdn, or options that are not written in the call are could-not-check; nothing else in the call (project id, token) is printed",
  run(input, ctx) {
    const url = sourceUrl(input);
    const reads: Read[] = codePaths(input).map((path) => ({
      path,
      scanned: scanSource(input.tree.files.get(path) ?? ""),
    }));
    const tagged = reads.find((r) => TAG_CACHE.test(r.scanned.bare));
    const out: Finding[] = [];
    const unsure = (reason: string): void => ctx.couldNotCheck?.(url, reason);
    for (const r of reads) {
      const { code, bare } = r.scanned;
      if (!CLIENT_PACKAGES.test(code)) continue;
      for (const m of bare.matchAll(/\bcreateClient\s*\(/g)) {
        const open = m.index + m[0].length - 1;
        const line = lineOf(bare, m.index);
        const next = /\S/.exec(bare.slice(open + 1));
        const objectStart = next === null ? -1 : open + 1 + next.index;
        if (bare[objectStart] !== "{") {
          if (tagged !== undefined)
            unsure(
              `${r.path}:${line} builds the client from options that are not written in the call, so Gaugeline cannot tell whether it reads through the CDN.`,
            );
          continue;
        }
        const options = bare.slice(objectStart, closeOf(bare, objectStart) + 1);
        const value = /\buseCdn\b(?:\s*:\s*([^,}\n]+))?/.exec(options);
        const at = value === null ? line : lineOf(bare, objectStart + value.index);
        if (value === null) {
          if (tagged !== undefined)
            unsure(
              `${r.path}:${line} does not set useCdn, and Gaugeline has not confirmed what the client does then.`,
            );
          continue;
        }
        const text = (value[1] ?? "").trim();
        if (text === "true") {
          if (tagged !== undefined)
            out.push({
              checkId: "sanity-cdn-tagged-reads",
              severity: "high",
              title: this.title,
              evidence: `${r.path}:${at}: useCdn is true, and reads are cached by tag (${tagged.path}).`,
              url,
              source: { file: r.path, line: at },
            });
        } else if (text !== "false" && tagged !== undefined) {
          unsure(
            `${r.path}:${at} sets useCdn from something other than true or false, so Gaugeline cannot tell whether it reads through the CDN.`,
          );
        }
      }
    }
    const unread = unreadReason(input);
    if (out.length === 0 && unread !== undefined) unsure(unread);
    return out;
  },
});
