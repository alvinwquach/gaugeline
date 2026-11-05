/**
 * After a pull request merges: file its status entry, changelog line and ledger row in one POST to
 * the Google Apps Script web app, then call the site's deploy hook if one is set.
 * Switched off when REPORT_POST_URL is not set. Secrets are read from the environment and never printed.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatMinutes, pacificDay, parsePr } from "./parse-pr.js";

interface MergeEvent {
  pull_request?: {
    number: number;
    title: string;
    html_url: string;
    merged: boolean;
    merged_at: string | null;
    body: string | null;
  };
}

export interface ReportBody {
  /** Stable per pull request: the Sheet is the ledger, so a re-run finds it and changes nothing. */
  id: string;
  status: { week: string; day: string; entry: string };
  changelog: { section: string; line: string } | null;
  row: {
    number: number;
    title: string;
    url: string;
    mergedAt: string;
    day: string;
    minutes: number;
    section: string;
  };
}

export function buildReport(event: MergeEvent): ReportBody | undefined {
  const pr = event.pull_request;
  if (!pr || !pr.merged || !pr.merged_at) return undefined;
  const parsed = parsePr(pr.body ?? "");
  const { day, week } = pacificDay(pr.merged_at);
  return {
    id: `pr-${pr.number}`,
    status: { week, day, entry: `#${pr.number} ${pr.title} (${formatMinutes(parsed.minutes)})` },
    changelog: parsed.changelog ? { section: parsed.section, line: parsed.changelog } : null,
    row: {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      mergedAt: pr.merged_at,
      day,
      minutes: parsed.minutes,
      section: parsed.section,
    },
  };
}

export async function postReport(
  url: string,
  secret: string,
  body: ReportBody,
): Promise<{ ok: boolean; message: string }> {
  // Apps Script web apps cannot read request headers, so the shared secret travels in the body.
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, secret }),
    redirect: "follow",
  });
  const answer = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as {
    ok?: boolean;
    error?: string;
    duplicate?: boolean;
  };
  return answer.ok === true
    ? { ok: true, message: answer.duplicate ? "already filed; nothing changed" : "filed" }
    : { ok: false, message: answer.error ?? "the report service said no" };
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const url = process.env.REPORT_POST_URL ?? "";
  const secret = process.env.REPORT_POST_SECRET ?? "";
  const eventPath = process.env.GITHUB_EVENT_PATH ?? "";
  const report =
    eventPath && existsSync(eventPath)
      ? buildReport(JSON.parse(readFileSync(eventPath, "utf8")) as MergeEvent)
      : undefined;
  if (!report) {
    process.stdout.write("on-merge: not a merged pull request; nothing to file.\n");
  } else if (!url || !secret) {
    process.stdout.write(
      "on-merge: reporting is switched off (REPORT_POST_URL or REPORT_POST_SECRET is not set).\n",
    );
  } else {
    const result = await postReport(url, secret, report);
    process.stdout.write(`on-merge: ${report.id} ${result.message}\n`);
    if (!result.ok) process.exitCode = 1;
    else if (process.env.DEPLOY_HOOK_URL) {
      const hook = await fetch(process.env.DEPLOY_HOOK_URL, { method: "POST" });
      process.stdout.write(`on-merge: deploy hook answered ${hook.status}\n`);
      if (!hook.ok) process.exitCode = 1;
    }
  }
}
