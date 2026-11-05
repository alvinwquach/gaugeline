import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isPrivateType } from "./leaks/private-types.js";
import { firstFew } from "./site-helpers.js";

export const datasetPublic = defineCheck<PageSnapshot>({
  id: "dataset-public",
  area: "Security & email",
  severity: "low",
  title: "Your Sanity content can be read by anyone",
  what: "The Sanity dataset your images come from answers queries without a token.",
  why: "That is fine for a blog, and a risk the day someone adds a form or an order type to it: everything in it is readable by anyone who looks.",
  fix: "If nothing in it is private, nothing to do. Otherwise make the dataset private in sanity.io/manage and give the site a read token.",
  tech: 'Project and dataset read from cdn.sanity.io image addresses; one GET to <project>.api.sanity.io with the query {"count": count(*), "types": array::unique(*[]._type)} and no token, at most 2 datasets; never document contents',
  async run(page, ctx) {
    const reads = (await ctx.datasets?.()) ?? [];
    return reads
      .filter((d) => d.state === "public" && !(d.types ?? []).some(isPrivateType))
      .map((d) => ({
        checkId: "dataset-public",
        severity: "low" as const,
        title: this.title,
        evidence: `project ${d.projectId}, dataset "${d.dataset}": ${d.count ?? 0} documents in ${(d.types ?? []).length} types (${firstFew(d.types ?? [], 5)}) answer without a token`,
        url: page.finalUrl,
      }));
  },
});
