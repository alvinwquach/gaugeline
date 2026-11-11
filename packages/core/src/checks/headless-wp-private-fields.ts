import { defineCheck } from "../model.js";
import { isHeadlessWordPress, readNextData, scanState } from "../headless-wordpress/detect.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

const LISTED = 8;

export const headlessWpPrivateFields = defineCheck<PageSnapshot>({
  id: "headless-wp-private-fields",
  size: "M",
  done: "The state embedded in the page holds only what the page shows: no user's email, no secret, no unpublished post.",
  estimateChanges:
    "Each field is dropped from the GraphQL query that asks for it; a fragment shared by many pages needs each of them checked.",
  area: "Security & email",
  severity: "high",
  title: "The data sent with a page has private fields or unpublished posts",
  what: "The state this headless WordPress page embeds (__NEXT_DATA__ with WPGraphQL data) has fields named like something private, a user's email or roles, or posts that are not published.",
  why: "Everything a page's queries return is sent to every visitor, whether or not the page shows it. A fragment that asks for the whole user, or a query that includes drafts, puts them in the page source.",
  fix: "Ask only for the fields the page shows (not the whole User or Post type), and keep draft and private posts behind an authenticated request.",
  tech: "Headless WordPress sites only, from the page already read, no extra request. The __NEXT_DATA__ script is read as JSON (up to 1 MB, 100,000 nodes, 12 levels deep; a larger or cut one is could not check) and walked once. Names only, never values: field names matched by word against password, passwd, secret, token, credential, ssn, salt, bearer, authorization, cvv, iban, private, apiKey, accessKey, secretKey, privateKey, authKey, internalNote (is.../has... flags are left out); email, username, capabilities, roles and registeredDate on a node whose __typename is User; and a count of nodes whose status is draft, auto-draft, pending, private or future. The names are matched by their words, which is a guess (uncited)",
  async run(page, ctx) {
    if (!isHeadlessWordPress(page) || !isHtmlPage(page)) return [];
    const data = readNextData(page);
    if (!data) return [];
    if ("unread" in data) {
      ctx.couldNotCheck?.(page.finalUrl, data.unread);
      return [];
    }
    const scan = scanState(data.json);
    const parts: string[] = [];
    if (scan.names.length > 0)
      parts.push(
        `the embedded state has ${scan.names.slice(0, LISTED).join(", ")}${scan.names.length > LISTED ? `, and ${scan.names.length - LISTED} more` : ""}`,
      );
    if (scan.unpublished.size > 0) {
      const counts = [...scan.unpublished].map(([s, n]) => `${n} ${s}`).join(", ");
      parts.push(`it holds posts that are not published (${counts})`);
    }
    if (scan.capped)
      ctx.couldNotCheck?.(page.finalUrl, "the embedded state is larger than the limits read");
    if (parts.length === 0) return [];
    return [
      {
        checkId: "headless-wp-private-fields",
        severity: "high",
        title: this.title,
        evidence: `${parts.join("; ")} (field names and counts only)`,
        url: page.finalUrl,
      },
    ];
  },
});
