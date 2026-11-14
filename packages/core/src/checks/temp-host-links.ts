import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isTemporaryHost } from "./launch/hosts.js";
import { firstFew } from "./site-helpers.js";

export const tempHostLinks = defineCheck<PageSnapshot>({
  id: "temp-host-links",
  size: "S",
  done: "No link points at the temporary address any more.",
  estimateChanges:
    "Links in the menu, in buttons, in CMS content and in an environment variable are separate places.",
  area: "Launch day",
  severity: "high",
  title: "Links still point at a temporary address",
  what: "The page, on your own domain, links to a hosting provider's temporary address (vercel.app, netlify.app or pages.dev).",
  why: "Those addresses are previews: they can show old content, ask for a login, or vanish when the preview is cleaned up, and search engines split your site between two names.",
  fix: "Change each link to the same path on your domain. Search the code and the CMS for the temporary name: it is often in a menu, a button or an environment variable.",
  tech: "a[href] whose host ends in .vercel.app, .netlify.app or .pages.dev (checks/launch/hosts.ts), on a page that is not itself served from one",
  run(page) {
    if (isTemporaryHost(new URL(page.finalUrl).hostname)) return [];
    const hrefs = [
      ...new Set(
        page.links.flatMap((l) => {
          try {
            return isTemporaryHost(new URL(l.href).hostname) ? [l.href] : [];
          } catch {
            return [];
          }
        }),
      ),
    ];
    if (hrefs.length === 0) return [];
    return [
      {
        checkId: "temp-host-links",
        severity: "high",
        title: this.title,
        evidence: `${hrefs.length} link${hrefs.length === 1 ? "" : "s"} to a temporary address: ${firstFew(hrefs)}`,
        url: page.finalUrl,
      },
    ];
  },
});
