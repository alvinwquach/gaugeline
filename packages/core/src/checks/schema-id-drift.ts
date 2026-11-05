import { defineCheck } from "../model.js";
import { normaliseId } from "../schema-rules.js";
import type { PageSnapshot } from "../snapshot.js";
import { nodesOfType, schemaPages } from "./schema/common.js";
import { firstFew } from "./site-helpers.js";

export const schemaIdDrift = defineCheck<PageSnapshot>({
  id: "schema-id-drift",
  area: "Search & sharing",
  severity: "high",
  title: "Your organization has more than one identity in structured data",
  what: "The Organization or WebSite @id differs from the one in your schema guide, or differs from page to page.",
  why: "Search engines join structured data across pages by @id. Two ids make two organizations, splitting what is known about yours.",
  fix: "Use one fixed @id for the Organization and one for the WebSite on every page, for example https://example.com/#organization.",
  tech: "an Organization or WebSite @id (compared after resolving and trimming a trailing slash) differs from organizationId/websiteId, or, with no guide, differs between the sampled pages",
  async run(page, ctx) {
    const pages = await schemaPages(page, ctx);
    const out = [];
    for (const [type, configuredRaw] of [
      ["Organization", ctx.schemaRules?.organizationId],
      ["WebSite", ctx.schemaRules?.websiteId],
    ] as const) {
      // Every @id this type is given, normalised, with the raw values and pages it appeared on.
      const ids = new Map<string, { raws: Set<string>; pages: Set<string> }>();
      for (const p of pages) {
        for (const n of nodesOfType(p.flat, type)) {
          if (!n.id || !n.rawId) continue;
          const e = ids.get(n.id) ?? { raws: new Set(), pages: new Set() };
          e.raws.add(n.rawId);
          e.pages.add(p.path);
          ids.set(n.id, e);
        }
      }
      if (ids.size === 0) continue;
      if (configuredRaw) {
        const configured = normaliseId(configuredRaw, page.finalUrl);
        for (const [id, e] of ids) {
          if (id === configured) continue;
          out.push({
            checkId: "schema-id-drift",
            severity: "high" as const,
            title: this.title,
            evidence: `${type} @id ${firstFew([...e.raws].map((r) => `"${r}"`))} on ${firstFew([...e.pages])}; the schema guide says "${configuredRaw}"`,
            url: page.finalUrl,
          });
        }
      } else if (ids.size > 1) {
        out.push({
          checkId: "schema-id-drift",
          severity: "high" as const,
          title: this.title,
          evidence: `${type} has ${ids.size} different @id values: ${firstFew([...ids.values()].map((e) => `"${[...e.raws][0] ?? ""}" on ${firstFew([...e.pages], 2)}`))}`,
          url: page.finalUrl,
        });
      }
    }
    return out;
  },
});
