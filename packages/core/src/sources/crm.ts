import * as z from "zod";
import { isReadOnlySalesforceServer, SALESFORCE_READ_ONLY_URL } from "./salesforce-server.js";

/**
 * A CRM as the lead checks see it (X55). The shape is small on purpose: counts, the names of fields,
 * and a yes or no for whether a named field is empty. It cannot hand a check a person's name, an
 * email address or a free-text note, so no check can put one in a finding.
 */
export interface CrmSource {
  /** Plain name for notices: "Salesforce". */
  readonly label: string;
  /** How many leads were created since, and when the newest one arrived. Aggregate only. */
  countLeads(since: Date): Promise<CrmCount>;
  /**
   * The newest leads created since, at most `limit`, each reduced to its record id and which of the
   * named fields are empty. Any field that holds personal data is refused before it is asked for.
   */
  sampleLeads(since: Date, fields: readonly string[], limit?: number): Promise<CrmSample>;
  /** The names of the fields the CRM's lead object has. Names and labels, never values. */
  describeFields(): Promise<CrmField[]>;
}

export interface CrmCount {
  /** Leads created since the given time. */
  total: number;
  /** When the newest of them was created. Absent when there are none. */
  latest?: Date;
}

export interface CrmLead {
  /** The record id (15 or 18 letters and digits). Never a name. */
  id: string;
  /** Which of the asked-for fields are empty on this lead, in the order asked. */
  blank: string[];
}

export interface CrmSample {
  /** The fields that were actually asked for (personal and invalid names are not). */
  fields: string[];
  /** Fields that were refused, and so never requested. */
  refused: string[];
  /** Newest first. */
  leads: CrmLead[];
  /** True when the sample stopped at its limit, so there may be older leads in the window that were not looked at. */
  truncated: boolean;
}

export interface CrmField {
  /** The API name: "LeadSource", "Campaign_Source__c". */
  name: string;
  label?: string;
}

/** Why a CRM gave nothing. Never an error: the run goes on and the checks say they could not check. */
export class CrmUnavailableError extends Error {
  /** Which kind of reason it is, so a caller can tell a stop from a refusal. */
  readonly kind: "refused" | "no-access" | "quota" | "unreachable" | "limit";
  constructor(kind: CrmUnavailableError["kind"], message: string) {
    super(message);
    this.name = "CrmUnavailableError";
    this.kind = kind;
  }
}

/** A SOQL field name. Letters, digits and underscores, starting with a letter: nothing else reaches a query. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
export const isIdentifier = (name: string): boolean => IDENTIFIER.test(name);

/** Standard lead fields that hold a person's details or free text (lower case). */
const PERSONAL_STANDARD: ReadonlySet<string> = new Set([
  "name",
  "firstname",
  "lastname",
  "middlename",
  "suffix",
  "salutation",
  "email",
  "phone",
  "mobilephone",
  "fax",
  "company",
  "title",
  "website",
  "street",
  "city",
  "state",
  "statecode",
  "postalcode",
  "country",
  "countrycode",
  "address",
  "latitude",
  "longitude",
  "geocodeaccuracy",
  "description",
  "photourl",
  "individualid",
  "jigsaw",
  "jigsawcontactid",
  "companydunsnumber",
  "annualrevenue",
  "numberofemployees",
  "industry",
]);

/** A name that says what it holds, wherever it appears, including in a custom field. */
const PERSONAL_WORDS = /email|phone|mobile|birth|ssn|street|passport|firstname|lastname|fullname/i;

/** Is this field one that holds personal data, or free text that may? Such fields are never asked for. */
export function isPersonalField(name: string): boolean {
  const flat = name.toLowerCase();
  return PERSONAL_STANDARD.has(flat) || PERSONAL_WORDS.test(flat);
}

/** Splits requested names into those that may be asked for and those that may not. */
export function splitFields(requested: readonly string[]): {
  allowed: string[];
  refused: string[];
} {
  const allowed: string[] = [];
  const refused: string[] = [];
  for (const raw of requested) {
    const name = raw.trim();
    if (name === "" || allowed.includes(name) || refused.includes(name)) continue;
    if (!isIdentifier(name) || isPersonalField(name)) refused.push(name);
    else allowed.push(name);
  }
  return { allowed, refused };
}

/**
 * A record from the CRM with every personal field removed, whatever the CRM sent back: a server
 * that returns more than was asked for cannot get a name or an email past this. Keys are compared
 * without case. The `attributes` envelope is dropped too; it holds a URL with the record's id.
 */
export function stripPersonal(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === "attributes" || isPersonalField(key)) continue;
    kept[key] = value;
  }
  return kept;
}

/** A Salesforce record id: 15 or 18 letters and digits. Anything else is not shown as an id. */
export const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** A field is empty when it is missing, null or only white space. A zero or false is not empty. */
export function isBlank(value: unknown): boolean {
  return (
    value === undefined || value === null || (typeof value === "string" && value.trim() === "")
  );
}

/**
 * gaugeline.crm.json. Only identifiers and limits live here: the access token is an environment
 * variable and is never in this file.
 */
export const crmConfigSchema = z.strictObject({
  salesforce: z.strictObject({
    /**
     * The read-only objects server. Optional: the default is Salesforce's production address for it.
     * Any other address, including the server that can write, is refused when the file is read.
     */
    server: z
      .string()
      .refine(isReadOnlySalesforceServer, {
        message:
          "must be Salesforce's read-only objects server (sobject-reads). A server that can write is never used",
      })
      .default(SALESFORCE_READ_ONLY_URL),
    /** The fields that say where a lead came from. Default: the standard Lead Source. */
    sourceFields: z
      .array(z.string())
      .min(1)
      .max(4)
      .default(["LeadSource"])
      .refine((names) => names.every(isIdentifier), "must be field names like Campaign_Source__c")
      .refine(
        (names) => names.every((n) => !isPersonalField(n)),
        "must not be a field that holds a person's details",
      ),
    /** How far back to look when there is no previous run to start from. */
    windowDays: z.number().int().min(1).max(30).default(7),
    /** How many days without a lead counts as quiet. */
    quietDays: z.number().int().min(2).max(14).default(3),
  }),
});

export type CrmConfig = z.infer<typeof crmConfigSchema>;

/** The longest time back a window starts, even if the last run was longer ago. */
export const MAX_WINDOW_DAYS = 30;

const DAY = 86_400_000;

/**
 * Where the lead window starts: the last run's time when there is one and it is sensible (in the
 * past, not more than 30 days ago), else `windowDays` before now. "Leads created since the last run."
 */
export function leadWindowStart(now: Date, windowDays: number, previousTakenAt?: string): Date {
  const fallback = new Date(now.getTime() - windowDays * DAY);
  if (previousTakenAt === undefined) return fallback;
  const ms = Date.parse(previousTakenAt);
  if (Number.isNaN(ms) || ms >= now.getTime()) return fallback;
  return new Date(Math.max(ms, now.getTime() - MAX_WINDOW_DAYS * DAY));
}

/** How far back the went-quiet check looks for the busy days before the quiet ones. */
export function quietLookbackDays(quietDays: number): number {
  return Math.max(14, quietDays * 4);
}
