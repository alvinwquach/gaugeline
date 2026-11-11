import { defineCheck } from "../model.js";
import { embeddedPageData, isGatsbySite, leafName, privateNames } from "../gatsby/detect.js";
import { pageFiles } from "../gatsby/read.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

const names = (list: readonly string[]): string =>
  list.slice(0, 8).join(", ") + (list.length > 8 ? `, and ${list.length - 8} more` : "");

export const gatsbyPrivateFields = defineCheck<PageSnapshot>({
  id: "gatsby-private-fields",
  size: "M",
  done: "The page's data holds only what the page shows: no field named for a password, token, secret or private note.",
  estimateChanges:
    "Each field is dropped from the GraphQL query that returns it; a field several pages query needs each of them checked.",
  area: "Security & email",
  severity: "high",
  title: "The data sent with a Gatsby page has fields that look private",
  what: "The page-data file of this Gatsby page, a static query it lists, or the page data embedded in its HTML has fields named like something private (password, token, secret, apiKey, private notes).",
  why: "Everything a page query returns is written to a public JSON file, whether or not the page shows it. A field used only at build time still travels to every visitor if the query selects it.",
  fix: "Select only the fields the page shows in its query. Keep secrets in environment variables read in gatsby-node or a Function, never in a query result.",
  tech: "Gatsby sites only. Names only, never values: the property names in the page's own /page-data/<path>/page-data.json (one GET, the file the framework's client fetches on every visit), in the /page-data/sq/d/<hash>.json files it lists (at most ten) and in an inline window.pageData literal, walked to depth 8 and capped, matched by word against password, passwd, secret, token, private, credential, ssn, salt, bearer, authorization, cvv, iban, apiKey, accessKey, secretKey, privateKey, internalNotes. A file that cannot be read in full is could not check. The word list is a guess (uncited)",
  async run(page, ctx) {
    if (!isGatsbySite(page) || !isHtmlPage(page)) return [];
    const found: string[] = [];
    const inline = embeddedPageData(page);
    if (inline && "unread" in inline) ctx.couldNotCheck?.(page.finalUrl, inline.unread);
    else if (inline) {
      const hit = privateNames([...new Set(inline.fields.map((f) => leafName(f.path)))]);
      if (hit.length > 0) found.push(`the embedded page data has ${names(hit)}`);
    }
    if (ctx.fetcher) {
      for (const file of await pageFiles(page, ctx)) {
        if ("unread" in file.read) {
          ctx.couldNotCheck?.(file.url, file.read.unread);
          continue;
        }
        const hit = privateNames([...new Set(file.read.fields.map((f) => leafName(f.path)))]);
        if (hit.length > 0) found.push(`${new URL(file.url).pathname} has ${names(hit)}`);
      }
    }
    if (found.length === 0) return [];
    return [
      {
        checkId: "gatsby-private-fields",
        severity: "high",
        title: this.title,
        evidence: `${found.join("; ")} (field names only)`,
        url: page.finalUrl,
      },
    ];
  },
});
