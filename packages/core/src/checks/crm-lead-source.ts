import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { crmPart, day, shown } from "./crm-shared.js";

/** A lead source is a problem when at least this many leads, and this share of them, have it empty. */
export const MIN_BLANK_LEADS = 2;
export const MIN_BLANK_SHARE = 0.1;
/** Record ids shown in the evidence. */
export const MAX_IDS = 5;

export const crmLeadSource = defineCheck<PageSnapshot>({
  id: "crm-lead-source",
  size: "M",
  done: "New leads arrive with a source and campaign, and the older records are filled in.",
  estimateChanges:
    "Several forms each need the hidden fields. Filling in old records is a separate data job.",
  area: "Leads",
  severity: "medium",
  title: "New leads are arriving without a source",
  what: "Many of the leads created in your CRM since the last run have an empty lead source or campaign field.",
  why: "A lead with no source can't be tied to the ad, email or search that brought it, so the campaign that worked looks the same as the one that didn't.",
  fix: "Make the form send the source: add hidden utm_source and utm_campaign fields, map them to the CRM's lead source or campaign field, and fill the existing records that have none.",
  tech: "Through Salesforce's read-only MCP server (soqlQuery on Lead, newest 200 created since the last run or windowDays ago): leads whose LeadSource, or each field named in sourceFields in gaugeline.crm.json, is null or blank; flagged at 2 or more leads and 10% or more of the sample; evidence is the counts, the field names and up to five record ids, never a name or an email",
  async run(page, ctx) {
    const read = await crmPart(page, ctx, "recent");
    const recent = read?.recent;
    if (!read || !recent) return [];
    for (const name of recent.missingFields)
      ctx.couldNotCheck?.(
        page.finalUrl,
        `Lead has no field called ${shown(name)}, so it was not checked. Check sourceFields in gaugeline.crm.json against the field names in Salesforce.`,
      );
    const { sample, since } = recent;
    if (sample.leads.length === 0) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        `No leads were created since ${day(since)}, so there were no lead sources to check.`,
      );
      return [];
    }
    const blankLeads = sample.leads.filter((l) => l.blank.length > 0);
    if (
      blankLeads.length < MIN_BLANK_LEADS ||
      blankLeads.length / sample.leads.length < MIN_BLANK_SHARE
    )
      return [];
    const perField = sample.fields
      .map((f) => [f, sample.leads.filter((l) => l.blank.includes(f)).length] as const)
      .filter(([, n]) => n > 0);
    const subject =
      sample.fields.length === 1
        ? `an empty ${shown(sample.fields[0] ?? "")}`
        : `an empty source field (${perField.map(([f, n]) => `${shown(f)}: ${n}`).join(", ")})`;
    const of = sample.truncated
      ? `${blankLeads.length} of the newest ${sample.leads.length} leads`
      : `${blankLeads.length} of ${sample.leads.length} leads`;
    const ids = blankLeads.slice(0, MAX_IDS).map((l) => l.id);
    return [
      {
        checkId: "crm-lead-source",
        severity: "medium",
        title: this.title,
        evidence: `${of} created since ${day(since)} have ${subject}. Example record ids: ${ids.join(", ")}`,
        url: page.finalUrl,
      },
    ];
  },
});
