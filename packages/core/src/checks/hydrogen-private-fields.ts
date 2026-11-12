import { isHydrogenSite, privateNames, readEmbedded } from "../hydrogen/detect.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

const LISTED = 8;

export const hydrogenPrivateFields = defineCheck<PageSnapshot>({
  id: "hydrogen-private-fields",
  size: "M",
  done: "The page's embedded state holds only what the page shows: no field named for a password, private token, secret or private note.",
  estimateChanges:
    "Each field is dropped in the loader that returns it; a field several routes read needs each of them checked.",
  area: "Security & email",
  severity: "high",
  title: "The data sent with a Hydrogen page has fields that look private",
  what: "The state this Hydrogen page embeds for the browser (window.__reactRouterContext, with the storefront data its loaders return) has fields named like something private (password, private token, secret, apiKey, private notes).",
  why: "Everything a loader returns is sent to every shopper, whether or not the page shows it. A server-only value such as the private Storefront API token or the session secret travels with the page.",
  fix: "Return only the fields the page shows from the loader, and keep PRIVATE_STOREFRONT_API_TOKEN, SESSION_SECRET and other secrets in server-only code (context.env in a loader or action) that never returns them.",
  tech: "Hydrogen storefronts. Names only, never values: the property names in the page's own embedded context and in its first streamed turbo-stream chunk (a flat JSON array, each index decoded once, capped), matched by word against password, passwd, secret, token, private, credential, ssn, salt, bearer, authorization, cvv, iban, apiKey, accessKey, secretKey, privateKey, internalNotes. The public Storefront token (storefrontAccessToken, which the starter's root loader sends for the consent banner) and checkoutDomain are public by design and are not flagged. No extra request. A state that cannot be read in full, or deferred chunks after the first, are could not check. The header, globals and starter fields are read from @shopify/hydrogen 2026.10.3 and @shopify/cli-hydrogen 13.0.6 on npm; matching names by their words is a guess (uncited)",
  async run(page, ctx) {
    if (!isHydrogenSite(page) || !isHtmlPage(page)) return [];
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
        checkId: "hydrogen-private-fields",
        severity: "high",
        title: this.title,
        evidence: `${embedded.marker} has ${found.slice(0, LISTED).join(", ")}${found.length > LISTED ? `, and ${found.length - LISTED} more` : ""} (field names only)`,
        url: page.finalUrl,
      },
    ];
  },
});
