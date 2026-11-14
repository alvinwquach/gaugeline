import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import { viewsOf } from "./content-source.js";
import { lineOf, notReadReason, sortFindings } from "./scan.js";

/**
 * FF-30 (the source half): Sanity's stega encoding hides editing information inside the string values
 * a query returns, so click-to-edit can find the field. A hidden string is not the string it looks
 * like. When the project turns stega on, a file that fetches content and then compares a value with a
 * literal, builds a URL or an attribute from it, or puts it in page metadata, without `stegaClean`,
 * can break: a link that goes nowhere, a comparison that is never true, a title with invisible
 * characters. The check looks for the setup first (`stega:` with `true` or an object, `defineLive`,
 * `VisualEditing`, `studioUrl`); no setup means nothing is encoded and the check passes. Then it looks,
 * file by file, for files that fetch Sanity content (`.fetch(`, `sanityFetch(`, `urlFor(`) and do not
 * mention `stegaClean`, for: a `generateMetadata` or `metadata` that uses a fetched value, a property
 * compared to a string literal (`x.layout === "wide"`; underscore fields such as `_type` are left
 * alone), and a URL or attribute built from a property (`href={x.url}`, `id={x.slug}`).
 *
 * "Over-cleaned visible text" needs a rendered page and is not read here.
 *
 * // [docs] @sanity/client@main > README, "Stega" and `stegaClean` - https://raw.githubusercontent.com/sanity-io/client/main/README.md (lines 802 and 863-896: stega encodes edit links into string values; clean them with stegaClean from @sanity/client/stega before comparing). The version of @sanity/client was not pinned when this was read.
 * // [GC] no source found (uncited): that URLs, attributes and metadata break when not cleaned is an inference from the same text, not a sentence on the page.
 */
const ID = "stega-not-cleaned";

const SETUP =
  /\bstega\s*:\s*(?:true\b|\{)|\bdefineLive\s*\(|\bVisualEditing\b|\bstudioUrl\s*:|\bstegaEnabled\b/;
const FETCHES = /\.\s*fetch\s*\(|\bsanityFetch\s*\(|\burlFor\s*\(/;

/** What an uncleaned use looks like, each with the words a finding says. */
const USES: { what: string; re: RegExp }[] = [
  {
    what: "page metadata is built from fetched content",
    re: /\bgenerateMetadata\b[\s\S]{0,1200}?\b(?:title|description)\s*:\s*[\w$]+(?:\??\.\w+)+/,
  },
  {
    what: "a fetched value is compared with a string",
    re: /(?<![\w$.])(?!(?:process|import|window|document|req|request|params|searchParams|error|err|e)\b)[\w$]+(?:\??\.(?!_)[A-Za-z]\w*)+\s*[!=]==?\s*["'`]/,
  },
  {
    what: "a link or attribute is built from a fetched value",
    re: /\b(?:href|src|id|target|rel)\s*=\s*\{\s*(?:`[^`]*\$\{\s*)?[\w$]+(?:\??\.\w+)+/,
  },
];

export const stegaNotCleaned = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: "Wherever fetched text is compared, used in a link or attribute, or put in metadata, it goes through stegaClean first.",
  estimateChanges:
    "Wrapping each use in stegaClean is a small change per file. Finding every place the text travels in a larger site is the real work.",
  area: "Visitors",
  severity: "medium",
  title: "Sanity's hidden editing text is not cleaned where it must be",
  what: "The project turns on Sanity's click-to-edit encoding, and a file that fetches content compares it, builds a link or attribute from it, or uses it in metadata without stegaClean.",
  why: "Click-to-edit works by hiding invisible characters inside the text a query returns. Where that text is compared with a word, used as a link, or put in a page title, the hidden characters make the comparison false, the link wrong or the title carry junk, and it only happens in preview, so it is hard to see.",
  fix: "Wrap the value in stegaClean (from @sanity/client/stega) before you compare it, use it in a URL or attribute, or put it in metadata. Leave visible text as it comes, so click-to-edit keeps working.",
  tech: "reads the folder's code files (.env files never); looks first for the setup (stega: true or an object, defineLive, VisualEditing, studioUrl): none found means nothing is encoded and the check passes; then, in each file that fetches Sanity content (.fetch(, sanityFetch(, urlFor() and does not mention stegaClean, a metadata title or description built from a property, a property compared with a string literal (fields starting with an underscore are left alone), or an href, src, id, target or rel built from a property, is a finding (the file, the line and what it is); over-cleaned visible text needs a rendered page and is not read; no source file read, or some left out, is could-not-check",
  run(input, ctx) {
    const { tree } = input;
    const url = `source:${tree.label}`;
    const views = viewsOf(input);
    const findings: Finding[] = [];
    if (views.some((v) => SETUP.test(v.code))) {
      for (const v of views) {
        if (!FETCHES.test(v.bare) || /\bstegaClean\b/.test(v.code)) continue;
        for (const use of USES) {
          const m = use.re.exec(v.code);
          if (m === null || v.bare[m.index] === " ") continue;
          findings.push({
            checkId: ID,
            severity: "medium",
            title: this.title,
            evidence: `${v.file}: stega is on, and ${use.what} without stegaClean.`,
            url,
            source: { file: v.file, line: lineOf(v.code, m.index) },
          });
        }
      }
    }
    sortFindings(findings);
    if (findings.length === 0) {
      const why = notReadReason(tree);
      if (why !== undefined) ctx.couldNotCheck?.(url, why);
    }
    return findings;
  },
});
