import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { hiddenLinks } from "./hidden/common.js";
import { firstFew, shortUrl } from "./site-helpers.js";

export const hiddenLinked = defineCheck<PageSnapshot>({
  id: "hidden-linked",
  area: "Launch day",
  severity: "high",
  title: "A public page links to an unlaunched section",
  what: "A public page links to an address in a hidden section, directly or through a redirect.",
  why: "Visitors and search engines follow the link into pages nobody meant to show yet, usually from a shared menu, footer or related-posts block.",
  fix: "Hide the link behind the same flag as the section, or remove it until launch.",
  tech: "Links on the checked page and the run's other public pages whose address matches a hidden path glob, and sampled same-site links whose redirects end in one",
  async run(page, ctx) {
    const links = await hiddenLinks(page, ctx);
    if (links.length === 0) return [];
    const origin = new URL(page.finalUrl).origin;
    const parts = links.map((l) =>
      l.redirect
        ? `${shortUrl(l.href, origin)} on ${l.from} redirects to ${shortUrl(l.target, origin)}`
        : `${l.from} links to ${shortUrl(l.href, origin)}${l.text ? ` ("${l.text}")` : ""}`,
    );
    return [
      {
        checkId: "hidden-linked",
        severity: "high",
        title: this.title,
        evidence: parts.length > 3 ? firstFew(parts) : parts.join("; "),
        url: page.finalUrl,
      },
    ];
  },
});
