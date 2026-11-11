import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";
import { HTML_HUGE_BYTES, INLINE_DATA_HEAVY_BYTES, describeSize, measurePage } from "./weight.js";

export const htmlHeavy = defineCheck<PageSnapshot>({
  id: "html-heavy",
  size: "M",
  done: "The page sends only the fields it renders.",
  estimateChanges:
    "A framework data payload shared by many pages is trimmed in one place. Pages that pass whole records to the browser need one edit each.",
  area: "Visitors",
  severity: "medium",
  title: "Most of this page's HTML is a data payload",
  what: "More than half of the HTML, and over 300 KB, is inline data (JSON, __NEXT_DATA__ or a framework's streamed payload) rather than content.",
  why: "Every visitor downloads data the page may never show, and it delays the first paint on phones.",
  fix: "Send only the fields the page renders. In Next.js, trim what getServerSideProps or a server component passes to client components.",
  tech: "inline data scripts are over 300 KB (307,200 bytes) and more than half the HTML; not reported when html-huge is",
  run(page) {
    const last = page.hops.at(-1);
    if (!isHtmlPage(page) || !last) return [];
    const m = measurePage(last.body ?? "");
    // Never both for one page: html-huge is the higher finding.
    if (m.htmlBytes > HTML_HUGE_BYTES) return [];
    if (m.inlineDataBytes <= INLINE_DATA_HEAVY_BYTES || m.inlineDataBytes * 2 <= m.htmlBytes)
      return [];
    const pct = Math.round((m.inlineDataBytes / m.htmlBytes) * 100);
    return [
      {
        checkId: "html-heavy",
        severity: "medium",
        title: this.title,
        evidence: `${describeSize(m.inlineDataBytes)} of ${describeSize(m.htmlBytes)} HTML (${pct}%) is inline data`,
        url: page.finalUrl,
      },
    ];
  },
});
