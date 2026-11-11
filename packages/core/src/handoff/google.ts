import { isRecord } from "../connectors/get-json.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { GOOGLE_BUSINESS_TOKEN } from "../listings/sources/google.js";
import { clip, getProviderJson, type ProviderAccess } from "./http.js";
import { googleRole } from "./roles.js";
import type { RawMember, SourceRead } from "./types.js";

const LOCATION = /^locations\/\d{1,24}$/;

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/**
 * Who administers a Google Business Profile location, through the Business Profile Account Management
 * API, with the listings connector's token (GOOGLE_BUSINESS_PROFILE_TOKEN) and its location from
 * gaugeline.listings.json. One GET. Google has no read-only scope for these APIs, so the token can also
 * write: Gaugeline only sends a GET. The endpoint shape is from Google's reference as remembered (the
 * page was unreachable when this was written).
 */
export async function readGoogleAdmins(args: {
  env: Env;
  fetcher: Fetcher;
  location?: string | undefined;
}): Promise<SourceRead> {
  const token = text(args.env[GOOGLE_BUSINESS_TOKEN]);
  if (!token)
    return {
      ok: false,
      reason: `${GOOGLE_BUSINESS_TOKEN} is not set, so Google Business Profile was not asked`,
    };
  if (!args.location)
    return {
      ok: false,
      reason:
        'no Google location is named under "google" in gaugeline.listings.json, so Google Business Profile was not asked',
    };
  if (!LOCATION.test(args.location))
    return { ok: false, reason: 'the Google location must look like "locations/1234567890"' };
  const access: ProviderAccess = {
    provider: "Google Business Profile",
    env: args.env,
    secretVars: [GOOGLE_BUSINESS_TOKEN],
    fetcher: args.fetcher,
    authorization: `Bearer ${token}`,
  };
  const read = await getProviderJson(
    access,
    `https://mybusinessaccountmanagement.googleapis.com/v1/${args.location}/admins`,
    "the location's administrators",
  );
  if (!read.ok) return read;
  if (!isRecord(read.body))
    return {
      ok: false,
      reason:
        "Google answered about the location's administrators with something Gaugeline cannot read",
    };
  const rows = Array.isArray(read.body.admins) ? read.body.admins.filter(isRecord) : [];
  const members: RawMember[] = rows.map((a) => {
    const raw = text(a.role) ?? "";
    const email = text(a.admin);
    return {
      ...(email ? { email } : {}),
      role: googleRole(raw),
      rawRole: clip(raw, 40),
      pending: a.pendingInvitation === true,
    };
  });
  return {
    ok: true,
    subject: args.location,
    account: { kind: "unknown" },
    members,
    notes: [],
  };
}
