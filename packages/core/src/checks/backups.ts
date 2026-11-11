import type { CheckContext, Finding } from "../model.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { agePhrase, formatBytes, judgeExports, stale } from "../backups/judge.js";
import type { BackupsReading } from "../backups/types.js";
import { escapeInvisible } from "./hidden-text/escape.js";

const clip = (text: string): string => escapeInvisible(text, 200);

const NOTHING_SET_UP =
  "no backup source is set up: name a Supabase project under supabase in gaugeline.backups.json and set SUPABASE_ACCESS_TOKEN, set SANITY_TOKEN and SANITY_PROJECT_ID for Sanity, or list an export folder under exports";

/**
 * The site's reading for this check's first page, once per site, or undefined (not asked for, or already
 * reported by an earlier page). The first check to run also notes what could not be read, so the same
 * platform is not noted three times.
 */
async function readingFor(
  id: string,
  page: PageSnapshot,
  ctx: CheckContext,
): Promise<BackupsReading | undefined> {
  const backups = ctx.backups;
  if (!backups) return undefined;
  const site = new URL(page.finalUrl).origin;
  if (!backups.claim(id, site)) return undefined;
  const reading = await backups.read(ctx.now?.() ?? new Date());
  if (id === "no-recent-backup") noteUnread(reading, page, ctx);
  return reading;
}

function noteUnread(reading: BackupsReading, page: PageSnapshot, ctx: CheckContext): void {
  const none =
    reading.platforms.every((p) => !p.ok && !p.configured) && reading.exports.length === 0;
  if (none) {
    ctx.couldNotCheck?.(page.finalUrl, NOTHING_SET_UP);
    return;
  }
  const now = new Date(reading.now);
  for (const p of reading.platforms) {
    if (!p.ok) {
      if (p.configured) ctx.couldNotCheck?.(`backups:${p.id}`, p.reason);
      continue;
    }
    if (p.future)
      ctx.couldNotCheck?.(
        `backups:${p.id}`,
        `${p.platform} lists ${p.future} ${p.future === 1 ? "backup" : "backups"} dated in the future, which cannot be trusted and ${p.future === 1 ? "was" : "were"} not counted`,
      );
    if (p.enabled && p.latest === undefined && !p.future)
      ctx.couldNotCheck?.(
        `backups:${p.id}`,
        `${p.platform} shows backups on but gives no date for the newest one, so how recent it is cannot be judged`,
      );
    if (p.partial && p.latest !== undefined && stale(p.latest, now, reading.maxAgeDays))
      ctx.couldNotCheck?.(
        `backups:${p.id}`,
        `${p.partial}: the newest backup read is old, but it may have missed newer ones, so no finding is made`,
      );
  }
  for (const e of reading.exports) {
    if (!e.ok) {
      ctx.couldNotCheck?.(`backups:${e.id}`, e.reason);
      continue;
    }
    if (e.future.length > 0)
      ctx.couldNotCheck?.(
        `backups:${e.id}`,
        `${e.future.length} ${e.future.length === 1 ? "file" : "files"} in the folder (${e.future
          .slice(0, 3)
          .map((n) => clip(n))
          .join(
            ", ",
          )}) ${e.future.length === 1 ? "is" : "are"} dated in the future, which cannot be trusted, so ${e.future.length === 1 ? "it was" : "they were"} not counted`,
      );
    if (e.unread > 0)
      ctx.couldNotCheck?.(
        `backups:${e.id}`,
        `${e.unread} ${e.unread === 1 ? "entry was" : "entries were"} not read (links or folders), so an export inside one is not counted`,
      );
  }
}

