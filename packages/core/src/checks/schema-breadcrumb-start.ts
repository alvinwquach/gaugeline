import { defineCheck } from "../model.js";
import { normaliseId } from "../schema-rules.js";
import type { PageSnapshot } from "../snapshot.js";
import { breadcrumbItems } from "./schema/breadcrumbs.js";
import { idPath, schemaPages } from "./schema/common.js";

export const schemaBreadcrumbStart = defineCheck<PageSnapshot>({
  id: "schema-breadcrumb-start",
  area: "Search & sharing",
  severity: "low",
  title: "Breadcrumbs don't start where your guide says",
  what: "The first item of a page's breadcrumb structured data is not the Home name and address your schema guide sets.",
  why: "Search results show the breadcrumb trail; one that starts somewhere else on some pages looks inconsistent and can point at the wrong page.",
  fix: "Start every BreadcrumbList with the configured first item, for example Home at /.",
  tech: "the lowest-position ListItem's name or URL differs from breadcrumbs.firstName / breadcrumbs.firstUrl in gaugeline.schema.json (name case ignored, URL resolved)",
  async run(page, ctx) {
    const rule = ctx.schemaRules?.breadcrumbs;
    if (!rule) return [];
    const out = [];
    for (const p of await schemaPages(page, ctx)) {
      const first = breadcrumbItems(p.flat)?.[0];
      if (!first) continue;
      const nameOk =
        (first.name ?? "").trim().toLowerCase() === rule.firstName.trim().toLowerCase();
      const urlOk =
        first.url !== undefined &&
        normaliseId(first.url, p.page.finalUrl) === normaliseId(rule.firstUrl, p.page.finalUrl);
      if (nameOk && urlOk) continue;
      out.push({
        checkId: "schema-breadcrumb-start",
        severity: "low" as const,
        title: this.title,
        evidence: `${p.path}: the breadcrumb starts with "${first.name ?? ""}" at ${first.url ? idPath(first.url, p.page.finalUrl) : "(no URL)"}; the guide says "${rule.firstName}" at ${rule.firstUrl}`,
        url: p.page.finalUrl,
      });
    }
    return out;
  },
});
