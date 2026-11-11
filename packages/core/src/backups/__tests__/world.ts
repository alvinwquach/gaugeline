import { createFetcher } from "../../fetcher.js";
import { recordedTransport, type Recorded } from "../../renewals/__tests__/recorded.js";

/**
 * The invented world the backups tests and docs run in, answered from recorded responses (nothing touches
 * a network). Marlowe Bar, an invented bar, keeps its bookings in Supabase and its menu in Sanity, on
 * 11 Nov 2026.
 */
export const NOW = new Date("2026-11-11T09:00:00Z");

/** Invented keys, built at run time so no key-shaped string sits in the repository. */
export const SUPABASE_TOKEN = ["sbp", "_invented_", "token", "backups01"].join("");
export const SANITY_TOKEN_VALUE = ["sk", "INVENTED", "sanity", "backups02"].join("");

export const REF = "abcdefghijklmnopqrst";
export const SUPABASE_URL = `https://api.supabase.com/v1/projects/${REF}/database/backups`;
export const SANITY_URL =
  "https://api.sanity.io/v2021-06-07/projects/marlowe1/datasets/production/backups";

export const ENV = {
  SUPABASE_ACCESS_TOKEN: SUPABASE_TOKEN,
  SANITY_TOKEN: SANITY_TOKEN_VALUE,
  SANITY_PROJECT_ID: "marlowe1",
};

const unix = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

/** Supabase's answer for a Pro project with daily backups, the newest on `latest`. */
export const supabaseOn = (latest: string, over: Record<string, unknown> = {}) => ({
  region: "eu-west-2",
  walg_enabled: true,
  pitr_enabled: false,
  backups: [
    { is_physical_backup: false, status: "COMPLETED", inserted_at: latest },
    { is_physical_backup: false, status: "COMPLETED", inserted_at: "2026-11-08T03:00:00Z" },
    { is_physical_backup: false, status: "FAILED", inserted_at: "2026-11-11T03:00:00Z" },
  ],
  ...over,
});

/** A free-plan project: no daily backups, no point-in-time recovery. */
export const supabaseOff = {
  region: "eu-west-2",
  walg_enabled: false,
  pitr_enabled: false,
  backups: [],
};

/** Point-in-time recovery on, restorable to `latest`. */
export const supabasePitr = (latest: string) => ({
  region: "eu-west-2",
  walg_enabled: true,
  pitr_enabled: true,
  backups: [],
  physical_backup_data: {
    earliest_physical_backup_date_unix: unix("2026-11-04T00:00:00Z"),
    latest_physical_backup_date_unix: unix(latest),
  },
});

export const sanityBackups = (...created: string[]) => ({
  backups: created.map((createdAt, i) => ({ id: `b${i}`, createdAt })),
});

export function fetcherFor(routes: Record<string, Recorded>) {
  const { transport, seen } = recordedTransport(routes);
  return { fetcher: createFetcher({ transport }), seen };
}
