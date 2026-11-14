import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { contentIndex } from "./content/parse.js";
import { REDIRECTOR_HOSTS, REDIRECT_PARAMS, REDIRECT_PATH, hostIn } from "./content/lists.js";
import { firstFew } from "./site-helpers.js";

/** A link that leaves through a shortener, or a /redirect?url=https://... address. */
export function wrappedBy(href: string): string | undefined {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return undefined;
  }
  if (hostIn(u.hostname, REDIRECTOR_HOSTS)) return u.hostname.replace(/^www\./, "");
  if (REDIRECT_PATH.test(u.pathname)) {
    for (const p of REDIRECT_PARAMS) {
      const v = u.searchParams.get(p);
      if (v && /^https?:\/\//i.test(v)) return `${u.pathname}?${p}=`;
    }
  }
  return undefined;
}

export const linksWrapped = defineCheck<PageSnapshot>({
  id: "links-wrapped",
  size: "S",
  done: "Links go straight to their destination.",
  estimateChanges:
    "Social icons in the footer are one edit. Wrapped links inside posts are one each.",
  area: "Visitors",
  severity: "medium",
  title: "Some links go through a link shortener",
  what: "Links leave the page through a shortener or redirector (bit.ly, t.co, lnkd.in, a /redirect?url= address) instead of linking directly.",
  why: "Visitors can't see where the link goes before they click, the redirect adds a delay, and if the shortener expires or is blocked the link breaks.",
  fix: "Link straight to the destination. Social icons in the footer are a common place for these.",
  tech: `a[href] on ${REDIRECTOR_HOSTS.join(", ")} (or a subdomain), or a /redirect, /out or /go path with a url= style parameter holding an http(s) address; footer links count too`,
  run(page) {
    const hits = contentIndex(page).links.flatMap((l) => {
      const by = wrappedBy(l.href);
      return by ? [`${l.href} (${by})`] : [];
    });
    const unique = [...new Set(hits)];
    if (unique.length === 0) return [];
    return [
      {
        checkId: "links-wrapped",
        severity: "medium",
        title: this.title,
        evidence: `${unique.length} wrapped ${unique.length === 1 ? "link" : "links"}: ${firstFew(unique)}`,
        url: page.finalUrl,
      },
    ];
  },
});
