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

/** An export file with the day it stands for. */
export interface ExportFile {
  name: string;
  size: number;
  /** The UTC day, "2026-11-10". */
  date: string;
  /** Where the day came from: a date in the file's name, or when the file was last changed. */
  dateFrom: "name" | "modified";
}

/** Lists the files directly in a folder. The CLI gives one that reads the disk; tests give one that answers from a table. */
export type ExportLister = (folder: string) => Promise<RawExportFile[]>;

export type ExportRead =
  | {
      ok: true;
      id: string;
      name: string;
      folder: string;
      files: ExportFile[];
      shrinkPercent: number;
    }
  | { ok: false; id: string; name: string; folder: string; reason: string };

export interface BackupsReading {
  now: string;
  maxAgeDays: number;
  platforms: PlatformRead[];
  exports: ExportRead[];
}