export const noRecentBackup = defineCheck<PageSnapshot>({
  id: "no-recent-backup",
  size: "M",
  done: "The newest backup of each system is newer than the limit in gaugeline.backups.json (7 days by default), and whoever owns the backup knows where it is. Whether it restores is only known by trying a restore, and that is still the owner's to do.",
  estimateChanges:
    "An hour to find why the backup stopped (a failed job, an expired credential, a plan change) and run it again. More when the restore has never been tried.",
  area: "Security & email",
  severity: "high",
  title: "No recent backup",
  what: "The newest backup the platform lists, or the newest dated export file in the folder you named, is older than the limit (7 days unless you changed it), or there is none.",
  why: "When a client's content or database is wiped, the first question is when the last backup was. A backup that stopped weeks ago is as good as none: everything since is lost, and nobody finds out until the day it is needed.",
  fix: "Open the platform's backups page (or the job that writes the export), find why the last run did not happen, and run it. Then check the next one runs by itself, and that someone has the access to restore it.",
  tech: 'Read-only: one GET per platform and a listing of each export folder; nothing triggers a backup or an export. Supabase: GET /v1/projects/{ref}/database/backups on the Management API with SUPABASE_ACCESS_TOKEN (Supabase has no read-only token type: use one that only needs this project). The newest COMPLETED backup, or the latest point-in-time recovery moment, is compared with the injected clock. Sanity: GET /projects/{id}/datasets/{dataset}/backups with SANITY_TOKEN where the plan exposes it. Exports: the files directly in each folder named under "exports", never opened; only dump files count (no dotfiles; a known dump extension, or the "pattern" setting). A day in the file name (2026-11-10, 20261110) is the date, counted to the end of that day, else the time the file was last changed, to the minute, and the finding says which. A backup or file dated more than a day after the clock is set aside as untrustworthy and noted, never taken as the newest. A listing cut short, or a folder of only links and subfolders, is could-not-check. Limit: "maxAgeDays" (default 7). Only with --backups or gaugeline backups; anything a platform does not expose is could-not-check with the reason',
  async run(page, ctx) {
    const reading = await readingFor("no-recent-backup", page, ctx);
    if (!reading) return [];
    const now = ctx.now?.() ?? new Date();
    const out: Finding[] = [];
    const limit = `more than ${reading.maxAgeDays} ${reading.maxAgeDays === 1 ? "day" : "days"} is flagged`;
    for (const p of reading.platforms)
      if (
        p.ok &&
        p.enabled &&
        !p.partial &&
        p.latest !== undefined &&
        stale(p.latest, now, reading.maxAgeDays)
      )
        out.push({
          checkId: "no-recent-backup",
          severity: "high",
          title: this.title,
          evidence: `${p.platform} ${clip(p.subject)}: the newest backup was ${agePhrase(p.latest, now)}; ${limit}`,
          url: `backups:${p.id}`,
        });
    for (const e of reading.exports) {
      if (!e.ok) continue;
      const j = judgeExports(e.files, e.shrinkPercent);
      const where = `Export "${clip(e.name)}" (${clip(e.folder)})`;
      if (j.kind === "empty") {
        // Files dated in the future are noted as could-not-check: nothing is known about this folder.
        if (e.future.length > 0) continue;
        out.push({
          checkId: "no-recent-backup",
          severity: "high",
          title: this.title,
          evidence: `${where}: the folder has no backup files, so there is no export${e.skipped > 0 ? ` (${e.skipped} ${e.skipped === 1 ? "file was" : "files were"} skipped: dotfiles and files that are not backups)` : ""}`,
          url: `backups:${e.id}`,
        });
      } else if (stale(j.latest.at, now, reading.maxAgeDays))
        out.push({
          checkId: "no-recent-backup",
          severity: "high",
          title: this.title,
          evidence: `${where}: the newest file is ${clip(j.latest.name)}, dated ${agePhrase(`${j.latest.date}T00:00:00Z`, now)}${j.latest.dateFrom === "modified" ? " (from when the file was last changed: its name has no date)" : ""}; ${limit}`,
          url: `backups:${e.id}`,
        });
    }
    return out;
  },
});

