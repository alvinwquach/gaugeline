import { defineCheck } from "../model.js";
import { isRemixSite, privateNames, readEmbedded } from "../remix/detect.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

const LISTED = 8;

export const remixPrivateFields = defineCheck<PageSnapshot>({
  id: "remix-private-fields",
  size: "M",
  done: "The page's embedded state holds only what the page shows: no field named for a password, token, secret or private note.",
  estimateChanges:
    "Each field is dropped in the loader that returns it; a field several routes read needs each of them checked.",
  area: "Security & email",
  severity: "high",
  title: "The data sent with a page has fields that look private",
  what: "The state this Remix or React Router page embeds for the browser (window.__remixContext, window.__reactRouterContext or window.__staticRouterHydrationData) has fields named like something private (password, token, secret, apiKey, private notes).",
  why: "Everything a loader returns is sent to every visitor, whether or not the page shows it. A field that is only used on the server still travels with the page.",
  fix: "Return only the fields the page shows from the loader, and keep secrets in server-only code (process.env in a loader or action, or a .server module) that never returns them.",
  tech: "Remix and React Router sites. Names only, never values: the property names in the page's own embedded context (JSON, read as text) and in its first streamed turbo-stream chunk (a flat JSON array, walked from index 0 once per index, capped), matched by word against password, passwd, secret, token, private, credential, ssn, salt, bearer, authorization, cvv, iban, apiKey, accessKey, secretKey, privateKey, internalNotes. No extra request. A state that cannot be read in full, or deferred chunks after the first, are could not check. The embedded globals and the turbo-stream layout are read from react-router 7.18.5 and @remix-run/react 2.17.5 on npm; matching names by their words is a guess (uncited)",
  async run(page, ctx) {
    if (!isRemixSite(page) || !isHtmlPage(page)) return [];
    const embedded = readEmbedded(page);
    if (embedded === undefined) return [];
    if (embedded.unread !== undefined) ctx.couldNotCheck?.(page.finalUrl, embedded.unread);
    const found = privateNames(embedded.names);
    if (found.length === 0) {
      if (embedded.unread === undefined && embedded.deferred)
        ctx.couldNotCheck?.(
          page.finalUrl,
          "deferred values after the first stream chunk are not read",
        );
      return [];
    }
    return [
      {
        checkId: "remix-private-fields",
        severity: "high",
        title: this.title,
        evidence: `${embedded.marker} has ${found.slice(0, LISTED).join(", ")}${found.length > LISTED ? `, and ${found.length - LISTED} more` : ""} (field names only)`,
        url: page.finalUrl,
      },
    ];
  },
});
