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
import { inFuture } from "./judge.js";
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

/** Times outside these years are not backup times: they are typos, unit mix-ups (milliseconds read as seconds) or tricks. */
const EARLIEST_MS = Date.UTC(2000, 0, 1);
const LATEST_MS = Date.UTC(2100, 0, 1);

/**
 * An ISO time from a string, or from seconds (or milliseconds) since the epoch. Undefined for anything
 * else, and for a time outside the years 2000 to 2099, so a huge number can never throw in toISOString.
 */
function timeOf(v: unknown): string | undefined {
  const ms =
    typeof v === "number" && Number.isFinite(v) && v > 0
      ? v < 1e11
        ? v * 1000
        : v
      : typeof v === "string"
        ? Date.parse(v)
        : NaN;
  if (!Number.isFinite(ms) || ms < EARLIEST_MS || ms >= LATEST_MS) return undefined;
  return new Date(ms).toISOString();
}

/** The times that can be trusted (not more than a day ahead of the clock), the newest of them, and how many were too far ahead. */
function trusted(
  times: readonly (string | undefined)[],
  now: Date,
): { latest: string | undefined; future: number } {
  let latest: string | undefined;
  let future = 0;
  for (const t of times) {
    if (t === undefined) continue;
    if (inFuture(t, now)) future += 1;
    else if (latest === undefined || Date.parse(t) > Date.parse(latest)) latest = t;
  }
  return { latest, future };
}

export interface SupabaseArgs {
  env: Env;
  fetcher: Fetcher;
  projectRef: string;
  /** The injected clock: a backup dated more than a day after it is not trusted. */
  now: Date;
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
  const times = [...completed, pitr ? physical : undefined];
  const { latest, future } = trusted(times, args.now);
  const enabled = daily || pitr || times.some((t) => t !== undefined);
  return {
    ok: true,
    ...base,
    subject: `project ${clip(args.projectRef, 40)}`,
    enabled,
    ...(latest ? { latest } : {}),
    detail: `daily backups ${daily ? "on" : "off"}, point-in-time recovery ${pitr ? "on" : "off"}`,
    ...(future > 0 ? { future } : {}),
  };
}

export interface SanityArgs {
  env: Env;
  fetcher: Fetcher;
  projectId?: string | undefined;
  dataset?: string | undefined;
  /** True when gaugeline.backups.json names Sanity: a missing key is then worth a note. */
  explicit?: boolean;
  /** The injected clock: a backup dated more than a day after it is not trusted. */
  now: Date;
}

/** Pages of Sanity's backup list that are followed, at most. */
const MAX_SANITY_PAGES = 5;
/** A page this long, with no cursor, may be only the first page of more. */
const SANITY_PAGE_GUESS = 100;

/**
 * Sanity's dataset backups: `GET /projects/{projectId}/datasets/{dataset}/backups` on the projects API,
 * with SANITY_TOKEN in a header, then the next page while the answer carries a `nextCursor` (asked for as
 * `?nextCursor=`; the paging field and parameter are uncited), at most five pages. A list that may be
 * longer than what was read is `partial`: the newest of what was read is kept, but an old date is then
 * could-not-check, never a stale finding. The answer lists the backups, each with an id and a
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
  const url = `${SANITY_API}/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(dataset)}/backups`;
  const times: (string | undefined)[] = [];
  let listed = 0;
  let partial: string | undefined;
  let cursor: string | undefined;
  for (let page = 1; page <= MAX_SANITY_PAGES; page++) {
    const got = await getProviderJson(
      access,
      cursor === undefined ? url : `${url}?nextCursor=${encodeURIComponent(cursor)}`,
      "the dataset's backups",
    );
    if (!got.ok) {
      if (page === 1) return { ok: false, ...base, configured, reason: got.reason };
      partial = `Sanity did not answer for page ${page} of the backup list (${got.reason}), so a newer backup may exist`;
      break;
    }
    const rows = Array.isArray(got.body)
      ? got.body
      : isRecord(got.body) && Array.isArray(got.body.backups)
        ? got.body.backups
        : undefined;
    if (!rows) {
      if (page === 1)
        return {
          ok: false,
          ...base,
          configured,
          reason:
            "Sanity answered about the dataset's backups with something Gaugeline cannot read",
        };
      partial = `Sanity's page ${page} of the backup list could not be read, so a newer backup may exist`;
      break;
    }
    listed += rows.length;
    for (const b of rows.filter(isRecord)) times.push(timeOf(b.createdAt ?? b.created_at));
    const next = isRecord(got.body) ? text(got.body.nextCursor) : undefined;
    if (next === undefined) {
      if (rows.length >= SANITY_PAGE_GUESS)
        partial = `Sanity listed ${rows.length} backups with no way to ask for more, so a newer one may exist`;
      break;
    }
    if (page === MAX_SANITY_PAGES) {
      partial = `Sanity has more backups than the ${MAX_SANITY_PAGES} pages read, so a newer one may exist`;
      break;
    }
    cursor = next;
  }
  const { latest, future } = trusted(times, args.now);
  const any = times.some((t) => t !== undefined);
  return {
    ok: true,
    ...base,
    subject: `dataset ${clip(dataset, 64)}`,
    enabled: any,
    ...(latest ? { latest } : {}),
    detail: any
      ? `${listed} ${listed === 1 ? "backup" : "backups"} listed`
      : "Sanity lists no backups for this dataset (they are off, or none has run yet)",
    ...(future > 0 ? { future } : {}),
    ...(partial ? { partial } : {}),
  };
}
