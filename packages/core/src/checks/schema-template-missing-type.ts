import { defineCheck } from "../model.js";
import { matchTemplate } from "../schema-rules.js";
import type { PageSnapshot } from "../snapshot.js";
import { noStructuredData, schemaPages, warnSkipped } from "./schema/common.js";

/** Common schema.org subtypes that satisfy a required type: an AboutPage is a WebPage. */
const SUBTYPES: Readonly<Record<string, readonly string[]>> = {
  WebPage: [
    "AboutPage",
    "CheckoutPage",
    "CollectionPage",
    "ContactPage",
    "FAQPage",
    "ItemPage",
    "MedicalWebPage",
    "ProfilePage",
    "QAPage",
    "SearchResultsPage",
  ],
  Article: [
    "NewsArticle",
    "BlogPosting",
    "TechArticle",
    "ScholarlyArticle",
    "Report",
    "SocialMediaPosting",
    "AdvertiserContentArticle",
    "SatiricalArticle",
  ],
  Organization: [
    "Corporation",
    "LocalBusiness",
    "MedicalOrganization",
    "NGO",
    "EducationalOrganization",
    "GovernmentOrganization",
  ],
};

function hasType(types: ReadonlySet<string>, required: string): boolean {
  return types.has(required) || (SUBTYPES[required] ?? []).some((t) => types.has(t));
}

export const schemaTemplateMissingType = defineCheck<PageSnapshot>({
  id: "schema-template-missing-type",
  size: "S",
  done: "The template's structured data includes the required type.",
  estimateChanges: "Several templates that share the component are fixed once.",
  area: "Search & sharing",
  severity: "medium",
  title: "A page is missing structured data its template requires",
  what: "A page that matches one of your schema guide's templates (for example /blog/*) lacks a type the guide requires there, such as Article or BreadcrumbList.",
  why: "Rich results for that kind of page depend on the type, and one template that drifted usually means every page built from it did.",
  fix: "Add the missing type to the template's structured data component.",
  tech: "the most specific matching template's require list has a type missing from the page's JSON-LD (@type anywhere, @graph included); common subtypes count (an AboutPage is a WebPage, a BlogPosting an Article); needs templates in gaugeline.schema.json",
  async run(page, ctx) {
    const templates = ctx.schemaRules?.templates;
    if (!templates || templates.length === 0) return [];
    const pages = await schemaPages(page, ctx);
    if (noStructuredData(pages)) {
      // One could-not-check outcome for the run, not a finding per page.
      throw new Error(
        "None of the checked pages has structured data, so the schema guide's templates could not be checked.",
      );
    }
    warnSkipped(pages, ctx, "schema-template-missing-type");
    const out = [];
    for (const p of pages) {
      const t = matchTemplate(p.path, templates);
      if (!t) continue;
      const missing = t.require.filter((type) => !hasType(p.flat.types, type));
      if (missing.length === 0) continue;
      out.push({
        checkId: "schema-template-missing-type",
        severity: "medium" as const,
        title: this.title,
        evidence: `${p.path} matches "${t.match}" but has no ${missing.join(", ")}`,
        url: p.page.finalUrl,
      });
    }
    return out;
  },
});
