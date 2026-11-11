import { defineCheck, type Finding } from "../model.js";
import { classifyErrorShell, SHELL_LABEL } from "../error-pages/markers.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

/** Why a page was not judged. Reads after "could not be checked:". */
export const UNREAD_REASON =
  "the page body was cut at the size cap before an error message could be told from the page, so it is not judged";

/** The address without its query or fragment: a finding names the page, nothing more. */
function where(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

export const errorShell200 = defineCheck<PageSnapshot>({
  id: "error-shell-200",
  area: "Search & sharing",
  severity: "high",
  title: "A page that is an error says everything is fine",
  what: 'A page this run read answers 200 (success), but what it shows is an error: a framework\'s error page, or a title or heading such as "Page not found" or "Something went wrong".',
  why: "Google and other crawlers believe the status code. A broken page that says 200 can stay in search results, be treated as a soft 404, and wastes visits: a customer lands on the error and your monitoring, which looks at status codes, stays green.",
  fix: "Make the page answer the status it shows: 404 (or 410) for a page that is gone, 500 for a failure, or fix the page so it shows its content. In Next.js call notFound() and let the not-found page set 404; in Nuxt, SvelteKit and Remix throw an error with the status instead of rendering a page with an error message.",
  tech: "no request of its own: it reads the checked page and the same-site pages the run already fetched (the shared sample other checks use), 2xx HTML only. Reads the first 200,000 characters of each body. A finding is a framework error page (Next.js html id __next_error__ or its client-side exception text, the Nuxt error page, the SvelteKit error template, the React Router and Remix default error boundary) or a title or first heading that is wholly an error phrase (English, Spanish, French, German, Italian, Portuguese, Dutch) on a page with under 150 visible words. The finding shows the address and the kind of marker, never page text. A body cut at the size cap with no marker is could not check. A page with no marker passes only for these markers",
  size: "S",
  done: "Every page that shows an error answers 404, 410 or 500, and a page that answers 200 shows its content.",
  estimateChanges:
    "One shared layout that renders an error for every missing record is one fix. Pages that each catch their own errors and render a message are one fix each.",
  async run(page, ctx) {
    const pages = (await ctx.pages?.()) ?? [page];
    const findings: Finding[] = [];
    for (const p of pages) {
      if (!isHtmlPage(p)) continue;
      const read = classifyErrorShell(p);
      if (read.kind) {
        findings.push({
          checkId: this.id,
          severity: this.severity,
          title: this.title,
          evidence: `${where(p.finalUrl)} answers ${p.status} but shows ${SHELL_LABEL[read.kind]}`,
          url: p.finalUrl,
        });
      } else if (read.unread) {
        ctx.couldNotCheck?.(p.finalUrl, UNREAD_REASON);
      }
    }
    return findings;
  },
});
