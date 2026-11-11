import { writeDate } from "../renewals/dates.js";
import type { HostedBuilder } from "./builders.js";
import { type Cause, type PageRead, judgePage } from "./judge.js";
import { type Jump, type UsageRead, dayBefore, detectJumps, jumpPhrase, utcDay } from "./usage.js";

/** How many pages the summary names before it counts the rest. */
export const SUMMARY_PAGES = 5;

const RANK: Record<Cause["id"], number> = {
  "output-changes-every-request": 0,
  "never-cached": 1,
  "revalidate-too-often": 2,
};

export type ProviderSummary =
  | { provider: string; kind: "jumps"; jumps: Jump[] }
  | { provider: string; kind: "steady"; metrics: number; day: string; window: number }
  | { provider: string; kind: "could-not-check"; reason: string };

export interface CostSummary {
  site: string;
  /** False when the settings mark no page static, so caching was not judged. */
  staticListed: boolean;
  /** Pages with at least one cause, the likeliest cause first, then by path. */
  pages: { path: string; url: string; causes: Cause[] }[];
  /** Pages visited with no cause found. */
  fine: string[];
  /** Pages that could not be visited or compared, with the reason. */
  unread: { path: string; reason: string }[];
  /** A fixed-plan builder, or each provider's usage. */
  account:
    { kind: "fixed-plan"; builder: string } | { kind: "providers"; providers: ProviderSummary[] };
}

/**
 * What `gaugeline cost` prints first: the pages that likely cost money, by cause, in plain sentences,
 * and what the account usage says. Pure: the same reads, usage and clock give the same summary, in any
 * order the reads arrive in.
 */
export function buildCostSummary(args: {
  site: string;
  reads: readonly PageRead[];
  usage: UsageRead;
  now: Date;
  minimumSeconds: number;
  usageSettings: { window: number; multiple: number };
  builder?: HostedBuilder | undefined;
  staticListed?: boolean;
}): CostSummary {
  const pages: CostSummary["pages"] = [];
  const fine: string[] = [];
  const unread: CostSummary["unread"] = [];
  for (const read of args.reads) {
    if (!read.ok) {
      unread.push({ path: read.path, reason: read.reason });
      continue;
    }
    const j = judgePage(read, args.minimumSeconds);
    if (j.changes.kind === "unreadable") unread.push({ path: read.path, reason: j.changes.reason });
    else if (j.causes.length > 0) pages.push({ path: read.path, url: read.url, causes: j.causes });
    else fine.push(read.path);
  }
  const top = (p: CostSummary["pages"][number]) => RANK[p.causes[0]?.id ?? "revalidate-too-often"];
  pages.sort((a, b) => top(a) - top(b) || a.path.localeCompare(b.path));
  fine.sort();
  unread.sort((a, b) => a.path.localeCompare(b.path));
  const day = dayBefore(utcDay(args.now));
  const providers: ProviderSummary[] = args.usage.providers.map((p): ProviderSummary => {
    if (!p.ok) return { provider: p.provider, kind: "could-not-check", reason: p.reason };
    const jumps = detectJumps(p.metrics, args.now, args.usageSettings);
    return jumps.length > 0
      ? { provider: p.provider, kind: "jumps", jumps }
      : {
          provider: p.provider,
          kind: "steady",
          metrics: p.metrics.length,
          day,
          window: args.usageSettings.window,
        };
  });
  return {
    site: args.site,
    staticListed: args.staticListed ?? true,
    pages,
    fine,
    unread,
    account: args.builder
      ? { kind: "fixed-plan", builder: args.builder.name }
      : { kind: "providers", providers },
  };
}

/** The summary as lines of text. */
export function formatCostSummary(s: CostSummary): string[] {
  const lines = [`Hosting cost for ${s.site}`, "Pages, likeliest cause of cost first"];
  const shown = s.pages.slice(0, SUMMARY_PAGES);
  const width = Math.max(0, ...shown.map((p) => p.path.length));
  for (const p of shown)
    for (const c of p.causes) lines.push(`  ${p.path.padEnd(width)}  ${c.sentence}`);
  if (s.pages.length > shown.length) lines.push(`  and ${s.pages.length - shown.length} more`);
  if (s.pages.length === 0)
    lines.push("  Nothing found: no page changes on every visit or misses the cache.");
  if (!s.staticListed)
    lines.push(
      '  Caching was not judged: no page is marked static in gaugeline.cost.json (for example "static": ["/", "/menu"]).',
    );
  if (s.fine.length > 0) lines.push(`  Fine: ${s.fine.join(", ")}`);
  for (const u of s.unread) lines.push(`  Not read: ${u.path} (${u.reason})`);
  lines.push("Account usage");
  if (s.account.kind === "fixed-plan")
    lines.push(
      `  Not applicable: fixed plan. ${s.account.builder} charges one plan price, so there is no usage to watch. The page checks above still apply: a page that rebuilds on every visit is slow as well.`,
    );
  else
    for (const p of s.account.providers) {
      if (p.kind === "could-not-check") lines.push(`  ${p.provider}: could not check: ${p.reason}`);
      else if (p.kind === "steady")
        lines.push(
          p.metrics === 0
            ? `  ${p.provider}: no usage in the ${p.window} days before ${writeDate(`${p.day}T00:00:00Z`)}`
            : `  ${p.provider}: no jump over the ${p.window} days before ${writeDate(`${p.day}T00:00:00Z`)} (${p.metrics} metric${p.metrics === 1 ? "" : "s"} read)`,
        );
      else for (const j of p.jumps) lines.push(`  ${p.provider}: ${j.metric} ${jumpPhrase(j)}`);
    }
  return lines;
}
