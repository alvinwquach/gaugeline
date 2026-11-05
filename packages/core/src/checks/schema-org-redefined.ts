import { defineCheck } from "../model.js";
import { normaliseId } from "../schema-rules.js";
import type { PageSnapshot } from "../snapshot.js";
import { idPath, nodesOfType, schemaPages } from "./schema/common.js";
import { firstFew } from "./site-helpers.js";

export const schemaOrgRedefined = defineCheck<PageSnapshot>({
  id: "schema-org-redefined",
  area: "Search & sharing",
  severity: "medium",
  title: "Pages redefine your organization instead of referring to it",
  what: "Pages other than the homepage define the Organization or WebSite again, with its properties, instead of referring to the one node by its @id as your schema guide says.",
  why: "Copies drift: one page gets an old logo or phone number, and search engines see several organizations where there should be one.",
  fix: 'On every other page, write {"@id": "<the configured id>"} where the Organization or WebSite is needed, and define it once on the homepage.',
  tech: "an Organization or WebSite node with properties beyond @id and @type on a page other than / (needs organizationId or websiteId in gaugeline.schema.json)",
  async run(page, ctx) {
    const rules = ctx.schemaRules;
    if (!rules?.organizationId && !rules?.websiteId) return [];
    const out = [];
    for (const p of await schemaPages(page, ctx)) {
      if (p.path === "/") continue;
      const redefined = [
        ...(rules.organizationId ? nodesOfType(p.flat, "Organization") : []),
        ...(rules.websiteId ? nodesOfType(p.flat, "WebSite") : []),
      ].filter((n) => n.props.length > 0);
      if (redefined.length === 0) continue;
      const configured = (n: { types: string[] }) =>
        normaliseId(
          (n.types.includes("WebSite") ? rules.websiteId : rules.organizationId) ?? "",
          p.page.finalUrl,
        );
      out.push({
        checkId: "schema-org-redefined",
        severity: "medium" as const,
        title: this.title,
        evidence: `${p.path} defines ${firstFew(redefined.map((n) => `${n.types.join("/")} ${n.rawId ? idPath(n.rawId, p.page.finalUrl) : "(no @id)"} with ${n.props.slice(0, 3).join(", ")}`))} instead of referencing ${firstFew([...new Set(redefined.map((n) => idPath(configured(n), p.page.finalUrl)))])}`,
        url: p.page.finalUrl,
      });
    }
    return out;
  },
});
