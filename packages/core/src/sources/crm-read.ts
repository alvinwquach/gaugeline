import {
  CrmUnavailableError,
  leadWindowStart,
  quietLookbackDays,
  type CrmConfig,
  type CrmCount,
  type CrmField,
  type CrmSample,
} from "./crm.js";
import {
  NotReadOnlyServerError,
  salesforceMcpSource,
  type McpTransport,
} from "./salesforce-mcp.js";

/** The variable the transport reads the access token from. Core never sees its value. */
export const CRM_ENV_VARS: readonly string[] = Object.freeze(["SALESFORCE_MCP_ACCESS_TOKEN"]);

/** What the run was told about the CRM: the file's settings, and how to reach the server. */
export interface CrmSettings {
  config: CrmConfig;
  /**
   * How messages reach the MCP server. Absent when none is available: the lead checks then say they
   * could not check, with the reason, and nothing is requested.
   */
  transport?: McpTransport;
  /** Sent to the server as the client's version. */
  clientVersion?: string;
}

export type CrmPart = "fields" | "recent" | "window";

/** Everything the three lead checks read, once per run. Each part is there, or has a reason it is not. */
export interface CrmRead {
  source: string;
  /** The Lead object's field names. */
  fields?: CrmField[];
  /** The newest leads since the last run (or `windowDays` ago), reduced to ids and which source fields are empty. */
  recent?: { since: Date; sample: CrmSample; missingFields: string[] };
  /** The lead count and newest lead over the lookback the went-quiet check uses. */
  window?: { since: Date; days: number; quietDays: number; count: CrmCount };
  /** Why a part is missing, in plain words. Every part without data has one. */
  reasons: Partial<Record<CrmPart, string>>;
}

/** Said when a lead check was asked for by id and gaugeline.crm.json is not there: not a pass. */
export const NO_CRM =
  "No CRM is set up, so leads were not checked. Add gaugeline.crm.json to name your Salesforce read-only server (see docs/sources/salesforce-mcp).";

/** Said when the file is there but this build of Gaugeline has no way to reach the server. */
export const NO_TRANSPORT =
  "This build of Gaugeline has no connection to Salesforce's MCP server yet, so the CRM was not checked. It is waiting on a reviewed decision to allow the one request that MCP needs (see docs/sources/salesforce-mcp).";

export function noCrm(): CrmRead {
  return { source: "Salesforce", reasons: { fields: NO_CRM, recent: NO_CRM, window: NO_CRM } };
}

function allReasons(message: string): CrmRead["reasons"] {
  return { fields: message, recent: message, window: message };
}

const PARTS: readonly CrmPart[] = ["fields", "recent", "window"];

/**
 * Read the CRM: the Lead field names, the newest leads since the window starts, and the lead count
 * over the lookback. Four requests after the handshake at most, however many checks use them. A
 * CRM that cannot be read (wrong server, no access, quota nearly used) gives a reason, never an
 * error. Only counts, field names and record ids are kept.
 */
export async function readCrm(
  settings: CrmSettings,
  now: Date,
  previousTakenAt?: string,
): Promise<CrmRead> {
  const cfg = settings.config.salesforce;
  if (!settings.transport) return { source: "Salesforce", reasons: allReasons(NO_TRANSPORT) };
  let source;
  try {
    source = salesforceMcpSource({
      server: cfg.server,
      transport: settings.transport,
      ...(settings.clientVersion ? { clientVersion: settings.clientVersion } : {}),
    });
  } catch (err) {
    if (err instanceof NotReadOnlyServerError)
      return { source: "Salesforce", reasons: allReasons(err.message) };
    throw err;
  }
  const out: CrmRead = { source: source.label, reasons: {} };
  try {
    out.fields = await source.describeFields();

    const known = new Map(out.fields.map((f) => [f.name.toLowerCase(), f.name]));
    const present = cfg.sourceFields.flatMap((n) => {
      const real = known.get(n.toLowerCase());
      return real ? [real] : [];
    });
    const since = leadWindowStart(now, cfg.windowDays, previousTakenAt);
    if (present.length === 0) {
      out.reasons.recent = `Lead has no field called ${cfg.sourceFields.join(" or ")}, so lead sources were not checked. Check sourceFields in gaugeline.crm.json against the field names in Salesforce.`;
    } else {
      const sample = await source.sampleLeads(since, present);
      // A named field that Lead does not have is kept apart; the rest are still checked.
      const missingFields = cfg.sourceFields.filter((n) => !known.has(n.toLowerCase()));
      out.recent = { since, sample, missingFields };
    }

    const days = quietLookbackDays(cfg.quietDays);
    const lookback = new Date(now.getTime() - days * 86_400_000);
    out.window = {
      since: lookback,
      days,
      quietDays: cfg.quietDays,
      count: await source.countLeads(lookback),
    };
  } catch (err) {
    if (!(err instanceof CrmUnavailableError)) throw err;
    for (const part of PARTS) {
      if (out[part] === undefined && out.reasons[part] === undefined)
        out.reasons[part] = err.message;
    }
  }
  return out;
}

/** The read, once, on first use. */
export function lazyCrm(
  settings: CrmSettings,
  options: { now: () => Date; previousTakenAt?: string },
): () => Promise<CrmRead> {
  let pending: Promise<CrmRead> | undefined;
  return () => (pending ??= readCrm(settings, options.now(), options.previousTakenAt));
}
