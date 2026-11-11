import { devMarkers, isAngularSite, pageBody } from "../angular/detect.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

export const angularDevToolsPublic = defineCheck<PageSnapshot>({
  id: "angular-dev-tools-public",
  size: "S",
  done: "The live pages come from a production build, with no dev client in their HTML.",
  estimateChanges:
    "If the host runs `ng serve` or `analog dev` as its start command, the deploy settings change too.",
  area: "Launch day",
  severity: "high",
  title: "The live Angular site is serving its development tools",
  what: "A page of this Angular or Analog site loads the Vite dev client or the dev server's component update address. Those exist only when the site runs from `ng serve` or `analog dev`.",
  why: "A development server is slow, serves unminified source and modules, and shows error overlays a built site never does. Visitors see an unfinished site and anyone can read how it is put together.",
  fix: "Deploy the output of `ng build` (or `analog build`) instead of running the dev server on the host.",
  tech: "Angular sites only, no extra request: the page's own HTML is searched for src=/@vite/client, /@ng/component (Angular's dev-server component updates) and /@analogjs/ module addresses",
  run(page) {
    if (!isAngularSite(page)) return [];
    const found = devMarkers(pageBody(page).html);
    if (found.length === 0) return [];
    return [
      {
        checkId: "angular-dev-tools-public",
        severity: "high",
        title: this.title,
        evidence: `the page carries ${found.join(", ")}`,
        url: page.finalUrl,
      },
    ];
  },
});
