/** What one platform's backup status read gave: how it stands, or why it could not be had. */
export type PlatformRead =
  | {
      ok: true;
      /** "supabase" or "sanity". */
      id: string;
      platform: string;
      /** What the backups are of: "project abcdefghijklmnopqrst", "dataset production". */
      subject: string;
      /** False when the platform says no backup exists or none is switched on. */
      enabled: boolean;
      /** ISO time of the newest backup (or the newest point recovery can restore to). */
      latest?: string;
      /** Plain words for the report: "daily backups on, point-in-time recovery off". */
      detail: string;
      /** How many backups were dated more than a day in the future: not counted, because a time like that cannot be trusted. */
      future?: number;
      /** Set when the list may be longer than what was read, so a newer backup may exist: an old `latest` must not be reported as stale. */
      partial?: string;
    }
  | {
      ok: false;
      id: string;
      platform: string;
      /** True when the user set this platform up (a token or a settings entry); false when it was never asked for. */
      configured: boolean;
      reason: string;
    };

/** One file of an export folder as the folder reader lists it. Names and sizes only: a file is never opened. */
export interface RawExportFile {
  name: string;
  /** Bytes. */
  size: number;
  /** ISO time the file was last changed. */
  modified: string;
}

/**
 * What a folder lister gives: the files it could read, how many entries it did not read (links, subfolders,
 * files that vanished) and whether it stopped early because the folder had more entries than its bound.
 */
export interface RawListing {
  files: RawExportFile[];
  unread?: number;
  truncated?: boolean;
}

/** An export file with the day it stands for. */
export interface ExportFile {
  name: string;
  size: number;
  /** The UTC day, "2026-11-10". */
  date: string;
  /** Where the day came from: a date in the file's name, or when the file was last changed. */
  dateFrom: "name" | "modified";
  /**
   * When the file counts as made, for the age limit: its real modification time, or, for a date written in
   * its name, the end of that day (the benefit of the doubt: a name has no hour).
   */
  at: string;
}

/** Lists the files directly in a folder. The CLI gives one that reads the disk; tests give one that answers from a table. */
export type ExportLister = (folder: string) => Promise<RawExportFile[] | RawListing>;

export type ExportRead =
  | {
      ok: true;
      id: string;
      name: string;
      folder: string;
      files: ExportFile[];
      shrinkPercent: number;
      /** Files that are not backups (dotfiles, other kinds of file) and were left out. */
      skipped: number;
      /** Entries the lister did not read (links, subfolders). */
      unread: number;
      /** Names of files dated more than a day in the future: not counted. */
      future: string[];
    }
  | { ok: false; id: string; name: string; folder: string; reason: string };

export interface BackupsReading {
  now: string;
  maxAgeDays: number;
  platforms: PlatformRead[];
  exports: ExportRead[];
}
