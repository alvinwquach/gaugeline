import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { isPrivateType } from "./leaks/private-types.js";

export const datasetPrivateTypes = defineCheck<PageSnapshot>({
  id: "dataset-private-types",
  size: "M",
  done: "The dataset is private, the site reads it with a token, and those types cannot be read without one.",
  estimateChanges:
    "A site that reads the dataset from the browser needs those queries moved to the server, which can take a day.",
  area: "Security & email",
  severity: "high",
  title: "Private-looking content is in a public Sanity dataset",
  what: "The Sanity dataset your images come from answers without a token, and it has document types that sound like people's details: orders, inquiries, customers, bookings.",
  why: "Anyone can download those documents with one request: names, emails and whatever else the forms collect.",
  fix: "Make the dataset private in sanity.io/manage today and give the site a read token, or move those types to a private dataset.",
  tech: "As dataset-public, and a type name whose last word is in checks/leaks/private-types.ts (order, inquiry, submission, customer and others); only the type names are read, never the documents. dataset-public is not also reported",
  async run(page, ctx) {
    const reads = (await ctx.datasets?.()) ?? [];
    return reads.flatMap((d) => {
      const types = d.types ?? [];
      const private_ = types.filter(isPrivateType);
      if (d.state !== "public" || private_.length === 0) return [];
      return [
        {
          checkId: "dataset-private-types",
          severity: "high" as const,
          title: this.title,
          evidence: `project ${d.projectId}, dataset "${d.dataset}" answers without a token and has ${private_.map((t) => `"${t}"`).join(", ")} among its ${types.length} types (${d.count ?? 0} documents)`,
          url: page.finalUrl,
        },
      ];
    });
  },
});
