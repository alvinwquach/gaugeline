import { clip } from "../handoff/http.js";
import { DEFAULT_SHRINK_PERCENT } from "./config.js";
import { exportDateOf } from "./judge.js";
import type { ExportLister, ExportRead } from "./types.js";

/** The most files of one folder that are looked at: the newest by date are what matters, and a folder of thousands is a different problem. */
export const MAX_EXPORT_FILES = 1000;

/**
 * An export folder's files with the day each stands for. The folder is listed by the injected lister (the
 * CLI's reads the disk; nothing here opens a file), and a folder that cannot be listed is could-not-check
 * with the reason, never an empty folder.
 */
export async function readExportFolder(
  entry: { name?: string | undefined; folder: string; shrinkPercent?: number | undefined },
  index: number,
  list: ExportLister | undefined,
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
    const raw = await list(entry.folder);
    const files = raw.slice(0, MAX_EXPORT_FILES).map((f) => ({
      name: clip(f.name, 120),
      size: f.size,
      ...exportDateOf(f.name, f.modified),
    }));
    return {
      ok: true,
      ...base,
      files,
      shrinkPercent: entry.shrinkPercent ?? DEFAULT_SHRINK_PERCENT,
    };
  } catch (err) {
    return {
      ok: false,
      ...base,
      reason: `the folder ${clip(entry.folder, 200)} could not be read: ${err instanceof Error ? clip(err.message, 160) : "the read failed"}`,
    };
  }
}
