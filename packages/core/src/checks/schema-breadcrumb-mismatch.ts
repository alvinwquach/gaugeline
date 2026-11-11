import { defineCheck } from "../model.js";
import { compareAddresses } from "../normalise.js";
import type { PageSnapshot } from "../snapshot.js";
import { breadcrumbItems } from "./schema/breadcrumbs.js";
import { schemaPages } from "./schema/common.js";

export const schemaBreadcrumbMismatch = defineCheck<PageSnapshot>({
  id: "schema-breadcrumb-mismatch",
  size: "S",
  done: "The last ListItem of the breadcrumb is the page's canonical address.",
  estimateChanges: "A shared breadcrumb component is one edit.",
  area: "Search & sharing",
  severity: "medium",
  title: "A breadcrumb ends on a different page",
  what: "The last item of a page's breadcrumb structured data points at an address other than the page's own canonical.",
  why: "The trail should end where the visitor is. One that ends elsewhere usually means the breadcrumb was copied from another page.",
  fix: "Make the last ListItem's item the page's canonical address, or leave the last item's URL out.",
  tech: "the highest-position ListItem has a URL that differs from the canonical (or the page address) by scheme, host, path or query; needs a gaugeline.schema.json",
  async run(page, ctx) {
    if (!ctx.schemaRules) return [];
    const out = [];
    for (const p of await schemaPages(page, ctx)) {
      const last = breadcrumbItems(p.flat)?.at(-1);
      if (!last?.url) continue;
      const canonical = p.page.canonical ?? p.page.finalUrl;
      let url: string;
      try {
        url = new URL(last.url, p.page.finalUrl).href;
      } catch {
        continue;
      }
      if (compareAddresses(url, canonical).same) continue;
      out.push({
        checkId: "schema-breadcrumb-mismatch",
        severity: "medium" as const,
        title: this.title,
        evidence: `${p.path}: the breadcrumb ends at ${last.url}; the canonical is ${canonical}`,
        url: p.page.finalUrl,
      });
    }
    return out;
  },
});
