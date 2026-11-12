import { defineCheck } from "../model.js";
import { qfuncCount } from "../qwik/detect.js";
import type { PageSnapshot } from "../snapshot.js";
import { serverFnCount } from "../solidstart/detect.js";
import { frameworkOf } from "./qwik-solid-shared.js";

export const qwikSolidServerEndpoints = defineCheck<PageSnapshot>({
  id: "qwik-solid-server-endpoints",
  size: "S",
  done: "Every server function checks who is calling and what it may do, and none returns more than the page needs.",
  estimateChanges:
    "Each server function is read once; most only need an input check and a session check.",
  area: "Security & email",
  severity: "low",
  title: "This page calls server functions that anyone can address",
  what: "The markup of this Qwik or SolidStart page names a server-function address: Qwik's ?qfunc= (a server$ call) or ?qaction= (a routeAction$ form) or SolidStart's /_server (a \"use server\" function).",
  why: "A server function is a public address: anyone can call it with their own input, whether or not your page has a button for it. It is worth knowing which ones exist and what each one lets a stranger do.",
  fix: 'For each server$ or "use server" function, check the caller (session, role) and validate the input before it reads or writes anything, and return only what the page shows. Gaugeline does not call these addresses.',
  tech: "Qwik and SolidStart pages only, from the page already read, no extra request and never a call: counts occurrences of qfunc= and qaction= (Qwik) or /_server (SolidStart) in the page's markup. Whether a function is safe is not something a read can tell, so this is a heads-up, not a verdict; ?qfunc=, ?qaction= and /_server are from the package source (request-handler runServerFunction; server-runtime.js)",
  async run(page) {
    const framework = frameworkOf(page);
    if (framework === undefined) return [];
    const n = framework === "qwik" ? qfuncCount(page) : serverFnCount(page);
    if (n === 0) return [];
    return [
      {
        checkId: "qwik-solid-server-endpoints",
        severity: "low",
        title: this.title,
        evidence: `the page names ${framework === "qwik" ? "?qfunc= or ?qaction=" : "/_server"} ${n} time${n === 1 ? "" : "s"} (not called)`,
        url: page.finalUrl,
      },
    ];
  },
});
