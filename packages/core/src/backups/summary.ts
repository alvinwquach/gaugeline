import { clip } from "../handoff/http.js";
import type { PageSnapshot } from "../snapshot.js";
import { agePhrase, formatBytes, judgeExports, stale } from "./judge.js";
import { NOTHING_READ_LINE, manualBackups, type ManualBackup } from "./manual.js";
import type { BackupsReading } from "./types.js";

export interface BackupsSummary {
  site: string;
  /** One line per platform or export folder read, in the order they were read. */
  lines: string[];
  /** Systems whose backup status Gaugeline cannot read: lines to check by hand. */
  checklist: ManualBackup[];
}

/**
 * What `gaugeline backups` prints first: one line per source (how it stands, in plain words), then the
 * checklist of systems whose backups cannot be read. Pure: the same reading, page and clock give the same text.
 */
export function buildBackupsSummary(args: {
  site: string;
  reading: BackupsReading;
  page: PageSnapshot;
  now: Date;
}): BackupsSummary {
  const { reading, now } = args;
  const lines: string[] = [];
  const limit = reading.maxAgeDays;
  for (const p of reading.platforms) {
    // A platform nobody set up is not a line: it was never asked for.
    if (!p.ok && !p.configured) continue;
    if (!p.ok) {
      lines.push(`${p.platform}: could not check: ${clip(p.reason, 300)}`);
      continue;
    }
    const head = `${p.platform} ${clip(p.subject)}: ${clip(p.detail)}`;
    const extra = `${p.future ? ` ${p.future} ${p.future === 1 ? "backup is" : "backups are"} dated in the future and not counted.` : ""}${p.partial ? ` The list may be incomplete: ${clip(p.partial, 200)}.` : ""}`;
    if (!p.enabled) lines.push(`${head}. Not enabled.${extra}`);
    else if (p.latest === undefined) lines.push(`${head}. No date for the newest backup.${extra}`);
    else
      lines.push(
        `${head}. Newest backup ${agePhrase(p.latest, now)}${stale(p.latest, now, limit) ? `, over the ${limit}-day limit` : ""}.${extra}`,
      );
  }
  for (const e of reading.exports) {
    const head = `Export "${e.name}" (${e.folder})`;
    if (!e.ok) {
      lines.push(`${head}: could not check: ${clip(e.reason, 300)}`);
      continue;
    }
    const j = judgeExports(e.files, e.shrinkPercent);
    const notes = `${e.future.length > 0 ? ` ${e.future.length} ${e.future.length === 1 ? "file is" : "files are"} dated in the future and not counted.` : ""}${e.unread > 0 ? ` ${e.unread} ${e.unread === 1 ? "entry was" : "entries were"} not read (links or folders).` : ""}${e.skipped > 0 ? ` ${e.skipped} ${e.skipped === 1 ? "file was" : "files were"} skipped (not backups).` : ""}`;
    if (j.kind === "empty") {
      lines.push(`${head}: no backup files.${notes}`);
      continue;
    }
    const day = `${j.latest.date}T00:00:00Z`;
    const previous = j.previous
      ? `, the one before ${formatBytes(j.previous.size)}${j.shrunk ? " (far smaller)" : ""}`
      : "";
    lines.push(
      `${head}: ${e.files.length} ${e.files.length === 1 ? "file" : "files"}, newest ${j.latest.name}, ${formatBytes(j.latest.size)}, dated ${agePhrase(day, now)}${previous}.${notes}`,
    );
  }
  if (lines.length === 0) lines.push("No backup source is set up, so no backup status was read.");
  const checklist = manualBackups(args.page, reading);
  if (
    checklist.length === 0 &&
    reading.platforms.every((p) => !p.ok) &&
    reading.exports.length === 0
  )
    checklist.push({ id: "where", name: "Backups", line: NOTHING_READ_LINE });
  return { site: args.site, lines, checklist };
}

/** The summary as lines of text. */
export function formatBackupsSummary(s: BackupsSummary): string[] {
  const out = [`Backups for ${s.site}`, ...s.lines.map((l) => `  ${l}`)];
  if (s.checklist.length > 0) {
    out.push("Check by hand");
    for (const c of s.checklist) out.push(`  [ ] ${c.line}`);
  }
  return out;
}
