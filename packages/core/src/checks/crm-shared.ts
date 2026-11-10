import type { CheckContext } from "../model.js";
import { PROVIDERS, detectForms } from "../forms/providers.js";
import type { FormSighting } from "../forms/types.js";
import type { CrmField } from "../sources/crm.js";
import type { CrmPart, CrmRead } from "../sources/crm-read.js";
import type { PageSnapshot } from "../snapshot.js";
import { escapeInvisible } from "./hidden-text/escape.js";

/**
 * What the three lead checks (X55) share. They read the CRM through ctx.crm, which returns counts,
 * field names and record ids and nothing else, so nothing here can put a person's details into a
 * finding. A part of the read that is missing is reported once, as could-not-check with its reason.
 */

/** The CRM read, when it is configured and `part` has data; else the reason goes to couldNotCheck. */
export async function crmPart(
  page: PageSnapshot,
  ctx: CheckContext,
  part: CrmPart,
): Promise<CrmRead | undefined> {
  if (!ctx.crm) return undefined;
  const read = await ctx.crm();
  if (read[part] === undefined) {
    ctx.couldNotCheck?.(
      page.finalUrl,
      read.reasons[part] ?? "The CRM gave no answer, so leads were not checked.",
    );
    return undefined;
  }
  return read;
}

/** A calendar day, "2026-11-03", in UTC. */
export const day = (d: Date): string => d.toISOString().slice(0, 10);

/** A name from the site or the CRM, made safe to print. */
export const shown = (name: string, max = 40): string => escapeInvisible(name, max);

// ---- crm-field-names -------------------------------------------------------------------------

/**
 * Web-to-Lead's own field names, and the Lead field each one fills. The form's names are Salesforce's
 * (first_name, zip), not the API names (FirstName, PostalCode), so they are matched through this table.
 */
const WEB_TO_LEAD_NAMES: Readonly<Record<string, string>> = {
  first_name: "FirstName",
  last_name: "LastName",
  salutation: "Salutation",
  email: "Email",
  company: "Company",
  phone: "Phone",
  mobile: "MobilePhone",
  fax: "Fax",
  title: "Title",
  url: "Website",
  street: "Street",
  city: "City",
  state: "State",
  zip: "PostalCode",
  country: "Country",
  description: "Description",
  lead_source: "LeadSource",
  industry: "Industry",
  revenue: "AnnualRevenue",
  employees: "NumberOfEmployees",
  rating: "Rating",
  emailoptout: "HasOptedOutOfEmail",
  email_opt_out: "HasOptedOutOfEmail",
};

/** Names the form sends that are not Lead fields on purpose: routing, anti-spam and campaign tags. */
const TECHNICAL =
  /^(?:oid|retURL|debug|debugEmail|encoding|recordType|captcha_settings|g-recaptcha-response|h-captcha-response|cf-turnstile-response|campaign_id|member_status|_?csrf.*|authenticity_token|_wpnonce|_wp_http_referer|form_?id|action|utm_.*|gclid|fbclid|msclkid)$/i;

/** A custom field sent by its id ("00N5e00000AbCdE"): the id cannot be compared with a field name. */
const CUSTOM_FIELD_ID = /^00N[A-Za-z0-9]{12,15}$/;

/** "Lead_Source", "lead source" and "LeadSource" are one name; a custom field's "__c" is dropped. */
const flat = (name: string): string =>
  name
    .replace(/__c$/i, "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

export interface FieldNameProblem {
  /** Names the form sends that Lead has no field for. */
  missing: string[];
  matched: number;
  /** Custom fields sent by id, which were not compared. */
  byId: number;
}

/** Compare the field names one form sends with the fields Lead has. */
export function compareFieldNames(
  names: readonly string[],
  fields: readonly CrmField[],
): FieldNameProblem {
  const known = new Set<string>();
  for (const f of fields) {
    known.add(flat(f.name));
    if (f.label) known.add(flat(f.label));
  }
  const missing: string[] = [];
  let matched = 0;
  let byId = 0;
  for (const raw of names) {
    const name = raw.trim();
    if (name === "" || TECHNICAL.test(name)) continue;
    if (CUSTOM_FIELD_ID.test(name)) {
      byId += 1;
      continue;
    }
    const alias = WEB_TO_LEAD_NAMES[name.toLowerCase()];
    if (known.has(flat(alias ?? name))) matched += 1;
    else missing.push(name);
  }
  return { missing, matched, byId };
}

/** A Web-to-Lead form in the HTML, with the names of the fields it submits. */
export interface ReadableForm {
  position: number;
  fieldNames: string[];
}

/** The Web-to-Lead forms whose field names can be read: forms in the HTML, found by position in the snapshot. */
export function webToLeadForms(page: PageSnapshot): ReadableForm[] {
  const names = new Map(page.forms.map((f, i) => [f.position ?? i, f.fieldNames] as const));
  return detectForms(page).flatMap((s) => {
    const fieldNames = names.get(s.position);
    return s.provider === "salesforce-web-to-lead" && s.kind === "form" && fieldNames
      ? [{ position: s.position, fieldNames }]
      : [];
  });
}

/** Salesforce-bound forms the check cannot read the fields of: inside an iframe, or drawn by script. */
export function unreadableSalesforceForms(page: PageSnapshot): FormSighting[] {
  return detectForms(page).filter(
    (s) =>
      (s.provider === "salesforce-web-to-lead" || s.provider === "pardot") && s.kind !== "form",
  );
}

// ---- crm-went-quiet --------------------------------------------------------------------------

/** The labels of the recognised form providers that have a form (or its embed) on the page. */
export function formProvidersOnPage(page: PageSnapshot): string[] {
  const ids = new Set(
    detectForms(page).flatMap((s) => (s.provider === "unknown" ? [] : [s.provider])),
  );
  return PROVIDERS.filter((p) => ids.has(p.id)).map((p) => p.label);
}

/** Names in a sentence: "A", "A and B", "A, B and C". */
export function joined(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}
