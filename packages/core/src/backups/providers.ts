import { isRecord } from "../connectors/get-json.js";
import {
  DEFAULT_DATASET,
  SANITY_DATASET,
  SANITY_PROJECT_ID,
  SANITY_TOKEN,
} from "../connectors/sanity.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { clip, getProviderJson, type ProviderAccess } from "../handoff/http.js";
import type { PlatformRead } from "./types.js";

/** Where the Supabase token is read from: the name Supabase's own command line uses. */
export const SUPABASE_TOKEN_VAR = "SUPABASE_ACCESS_TOKEN";
export const BACKUPS_ENV_VARS = [
  SUPABASE_TOKEN_VAR,
  SANITY_TOKEN,
  SANITY_PROJECT_ID,
  SANITY_DATASET,
] as const;

const SUPABASE_API = "https://api.supabase.com";
/** The projects API (not the content API on <project>.api.sanity.io): the version is the date it was fixed. */
const SANITY_API = "https://api.sanity.io/v2021-06-07";

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** An ISO time from a string, or from seconds since the epoch. Undefined for anything else. */
function timeOf(v: unknown): string | undefined {
  const ms =
    typeof v === "number" && Number.isFinite(v) && v > 0
      ? v < 1e11
        ? v * 1000
        : v
      : typeof v === "string"
        ? Date.parse(v)
        : NaN;
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

const newest = (times: readonly (string | undefined)[]): string | undefined =>
  times.reduce<string | undefined>(
    (best, t) =>
      t !== undefined && (best === undefined || Date.parse(t) > Date.parse(best)) ? t : best,
    undefined,
  );

export interface SupabaseArgs {
  env: Env;
  fetcher: Fetcher;
  projectRef: string;
}

/**
 * Supabase's backups for one project: one GET of `GET /v1/projects/{ref}/database/backups` on the
 * Management API, with a personal access token from SUPABASE_ACCESS_TOKEN in a header. The answer says
 * whether daily backups (`walg_enabled`) and point-in-time recovery (`pitr_enabled`) are on, lists the
 * backups with a status and a time (`backups[].status`, `inserted_at`), and, with point-in-time
 * recovery, the latest restorable moment (`physical_backup_data.latest_physical_backup_date_unix`).
 * Only COMPLETED backups count. A project with neither feature and no backup is "not enabled"; an
 * answer with none of those fields is could-not-check, never a guess. Supabase has no read-only token
 * type: use a token from an account that only needs this project, and revoke it when the work ends.
 * The endpoint and field names are from Supabase's Management API reference as remembered (uncited):
 * supabase.com was unreachable when this was written.
 */
export async function readSupabaseBackups(args: SupabaseArgs): Promise<PlatformRead> {
  const token = text(args.env[SUPABASE_TOKEN_VAR]);
  const base = { id: "supabase", platform: "Supabase" } as const;
  if (!token)
    return {
      ok: false,
      ...base,
      configured: true,
      reason: `${SUPABASE_TOKEN_VAR} is not set, so Supabase was not asked`,
    };
  const access: ProviderAccess = {
    provider: "Supabase",
    env: args.env,
    secretVars: [SUPABASE_TOKEN_VAR],
    fetcher: args.fetcher,
    authorization: `Bearer ${token}`,
  };
  const got = await getProviderJson(
    access,
    `${SUPABASE_API}/v1/projects/${encodeURIComponent(args.projectRef)}/database/backups`,
    "the project's backups",
  );
  if (!got.ok) return { ok: false, ...base, configured: true, reason: got.reason };
  const body = got.body;
  if (
    !isRecord(body) ||
    (typeof body.walg_enabled !== "boolean" &&
      typeof body.pitr_enabled !== "boolean" &&
      !Array.isArray(body.backups))
  )
    return {
      ok: false,
      ...base,
      configured: true,
      reason: "Supabase answered about the project's backups with something Gaugeline cannot read",
    };
  const daily = body.walg_enabled === true;
  const pitr = body.pitr_enabled === true;
  const completed = (Array.isArray(body.backups) ? body.backups : [])
    .filter(isRecord)
    .filter((b) => b.status === undefined || b.status === "COMPLETED")
    .map((b) => timeOf(b.inserted_at));
  const physical = isRecord(body.physical_backup_data)
    ? timeOf(body.physical_backup_data.latest_physical_backup_date_unix)
    : undefined;
  const latest = newest([...completed, pitr ? physical : undefined]);
  const enabled = daily || pitr || latest !== undefined;
  return {
    ok: true,
    ...base,
    subject: `project ${clip(args.projectRef, 40)}`,
    enabled,
    ...(latest ? { latest } : {}),
    detail: `daily backups ${daily ? "on" : "off"}, point-in-time recovery ${pitr ? "on" : "off"}`,
  };
}

export interface SanityArgs {
  env: Env;
  fetcher: Fetcher;
  projectId?: string | undefined;
  dataset?: string | undefined;
  /** True when gaugeline.backups.json names Sanity: a missing key is then worth a note. */
  explicit?: boolean;
}

/**
 * Sanity's dataset backups: one GET of `GET /projects/{projectId}/datasets/{dataset}/backups` on the
 * projects API, with SANITY_TOKEN in a header. The answer lists the backups, each with an id and a
 * `createdAt`. Backups are a plan feature: a plan or token that cannot see them answers 402, 403 or
 * 404, which is could-not-check with the status, never "no backups". An empty list is reported as "lists
 * no backups": Gaugeline cannot tell from it whether they are off or none has run yet. The endpoint and
 * fields are from Sanity's reference as remembered (uncited): sanity.io was unreachable when this was
 * written, so a reviewer should check them against the current page.
 */
export async function readSanityBackups(args: SanityArgs): Promise<PlatformRead> {
  const configured = args.explicit === true;
  const base = { id: "sanity", platform: "Sanity" } as const;
  const projectId = args.projectId ?? text(args.env[SANITY_PROJECT_ID]);
  if (!projectId)
    return {
      ok: false,
      ...base,
      configured,
      reason: `${SANITY_PROJECT_ID} is not set and gaugeline.backups.json names no Sanity project, so Sanity was not asked`,
    };
  const token = text(args.env[SANITY_TOKEN]);
  if (!token)
    return {
      ok: false,
      ...base,
      configured,
      reason: `${SANITY_TOKEN} is not set, so Sanity was not asked`,
    };
  const dataset = args.dataset ?? text(args.env[SANITY_DATASET]) ?? DEFAULT_DATASET;
  if (!/^[a-z0-9]{4,20}$/.test(projectId) || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(dataset))
    return {
      ok: false,
      ...base,
      configured: true,
      reason: "the Sanity project id or dataset name is not one (letters, digits, hyphens)",
    };
  const access: ProviderAccess = {
    provider: "Sanity",
    env: args.env,
    secretVars: [SANITY_TOKEN],
    fetcher: args.fetcher,
    authorization: `Bearer ${token}`,
  };
  const got = await getProviderJson(
    access,
    `${SANITY_API}/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(dataset)}/backups`,
    "the dataset's backups",
  );
  if (!got.ok) return { ok: false, ...base, configured: true, reason: got.reason };
  const rows = Array.isArray(got.body)
    ? got.body
    : isRecord(got.body) && Array.isArray(got.body.backups)
      ? got.body.backups
      : undefined;
  if (!rows)
    return {
      ok: false,
      ...base,
      configured: true,
      reason: "Sanity answered about the dataset's backups with something Gaugeline cannot read",
    };
  const latest = newest(rows.filter(isRecord).map((b) => timeOf(b.createdAt ?? b.created_at)));
  return {
    ok: true,
    ...base,
    subject: `dataset ${clip(dataset, 64)}`,
    enabled: latest !== undefined,
    ...(latest ? { latest } : {}),
    detail:
      latest !== undefined
        ? `${rows.length} ${rows.length === 1 ? "backup" : "backups"} listed`
        : "Sanity lists no backups for this dataset (they are off, or none has run yet)",
  };
}
