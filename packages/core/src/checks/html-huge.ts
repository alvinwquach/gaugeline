import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";
import { HTML_HUGE_BYTES, describeSize, measurePage } from "./weight.js";

export const htmlHuge = defineCheck<PageSnapshot>({
  id: "html-huge",
  area: "Visitors",
  severity: "high",
  title: "This page's HTML is enormous",
  what: "The HTML of the page alone is over 2 MB, before any image, script or stylesheet.",
  why: "Phones on slow connections wait seconds before anything shows, and search engines may stop reading the page before the end.",
  fix: "Find what fills the HTML: usually a framework data payload, inlined SVG or CSS, or a long list rendered in full. Load it on demand or paginate it.",
  tech: "the UTF-8 HTML body is over 2 MB (2,097,152 bytes); html-heavy is not reported for the same page",
  run(page) {
    const last = page.hops.at(-1);
    if (!isHtmlPage(page) || !last) return [];
    const { htmlBytes } = measurePage(last.body ?? "");
    if (htmlBytes <= HTML_HUGE_BYTES) return [];
    return [
      {
        checkId: "html-huge",
        severity: "high",
        title: this.title,
        evidence: `the HTML is ${describeSize(htmlBytes, last.truncated === true)} (${htmlBytes.toLocaleString("en-US")} bytes${last.truncated ? " read, then cut at the limit" : ""})`,
        url: page.finalUrl,
      },
    ];
  },
});
