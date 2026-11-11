import { devMarkers, isAstroSite, pageBody } from "../astro/detect.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

export const astroDevToolsPublic = defineCheck<PageSnapshot>({
  id: "astro-dev-tools-public",
  size: "S",
  done: "The live pages come from `astro build`, with no dev client or dev toolbar in their HTML.",
  estimateChanges:
    "If the host runs `astro dev` as its start command, the deploy settings change too.",
  area: "Launch day",
  severity: "high",
  title: "The live Astro site is serving its development tools",
  what: "A page of this Astro site loads the Vite dev client or the Astro dev toolbar, or carries data-astro-source-file attributes. Those exist only when the site runs from `astro dev`.",
  why: "A development server is slow, exposes source file paths, and serves modules and errors that a built site never does. Visitors see an unfinished site and anyone can read how it is put together.",
  fix: "Deploy the output of `astro build` (a static folder, or the server adapter's output) instead of running `astro dev` on the host.",
  tech: "Astro sites only, no extra request: the page's own HTML is searched for src=/@vite/client, the dev-toolbar entrypoint under /@id/astro/runtime/client/dev-toolbar/, an astro-dev-toolbar element, or data-astro-source-file attributes",
  run(page) {
    if (!isAstroSite(page)) return [];
    const found = devMarkers(pageBody(page).html);
    if (found.length === 0) return [];
    return [
      {
        checkId: "astro-dev-tools-public",
        severity: "high",
        title: this.title,
        evidence: `the page carries ${found.join(", ")}`,
        url: page.finalUrl,
      },
    ];
  },
});
