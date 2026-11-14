import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import {
  compareFieldNames,
  crmPart,
  shown,
  unreadableSalesforceForms,
  webToLeadForms,
} from "./crm-shared.js";

/** Names listed in one finding; the rest are counted. */
const MAX_NAMES = 8;

export const crmFieldNames = defineCheck<PageSnapshot>({
  id: "crm-field-names",
  size: "S",
  done: "Every form field the CRM did not know now exists there, or the input is removed from the form.",
  estimateChanges:
    "New fields in the CRM need someone with admin rights, and each form that sends them needs the same name.",
  area: "Leads",
  severity: "medium",
  title: "A form sends fields the CRM doesn't have",
  what: "A Web-to-Lead form on the page submits field names that are not fields on the Lead object in Salesforce.",
  why: "Salesforce drops what it can't place. The visitor typed it, the form said thanks, and the CRM never got it.",
  fix: "Add the field to Lead in Salesforce and use its name in the form, or remove the input from the form.",
  tech: "The names of every input, select and textarea in each Web-to-Lead form in the HTML (hidden or visible; buttons and files excluded) against the field names and labels of Lead from Salesforce's read-only MCP server (getObjectSchema); Web-to-Lead's own names (first_name, zip, lead_source) are matched to their Lead fields; routing, anti-spam and utm_* names are skipped; custom fields sent by id (00N...) can't be compared and are counted; a form in an iframe or drawn by script is could-not-check",
  async run(page, ctx) {
    const forms = webToLeadForms(page);
    const hidden = unreadableSalesforceForms(page);
    if (forms.length === 0 && hidden.length === 0) return [];
    const read = await crmPart(page, ctx, "fields");
    const fields = read?.fields;
    if (!read || !fields) return [];
    if (hidden.length > 0 && forms.length === 0)
      ctx.couldNotCheck?.(
        page.finalUrl,
        "A Salesforce form on this page is inside an iframe or drawn by JavaScript, so its field names were not read and not compared with Lead.",
      );
    const found = [];
    for (const form of forms) {
      const result = compareFieldNames(form.fieldNames, fields);
      if (result.missing.length === 0) continue;
      const names = result.missing.slice(0, MAX_NAMES).map((n) => shown(n));
      const more = result.missing.length - names.length;
      const aside =
        result.byId > 0
          ? `; ${result.byId} custom field${result.byId === 1 ? " was" : "s were"} sent by id and not compared`
          : "";
      found.push({
        checkId: "crm-field-names",
        severity: "medium" as const,
        title: this.title,
        evidence: `A Web-to-Lead form sends ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}, which Lead has no field for (${result.matched} other field${result.matched === 1 ? "" : "s"} matched${aside})`,
        url: page.finalUrl,
      });
    }
    return found;
  },
});
