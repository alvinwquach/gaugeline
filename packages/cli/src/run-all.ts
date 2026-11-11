import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprint, parseResult, siteEnv, type Result } from "@gaugeline/core";
import { refusal, type Site } from "./sites.js";

/** How one site's check is run: the CLI's own main, given that site's argv, environment and folder. */
export type RunOne = (
  argv: string[],
  io: {
    stdout: { write(s: string): unknown };
    stderr: { write(s: string): unknown };
    env: Record<string, string | undefined>;
    now?: () => Date;
  },
  cwd: string,
) => Promise<number>;

export interface SiteOutcome {
  site: string;
  /** Written run file, relative to the runs folder. */
  file?: string;
  /** Set when the site couldn't run: refused, unreachable, a bad config. */
  couldNotRun?: string;
  /** Findings not in the site's previous run. Undefined on its first run (nothing to compare). */
  new?: number;
  newFixFirst?: number;
  fixed?: number;
  openFixFirst?: number;
  open?: number;
}

/** The newest saved run in runs/<site>/ older than today's file, if any. */
function previousRun(dir: string, today: string): Result | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f < today)
    .sort();
  for (const f of files.reverse()) {
    try {
      return parseResult(JSON.parse(readFileSync(join(dir, f), "utf8")));
    } catch {
      continue;
    }
  }
  return undefined;
}

/** New, fixed and open counts against the previous run, by finding fingerprint. */
export function compareRuns(prev: Result | undefined, now: Result): Omit<SiteOutcome, "site"> {
  const high = now.findings.filter((f) => f.severity === "high").length;
  if (!prev) return { open: now.findings.length, openFixFirst: high };
  const before = new Set(prev.findings.map(fingerprint));
  const after = new Set(now.findings.map(fingerprint));
  const added = now.findings.filter((f) => !before.has(fingerprint(f)));
  return {
    new: added.length,
    newFixFirst: added.filter((f) => f.severity === "high").length,
    fixed: [...before].filter((k) => !after.has(k)).length,
    open: now.findings.length,
    openFixFirst: high,
  };
}

/** The first line a failed run printed: the reason, without the "Try:" hint. */
const reasonOf = (stderr: string) =>
  stderr
    .split("\n")
    .map((l) => l.trim())
    .find(
      (l) => l !== "" && !l.startsWith("Try:") && !l.startsWith("Gaugeline ") && !/^ /.test(l),
    ) ?? "the check could not run";

async function runSite(
  site: Site,
  opts: {
    runsDir: string;
    env: Record<string, string | undefined>;
    now: () => Date;
    allowPrivate: boolean;
    renewals: boolean;
    cost: boolean;
    trackers: boolean;
    libraries: boolean;
    wordpress: boolean;
    backups: boolean;
    published: boolean;
    runOne: RunOne;
  },
): Promise<SiteOutcome> {
  const refused = refusal(site);
  if (refused) return { site: site.name, couldNotRun: refused };
  const out: string[] = [];
  const err: string[] = [];
  let code: number;
  try {
    code = await opts.runOne(
      [
        site.address,
        "--json",
        "--no-open",
        "--quiet",
        ...(opts.allowPrivate ? ["--allow-private"] : []),
        ...(opts.renewals ? ["--renewals"] : []),
        ...(opts.cost ? ["--cost"] : []),
        ...(opts.trackers ? ["--trackers"] : []),
        ...(opts.libraries ? ["--libraries"] : []),
        ...(opts.wordpress ? ["--wordpress"] : []),
        ...(opts.backups ? ["--backups"] : []),
        ...(opts.published ? ["--published"] : []),
      ],
      {
        stdout: { write: (s: string) => out.push(s) },
        stderr: { write: (s: string) => err.push(s) },
        env: siteEnv(opts.env, site.keyPrefix),
        now: opts.now,
      },
      site.configDir,
    );
  } catch (e) {
    return { site: site.name, couldNotRun: (e as Error).message };
  }
  let result: Result;
  try {
    result = parseResult(JSON.parse(out.join("")));
  } catch {
    return { site: site.name, couldNotRun: reasonOf(err.join("")) };
  }
  void code;
  const today = `${opts.now().toISOString().slice(0, 10)}.json`;
  const dir = join(opts.runsDir, site.name);
  const prev = previousRun(dir, today);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, today), `${JSON.stringify(result, null, 2)}\n`);
  return { site: site.name, file: `${site.name}/${today}`, ...compareRuns(prev, result) };
}

