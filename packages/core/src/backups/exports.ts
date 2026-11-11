import { clip } from "../handoff/http.js";
import { DEFAULT_SHRINK_PERCENT } from "./config.js";
import { exportDateOf, inFuture } from "./judge.js";
import type { ExportFile, ExportLister, ExportRead } from "./types.js";

/** The most files of one folder that are kept: the newest by date are what matters, and older ones cannot change the judgement. */
export const MAX_EXPORT_FILES = 1000;

/** The extensions of files that are backups when the settings give no `pattern`. */
const DUMP_EXTENSIONS = [
  ".sql",
  ".sql.gz",
  ".dump",
  ".backup",
  ".bak",
  ".tar",
  ".tar.gz",
  ".tgz",
  ".zip",
  ".json",
  ".ndjson",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".zst",
];

/** A file name pattern with * for any text, compared whole and without regard to case. No other character is special. */
function patternMatcher(pattern: string): (name: string) => boolean {
  const re = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    "i",
  );
  return (name) => re.test(name);
}

/** True for a file that counts as a backup: not a dotfile, and matching the pattern or having a dump extension. */
export function isBackupFile(name: string, pattern?: string): boolean {
  if (name.startsWith(".")) return false;
  if (pattern) return patternMatcher(pattern)(name);
  const lower = name.toLowerCase();
  return DUMP_EXTENSIONS.some((e) => lower.endsWith(e));
}

/**
 * An export folder's files with the day each stands for. The folder is listed by the injected lister (the
 * CLI's reads the disk; nothing here opens a file), and a folder that cannot be listed is could-not-check
 * with the reason, never an empty folder. Only backup files count (see isBackupFile). A file dated more
 * than a day after the clock cannot be trusted and is set aside by name. A listing the lister cut short is
 * could-not-check, and so is a folder whose only entries were links or subfolders: on partial data an old
 * date would be a false alarm. Beyond MAX_EXPORT_FILES the newest by date are kept.
 */
export async function readExportFolder(
  entry: {
    name?: string | undefined;
    folder: string;
    shrinkPercent?: number | undefined;
    pattern?: string | undefined;
  },
  index: number,
  list: ExportLister | undefined,
  now: Date,
): Promise<ExportRead> {
  const name = entry.name ?? (index === 0 ? "export" : `export ${index + 1}`);
  const base = { id: `export:${name}`, name: clip(name, 40), folder: clip(entry.folder, 200) };
  if (!list)
    return {
      ok: false,
      ...base,
      reason: "this run has no way to read a folder, so the export was not looked at",
    };
  try {
    const got = await list(entry.folder);
    const listing = Array.isArray(got) ? { files: got } : got;
    let unread = listing.unread ?? 0;
    if (listing.truncated)
      return {
        ok: false,
        ...base,
        reason:
          "the folder has more entries than Gaugeline reads at once, so only part of it was looked at and a newer export may be in the rest",
      };
    const kept: ExportFile[] = [];
    const future: string[] = [];
    let skipped = 0;
    for (const f of listing.files) {
      if (!isBackupFile(f.name, entry.pattern)) {
        skipped += 1;
        continue;
      }
      if (!Number.isFinite(Date.parse(f.modified))) {
        unread += 1;
        continue;
      }
      const file: ExportFile = {
        name: clip(f.name, 120),
        size: f.size,
        ...exportDateOf(f.name, f.modified),
      };
      const dated = file.dateFrom === "name" ? `${file.date}T00:00:00Z` : file.at;
      if (inFuture(dated, now)) future.push(file.name);
      else kept.push(file);
    }
    if (kept.length === 0 && future.length === 0 && unread > 0)
      return {
        ok: false,
        ...base,
        reason: `${unread} ${unread === 1 ? "entry was" : "entries were"} not read (links or folders), and no backup file was found among the rest`,
      };
    kept.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.name < b.name ? -1 : 1));
    return {
      ok: true,
      ...base,
      files: kept.slice(0, MAX_EXPORT_FILES),
      shrinkPercent: entry.shrinkPercent ?? DEFAULT_SHRINK_PERCENT,
      skipped,
      unread,
      future,
    };
  } catch (err) {
    return {
      ok: false,
      ...base,
      reason: `the folder ${clip(entry.folder, 200)} could not be read: ${err instanceof Error ? clip(err.message, 160) : "the read failed"}`,
    };
  }
}
