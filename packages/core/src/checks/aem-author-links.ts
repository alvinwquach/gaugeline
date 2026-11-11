import { authorTierLink } from "../adapters/shared/aem-author.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { firstFew } from "./site-helpers.js";

/** The most links looked at on one page: a page with more than this is not read past it (a link count never grows a report). */
const MAX_LINKS = 5000;

/** A link as evidence: host and path only, never a query string or a fragment (they can hold a session or a token). */
function shown(href: string): string {
  try {
    const u = new URL(href);
    return `${u.host}${u.pathname}`;
  } catch {
    return "(a link)";
  }
}

export const aemAuthorLinks = defineCheck<PageSnapshot>({
  id: "aem-author-links",
  area: "Security & email",
  severity: "medium",
  title: "A published page links to the editors' side of Adobe Experience Manager",
  what: "The live page links to Adobe Experience Manager's author tier: an author host, or the editor, the CRX or the libraries path on the site itself.",
  why: "Visitors land on a login screen or an error, and the link tells anyone where the editors' tier is and that the site runs Adobe Experience Manager. Editors who paste an address from their own browser into a page are the usual cause.",
  fix: "Change each link to the page's public address on the publish host. In the page's component, use a link field that stores the content path and let the site's link rewriting build the public address, instead of pasting the editor's address.",
  tech: "a[href] on the page whose host is author.{domain} or author-p{n}-e{n}.adobeaemcloud.com (any path), or whose path on the page's own host starts /editor.html, /crx/ or /libs/, or is /ui with a #/aem fragment (adapters/shared/aem-author.ts). Only the links the page already serves are read; nothing else is requested. Evidence shows host and path, never a query string.",
  size: "S",
  done: "No link on the page points at the author tier or an editors' path.",
  estimateChanges:
    "One pasted link is one edit. Many means a component that stores the editor's address instead of a content path, which is one fix in the component and a re-publish of the pages that use it.",
  run(page) {
    let host: string;
    try {
      host = new URL(page.finalUrl).hostname;
    } catch {
      return [];
    }
    const found = new Set<string>();
    for (const l of page.links.slice(0, MAX_LINKS)) {
      if (authorTierLink(l.href, host) !== undefined) found.add(shown(l.href));
    }
    if (found.size === 0) return [];
    const list = [...found].sort();
    return [
      {
        checkId: "aem-author-links",
        severity: "medium",
        title: this.title,
        evidence: `${list.length} link${list.length === 1 ? "" : "s"} to the author tier: ${firstFew(list)}`,
        url: page.finalUrl,
      },
    ];
  },
});
