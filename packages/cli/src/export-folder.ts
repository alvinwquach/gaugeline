import { lstatSync, opendirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExportLister, RawExportFile } from "@gaugeline/core";

/** The most directory entries read from one folder: past it the listing says it was cut short. */
export const MAX_ENTRIES = 20_000;

/** What went wrong, in words that hold no path: the folder the person named is already in the report. */
function plain(err: unknown): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return new Error("the folder does not exist");
  if (code === "ENOTDIR") return new Error("it is not a folder");
  if (code === "EACCES" || code === "EPERM") return new Error("Gaugeline may not read it");
  return new Error("the read failed");
}

/**
 * Lists the files directly in a folder for the backups checks: name, size and when last changed, from the
 * directory entries alone. A file is never opened or read. Only regular files are listed: a subfolder is
 * not entered and a link is not followed, and each is counted in `unread` so the report can say so (an
 * entry is stat-ed with lstat, so a link is never followed). At most `maxEntries` entries are read; past
 * that `truncated` is set and the checks treat the folder as could-not-check. Errors carry fixed words,
 * never the absolute path. The folder is resolved against `cwd`.
 */
export function folderLister(cwd: string, opts: { maxEntries?: number } = {}): ExportLister {
  const bound = opts.maxEntries ?? MAX_ENTRIES;
  return (folder) => {
    const dir = resolve(cwd, folder);
    const files: RawExportFile[] = [];
    let unread = 0;
    let truncated = false;
    try {
      const handle = opendirSync(dir);
      try {
        let seen = 0;
        for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
          if (seen >= bound) {
            truncated = true;
            break;
          }
          seen += 1;
          if (!entry.isFile()) {
            unread += 1;
            continue;
          }
          try {
            const st = lstatSync(join(dir, entry.name));
            if (!st.isFile()) unread += 1;
            else files.push({ name: entry.name, size: st.size, modified: st.mtime.toISOString() });
          } catch {
            // The file went away between the listing and the stat.
            unread += 1;
          }
        }
      } finally {
        handle.closeSync();
      }
    } catch (err) {
      return Promise.reject(plain(err));
    }
    return Promise.resolve({ files, unread, truncated });
  };
}
