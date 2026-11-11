import {
  analogFunctions,
  analogPageEndpoints,
  isAngularSite,
  pageBody,
} from "../angular/detect.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

export const angularAnalogEndpointsListed = defineCheck<PageSnapshot>({
  id: "angular-analog-endpoints-listed",
  size: "S",
  done: "Each server function and page endpoint checks who is asking and returns only what any visitor may see.",
  estimateChanges:
    "Endpoints that already check a session and validate input need nothing; each one without takes its own fix.",
  area: "Security & email",
  severity: "low",
  title: "This Analog page calls public endpoints that need a second look",
  what: "A page of this Analog site names a server function (/_analog/fn/<id>) or a page endpoint (/api/_analog/pages/<path>). Both are addresses anyone can request, not only your page.",
  why: "A server function runs for any visitor who calls it, signed in or not, and a page endpoint answers any GET with the page's server data. Treating them as part of the page, instead of as public endpoints, is how booking and patient-list handlers end up open.",
  fix: "Check each server function and page loader: validate the input, check the session inside it, and return only fields the page shows.",
  tech: "Analog sites only, no extra request (Gaugeline never calls a server function, which can be a POST): the names come from /_analog/fn/<id> and /api/_analog/pages/<path> in the page's HTML. They also show the site runs on the server, not as a static build",
  run(page) {
    if (!isAngularSite(page)) return [];
    const { html } = pageBody(page);
    const fns = analogFunctions(html);
    const pages = analogPageEndpoints(html);
    if (fns.length === 0 && pages.length === 0) return [];
    const parts: string[] = [];
    if (fns.length > 0)
      parts.push(`server ${fns.length === 1 ? "function" : "functions"} ${fns.join(", ")}`);
    if (pages.length > 0)
      parts.push(`page ${pages.length === 1 ? "endpoint" : "endpoints"} ${pages.join(", ")}`);
    return [
      {
        checkId: "angular-analog-endpoints-listed",
        severity: "low",
        title: this.title,
        evidence: `the page names ${parts.join(" and ")}`,
        url: page.finalUrl,
      },
    ];
  },
});
