import { describeAssertion } from "../assertions/evidence.js";
import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";

export const dataAssertionFailed = defineCheck<PageSnapshot>({
  id: "data-assertion-failed",
  size: "M",
  done: "The assertion returns no rows when it is run again.",
  estimateChanges:
    "A few bad rows are minutes. Rows created by a bug mean fixing the code as well as the rows.",
  area: "Visitors",
  severity: "high",
  title: "A data assertion found rows that should not exist",
  what: "A query you wrote in gaugeline.sources.json to return nothing returned rows: two bookings in one slot, a paid order with no matching payment, a product with no price id.",
  why: "These are the problems a customer finds before you do. No page looks wrong yet, so a check of the page cannot see them, but the next person to book, pay or order runs into one.",
  fix: "Read the rows in the evidence and correct them in the database, or fix the code that wrote them, then run again. If the rule itself is wrong, change the assertion's query.",
  tech: "each assertion is one SELECT that should return no rows, run through the read-only database connector (a statement classifier, BEGIN READ ONLY with a statement timeout and a 5,000 row cap, and the database role); any row is a finding with the assertion's own severity and title, and the evidence is its id, the row count and the allow-listed evidence columns of the first 20 rows; a query that could not run (database down, timeout, wrong evidence column) is could not check, never a pass",
  async run(page, ctx) {
    if (!ctx.assertions) return [];
    const read = await ctx.assertions();
    const found: Finding[] = [];
    for (const r of read.results) {
      if (r.status === "failed")
        found.push({
          checkId: "data-assertion-failed",
          severity: r.severity,
          title: r.title,
          evidence: describeAssertion(r),
          url: page.finalUrl,
        });
      else if (r.status !== "passed")
        ctx.couldNotCheck?.(
          page.finalUrl,
          r.message ?? `The assertion "${r.id}" could not be checked.`,
        );
    }
    return found;
  },
});
