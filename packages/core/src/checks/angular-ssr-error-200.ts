import { errorMarkers, isAngularSite, pageBody } from "../angular/detect.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

export const angularSsrError200 = defineCheck<PageSnapshot>({
  id: "angular-ssr-error-200",
  size: "M",
  done: "A failed render answers 500, and the page carries no error code or stack trace.",
  estimateChanges:
    "The server-only failure needs finding first (browser-only code run on the server is the usual one); the status handling is a small change.",
  area: "Launch day",
  severity: "medium",
  title: "An Angular error is served as a normal page",
  what: "A page of this Angular or Analog site answers 200 OK but its text contains an Angular error code, an injector error, a browser-only ReferenceError or a stack trace through @angular.",
  why: "Search engines index a page that answers 200, error text included, and visitors see a broken page that no monitor flags. The stack trace also shows how the server is built.",
  fix: "Find the server-side failure (code that uses window, document or localStorage must run only in the browser) and make the render error answer 500, or the 404 route answer 404, instead of returning the error as the page.",
  tech: "Angular sites only, no extra request: when the final response is 200, the page's text outside script and style elements is searched for NG0xxx: messages, NullInjectorError or R3InjectorError, a ReferenceError for window, document, localStorage, sessionStorage or navigator, and indented stack frames through node_modules/@angular/",
  run(page) {
    const hop = page.hops.at(-1);
    if (hop?.status !== 200 || !isAngularSite(page)) return [];
    const found = errorMarkers(pageBody(page).html);
    if (found.length === 0) return [];
    return [
      {
        checkId: "angular-ssr-error-200",
        severity: "medium",
        title: this.title,
        evidence: `the page answers 200 and contains ${found.join(", ")}`,
        url: page.finalUrl,
      },
    ];
  },
});
