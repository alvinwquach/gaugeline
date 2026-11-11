import { actionNames, isAstroSite, pageBody, serverIslandNames } from "../astro/detect.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

export const astroEndpointsListed = defineCheck<PageSnapshot>({
  id: "astro-endpoints-listed",
  size: "S",
  done: "Each action validates its input and checks who is asking, and each server island shows nothing it should not.",
  estimateChanges:
    "Actions that already check a session and validate with a schema need nothing; each one without takes its own fix.",
  area: "Security & email",
  severity: "low",
  title: "This Astro page calls public endpoints that need a second look",
  what: "A page of this Astro site calls Astro Actions (/_actions/<name>) or loads server islands (/_server-islands/<name>). Both are addresses anyone can request, not only your page.",
  why: "An action runs for any visitor who posts to it, signed in or not, and a server island answers any GET. Treating them as part of the page, instead of as public endpoints, is how booking and contact handlers end up open.",
  fix: "Check each action handler: validate the input (an Astro Action takes a Zod schema), check the session inside it, and rate-limit it. For a server island, confirm it renders only what any visitor may see.",
  tech: "Astro sites only, no extra request (Gaugeline never calls an action, which is a POST): the names come from /_actions/<name> and ?_action=<name> in the page's HTML and /_server-islands/<name> in its scripts. They also show the site runs on the server (an adapter), not as a static build",
  run(page) {
    if (!isAstroSite(page)) return [];
    const { html } = pageBody(page);
    const actions = actionNames(html);
    const islands = serverIslandNames(html);
    if (actions.length === 0 && islands.length === 0) return [];
    const parts = [
      actions.length > 0
        ? `calls ${actions.length === 1 ? "action" : "actions"} ${actions.join(", ")}`
        : "",
      islands.length > 0
        ? `loads ${islands.length === 1 ? "server island" : "server islands"} ${islands.join(", ")}`
        : "",
    ].filter(Boolean);
    return [
      {
        checkId: "astro-endpoints-listed",
        severity: "low",
        title: this.title,
        evidence: `the page ${parts.join(" and ")}`,
        url: page.finalUrl,
      },
    ];
  },
});
