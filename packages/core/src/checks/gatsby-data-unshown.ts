import { defineCheck } from "../model.js";
import { isGatsbySite, leafName, privateNames } from "../gatsby/detect.js";
import { pageFiles } from "../gatsby/read.js";
import type { PageSnapshot } from "../snapshot.js";
import { VISIBLE_TEXT_MAX } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

/** The most field names listed per file. */
const LISTED = 8;
/** Strings shorter than this are too common to say anything about. */
const MIN_LENGTH = 4;
/** How much of a value is compared: an excerpt shown on the page still counts as shown. */
const PREFIX = 40;
/** Names that carry addresses, ids and image plumbing, not text a visitor would read. */
const PLUMBING: ReadonlySet<string> = new Set([
  "id",
  "slug",
  "path",
  "type",
  "mediatype",
  "contentdigest",
  "owner",
  "__typename",
  "base64",
  "src",
  "srcset",
  "sizes",
  "relativepath",
  "extension",
  "publicurl",
  "absolutepath",
]);

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** A value with its tags taken out (a markdown or CMS html field), a linear scan, cut at 2000 characters. */
function plain(value: string): string {
  const v = value.slice(0, 2_000);
  if (!v.includes("<")) return v;
  let out = "";
  let inTag = false;
  for (const c of v) {
    if (c === "<") {
      inTag = true;
      out += " ";
    } else if (c === ">" && inTag) inTag = false;
    else if (!inTag) out += c;
  }
  return out
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"');
}

const isPlumbingValue = (v: string): boolean =>
  /^(?:https?:\/\/|\/|data:|#)/.test(v) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v) ||
  /^[0-9a-f]{16,}$/.test(v) ||
  /^\d{4}-\d{2}-\d{2}/.test(v);

export const gatsbyDataUnshown = defineCheck<PageSnapshot>({
  id: "gatsby-data-unshown",
  size: "M",
  done: "The page's data files hold only fields the page shows, or the rest is deliberate.",
  estimateChanges:
    "Each unused field is dropped from the query that returns it; fields used only by scripts or by other pages may be deliberate.",
  area: "Security & email",
  severity: "low",
  title: "The data sent with a Gatsby page has text the page does not show",
  what: "This Gatsby page's page-data file, or a static query it lists, has text fields whose text is nowhere on the page a visitor reads.",
  why: "Everything a page query returns is written to a public JSON file. A field the page does not show is either unused (so it can go) or used by a script (so it is worth a look): either way it is public.",
  fix: "Select only the fields the page needs in its query, or move the rest to a source that checks who is asking.",
  tech: "Gatsby sites only. The page's own /page-data/<path>/page-data.json and the /page-data/sq/d/<hash>.json files it lists (the files the framework's client fetches on every visit; one GET each, at most eleven, walked to depth 8, capped). Text fields of 4 or more characters whose first 40 characters are not in the page's visible text (tags taken out of html fields); addresses, ids, dates and image plumbing are left out; names only, never values. Fields named like something private are left to gatsby-private-fields. A file or page text that cannot be read in full is could not check. Fields used by scripts or other pages are shown too, so read the list as a prompt (uncited)",
  async run(page, ctx) {
    if (!ctx.fetcher || !isGatsbySite(page) || !isHtmlPage(page)) return [];
    const text = page.visibleText;
    if (text === undefined || text.length >= VISIBLE_TEXT_MAX) {
      ctx.couldNotCheck?.(page.finalUrl, "the page's visible text was not read in full");
      return [];
    }
    const haystack = collapse(text);
    const found: string[] = [];
    for (const file of await pageFiles(page, ctx)) {
      if ("unread" in file.read) {
        ctx.couldNotCheck?.(file.url, file.read.unread);
        continue;
      }
      const unshown = new Set<string>();
      for (const f of file.read.fields) {
        if (f.kind !== "string" || typeof f.value !== "string" || f.path.startsWith("pageContext"))
          continue;
        const leaf = leafName(f.path);
        const value = collapse(plain(f.value));
        if (
          value.length < MIN_LENGTH ||
          PLUMBING.has(leaf.toLowerCase()) ||
          isPlumbingValue(value) ||
          privateNames([leaf]).length > 0
        )
          continue;
        if (!haystack.includes(value.slice(0, PREFIX))) unshown.add(f.path);
      }
      if (unshown.size === 0) continue;
      const list = [...unshown];
      found.push(
        `${new URL(file.url).pathname} has ${list.length} text field${list.length === 1 ? "" : "s"} not on the page: ${list.slice(0, LISTED).join(", ")}${list.length > LISTED ? `, and ${list.length - LISTED} more` : ""}`,
      );
    }
    if (found.length === 0) return [];
    return [
      {
        checkId: "gatsby-data-unshown",
        severity: "low",
        title: this.title,
        evidence: `${found.join("; ")} (field names only)`,
        url: page.finalUrl,
      },
    ];
  },
});
