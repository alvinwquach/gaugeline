import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { DEFAULT_MAX_AGE_DAYS, type BackupsConfig } from "./config.js";
import { readExportFolder } from "./exports.js";
import { readSanityBackups, readSupabaseBackups } from "./providers.js";
import type { BackupsReading, ExportLister } from "./types.js";

export interface BackupsSettings {
  config: BackupsConfig;
  /** The variables in BACKUPS_ENV_VARS, already copied from the environment. */
  env: Env;
  /** Lists the files of an export folder. Absent: export folders are could-not-check. */
  lister?: ExportLister;
}

/**
 * What the backups checks read, once and shared: each platform's backup status (Supabase, Sanity) and
 * each configured export folder's files. Every request is a GET through the fetcher; an export folder is
 * listed, never opened. `claim` lets only the first page of a site report each kind of finding.
 */
export interface Backups {
  readonly config: BackupsConfig;
  readonly maxAgeDays: number;
  claim(checkId: string, site: string): boolean;
  read(now: Date): Promise<BackupsReading>;
}

export function createBackups(settings: BackupsSettings, fetcher: Fetcher): Backups {
  const { config, env } = settings;
  const maxAgeDays = config.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const claimed = new Set<string>();
  let reading: Promise<BackupsReading> | undefined;
  return {
    config,
    maxAgeDays,
    claim(checkId, site) {
      const key = `${checkId}\u0000${site}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    read(now) {
      reading ??= (async (): Promise<BackupsReading> => {
        const [platforms, exports] = await Promise.all([
          Promise.all([
            // Supabase is asked only for a project the settings name: the reference is in no environment variable.
            config.supabase
              ? readSupabaseBackups({ env, fetcher, projectRef: config.supabase.projectRef, now })
              : Promise.resolve(undefined),
            readSanityBackups({
              env,
              fetcher,
              projectId: config.sanity?.projectId,
              dataset: config.sanity?.dataset,
              explicit: config.sanity !== undefined,
              now,
            }),
          ]),
          Promise.all(
            (config.exports ?? []).map((e, i) => readExportFolder(e, i, settings.lister, now)),
          ),
        ]);
        return {
          now: now.toISOString(),
          maxAgeDays,
          platforms: platforms.flatMap((p) => (p ? [p] : [])),
          exports,
        };
      })();
      return reading;
    },
  };
}
