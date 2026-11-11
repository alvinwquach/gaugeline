import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExportLister, RawExportFile } from "@gaugeline/core";

/**
 * Lists the files directly in a folder for the backups checks: name, size and when last changed, from the
 * directory entries alone. A file is never opened or read, a subfolder is not entered, and a link that
 * leads outside the listing is not followed (statSync on the entry itself would; lstat-style entries from
 * readdir with file types are used instead). The folder is resolved against `cwd`.
 */
export function folderLister(cwd: string): ExportLister {
  return (folder) => {
    const dir = resolve(cwd, folder);
    const out: RawExportFile[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const st = statSync(join(dir, entry.name));
      out.push({ name: entry.name, size: st.size, modified: st.mtime.toISOString() });
    }
    return Promise.resolve(out);
  };
}