/**
 * Every selected site, one at a time unless `parallel` > 1. Sites on one host share a lane, so two
 * runs never press the same host at once. One site failing never stops the rest.
 */
export async function runAll(
  sites: readonly Site[],
  opts: {
    runsDir: string;
    env: Record<string, string | undefined>;
    now?: () => Date;
    parallel?: number;
    allowPrivate?: boolean;
    /** Each site's run also checks what lapses (--renewals). */
    renewals?: boolean;
    /** Each site's run also checks what runs up the hosting bill (--cost). */
    cost?: boolean;
    /** Each site's run also lists the trackers on pages with a form (--trackers). */
    trackers?: boolean;
    /** Each site's run also checks the JavaScript libraries it serves (--libraries). */
    libraries?: boolean;
    /** Each site's run also runs the WordPress checks (--wordpress). */
    wordpress?: boolean;
    /** Each site's run also compares changed CMS items with their pages (--published). */
    /** Each site's run also reads when its content and database were last backed up (--backups). */
    backups?: boolean;
    published?: boolean;
    runOne: RunOne;
  },
): Promise<SiteOutcome[]> {
  const now = opts.now ?? (() => new Date());
  const lanes = new Map<string, Site[]>();
  for (const s of sites) lanes.set(s.host, [...(lanes.get(s.host) ?? []), s]);
  const queue = [...lanes.values()];
  const results = new Map<string, SiteOutcome>();
  const width = Math.max(1, Math.min(opts.parallel ?? 1, queue.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (let lane = queue.shift(); lane; lane = queue.shift())
        for (const s of lane)
          results.set(
            s.name,
            await runSite(s, {
              runsDir: opts.runsDir,
              env: opts.env,
              now,
              allowPrivate: opts.allowPrivate ?? false,
              renewals: opts.renewals ?? false,
              cost: opts.cost ?? false,
              trackers: opts.trackers ?? false,
              libraries: opts.libraries ?? false,
              wordpress: opts.wordpress ?? false,
              backups: opts.backups ?? false,
              published: opts.published ?? false,
              runOne: opts.runOne,
            }),
          );
    }),
  );
  return sites.map((s) => results.get(s.name) as SiteOutcome);
}

/** Worst first: couldn't run, then new fix-first, open fix-first, new; then by name. */
export function worstFirst(rows: readonly SiteOutcome[]): SiteOutcome[] {
  const rank = (r: SiteOutcome): number[] => [
    r.couldNotRun ? 0 : 1,
    -(r.newFixFirst ?? 0),
    -(r.openFixFirst ?? 0),
    -(r.new ?? 0),
  ];
  return [...rows].sort((a, b) => {
    const x = rank(a);
    const y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
    return a.site < b.site ? -1 : 1;
  });
}

export function formatRunAll(rows: readonly SiteOutcome[]): string {
  const sorted = worstFirst(rows);
  const w = Math.max(4, ...sorted.map((r) => r.site.length));
  const num = (v: number | undefined) => (v === undefined ? "–" : String(v)).padStart(5);
  const lines = [`${"Site".padEnd(w)}    New  Fixed  Fix first`];
  for (const r of sorted)
    lines.push(
      r.couldNotRun
        ? `${r.site.padEnd(w)}  couldn't run: ${r.couldNotRun}`
        : `${r.site.padEnd(w)}  ${num(r.new)}  ${num(r.fixed)}  ${num(r.openFixFirst).padStart(9)}${r.new === undefined ? "  (first run: nothing to compare yet)" : ""}`,
    );
  const failed = rows.filter((r) => r.couldNotRun).length;
  const flagged = rows.filter((r) => (r.newFixFirst ?? 0) > 0).length;
  lines.push(
    `${rows.length} site${rows.length === 1 ? "" : "s"}: ${flagged} with a new fix-first finding, ${failed} couldn't run.`,
  );
  return lines.join("\n");
}

/** 1 when any site has a new fix-first finding; else 2 when one couldn't run; else 0. */
export function runAllExit(rows: readonly SiteOutcome[]): 0 | 1 | 2 {
  if (rows.some((r) => (r.newFixFirst ?? 0) > 0)) return 1;
  if (rows.some((r) => r.couldNotRun)) return 2;
  return 0;
}