export const backupsNotEnabled = defineCheck<PageSnapshot>({
  id: "backups-not-enabled",
  size: "S",
  done: "The platform lists a backup for the project or dataset: daily backups or point-in-time recovery is on and has run at least once.",
  estimateChanges:
    "Minutes to switch it on if the plan has it. If the plan does not, the client decides whether the upgrade or a scheduled export is worth it.",
  area: "Security & email",
  severity: "high",
  title: "Backups are not enabled",
  what: "The platform reports no backups for the project or dataset: daily backups and point-in-time recovery are off, or nothing is listed.",
  why: "Nothing can be restored if the data is deleted, overwritten by a bad import or lost to a mistaken migration. Most of the platforms freelancers use keep no copy at all on their cheapest plans.",
  fix: "Switch backups on in the platform (a paid plan on some), or schedule an export to a folder or a bucket and list it under exports in gaugeline.backups.json. Then run this again to see the first backup appear.",
  tech: 'Read-only, from the same GET as no-recent-backup. Supabase: walg_enabled and pitr_enabled both false and no completed backup listed. Sanity: the dataset\'s backup list is empty (Gaugeline cannot tell from it whether backups are off or none has run yet, and the finding says so). A platform that refuses the token or does not expose backups on the plan is could-not-check, not "not enabled". Only with --backups or gaugeline backups',
  async run(page, ctx) {
    const reading = await readingFor("backups-not-enabled", page, ctx);
    if (!reading) return [];
    return reading.platforms.flatMap((p): Finding[] =>
      p.ok && !p.enabled
        ? [
            {
              checkId: "backups-not-enabled",
              severity: "high",
              title: this.title,
              evidence: `${p.platform} ${clip(p.subject)}: ${clip(p.detail)}`,
              url: `backups:${p.id}`,
            },
          ]
        : [],
    );
  },
});

export const exportTooSmall = defineCheck<PageSnapshot>({
  id: "export-too-small",
  size: "S",
  done: "The latest export is about the size of the one before it, or the drop is explained (rows deleted on purpose) and the next export confirms it.",
  estimateChanges:
    "Half an hour to open the two files' contents list and see what is missing: a table that failed, a bucket that was skipped, a job that ran out of disk.",
  area: "Security & email",
  severity: "medium",
  title: "The latest export is far smaller than the one before",
  what: "The newest export file in a folder you named is under half the size of the one before it (or the percent you set).",
  why: "A backup job that fails half way still writes a file. A database dump that suddenly shrinks is usually a table that was skipped or a job that ran out of space, and it is only found when someone tries to restore it.",
  fix: "Compare what is inside the two exports (the list of tables or files). If the drop is wrong, fix the job and run it again; if it is real, note why.",
  tech: 'Only folders named under "exports" in gaugeline.backups.json. Files are listed, never opened: the size in bytes comes from the folder listing. Per day the biggest file stands for it (a second run does not hide a good export). The latest day\'s file is compared with the day before it in integers: flagged when its size times 100 is under the previous size times "shrinkPercent" (default 50), so a zero-byte latest file is always flagged. A previous export of zero bytes has nothing to shrink from. The day comes from the file name or, failing that, when it was last changed. Only with --backups or gaugeline backups',
  async run(page, ctx) {
    const reading = await readingFor("export-too-small", page, ctx);
    if (!reading) return [];
    const out: Finding[] = [];
    for (const e of reading.exports) {
      if (!e.ok) continue;
      const j = judgeExports(e.files, e.shrinkPercent);
      if (j.kind !== "ok" || !j.shrunk || !j.previous) continue;
      out.push({
        checkId: "export-too-small",
        severity: "medium",
        title: this.title,
        evidence: `Export "${clip(e.name)}" (${clip(e.folder)}): ${clip(j.latest.name)} is ${formatBytes(j.latest.size)}, under ${e.shrinkPercent}% of ${clip(j.previous.name)} before it (${formatBytes(j.previous.size)})`,
        url: `backups:${e.id}`,
      });
    }
    return out;
  },
});

export const BACKUPS_CHECKS = [noRecentBackup, backupsNotEnabled, exportTooSmall] as const;
