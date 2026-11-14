import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  HISTORY_SCHEMA,
  RENEWAL_CHECK_IDS,
  RUN_ID,
  inOrder,
  isRunRecord,
  pruneRuns,
  runId,
  type Finding,
  type PageRecord,
  type PageSnapshot,
  type RecordedSiteFinding,
  type RunRecord,
  type RunResult,
} from "@gaugeline/core";

/**
 * The local runs store: one JSON file per run, in a folder per host. Storage is the CLI's concern;
 * core only sees the records. A run is read only when its file name is its run id and its content is
 * the shape this version writes, so nothing inside a file ever names a path. A file that is not valid,
 * too big or another schema is skipped, never trusted and never deleted.
 */
export const RUNS_DIR = join(".gaugeline", "runs");
const PRUNED_FILE = "pruned-before.txt";
const FILE_NAME = /^(r-\d{8}T\d{6}Z)\.json$/;
/** A run is a few kilobytes; a bigger file is not one of ours. */
const MAX_RUN_BYTES = 1_000_000;
/**
 * The newest runs read for one host. The same cap applies when pruning: runs older than the newest
 * 500 files are neither read nor pruned, so a host with more than that keeps its oldest files on disk
 * until they are removed by hand.
 */
const MAX_RUN_FILES = 500;

export function hostDir(cwd: string, host: string): string {
  // A name made only of dots would climb out of the runs folder.
  const name = host.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
  return join(cwd, RUNS_DIR, /^\.*$/.test(name) ? "_" : name);
}

/** The path of a run file, which must stay inside the host's folder. */
function runPath(dir: string, id: string): string {
  const path = resolve(dir, `${id}.json`);
  if (!RUN_ID.test(id) || !path.startsWith(resolve(dir) + sep))
    throw new Error("A run id is r- and a UTC time such as r-20261103T100000Z.");
  return path;
}

export function readRuns(cwd: string, host: string): { runs: RunRecord[]; prunedBefore?: string } {
  const dir = hostDir(cwd, host);
  if (!existsSync(dir)) return { runs: [] };
  const names = readdirSync(dir)
    .filter((n) => FILE_NAME.test(n))
    .sort()
    .slice(-MAX_RUN_FILES);
  const runs: RunRecord[] = [];
  for (const name of names)
    try {
      const path = join(dir, name);
      // Never follow a link or open a device or a pipe: only a plain file of a sensible size.
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_RUN_BYTES) continue;
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRunRecord(parsed) && `${parsed.id}.json` === name) runs.push(parsed);
    } catch {
      /* not a run file: skipped */
    }
  let prunedBefore: string | undefined;
  try {
    const marker = join(dir, PRUNED_FILE);
    const text = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
    if (text !== "" && !Number.isNaN(Date.parse(text))) prunedBefore = text;
  } catch {
    /* no marker */
  }
  return { runs: inOrder(runs), ...(prunedBefore ? { prunedBefore } : {}) };
}

/** Write a file the owner alone can read: a new random name, never an existing path, then a rename. */
function writePrivate(path: string, text: string): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Write a run, then drop the runs older than the retention and note the date history is kept from. */
export function saveRun(
  cwd: string,
  host: string,
  run: RunRecord,
  now: Date,
  retentionDays: number,
): void {
  const dir = hostDir(cwd, host);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivate(runPath(dir, run.id), `${JSON.stringify(run, null, 2)}\n`);
  const { dropped, cutoff } = pruneRuns(readRuns(cwd, host).runs, now, retentionDays);
  // Only runs read from files named for their id, so the path is the one that was read.
  for (const r of dropped) rmSync(runPath(dir, r.id), { force: true });
  if (dropped.length > 0) writePrivate(join(dir, PRUNED_FILE), `${cutoff}\n`);
}

/** What a site-wide finding is called in a run: its own address, never a page. Undefined when it cannot be read. */
function siteAddress(url: string, base: URL): string | undefined {
  let u: URL;
  try {
    u = new URL(url, base);
  } catch {
    return undefined;
  }
  // "domain:", "token:" and "vercel:" addresses are opaque: kept whole. A web address keeps its
  // origin and path only, so no query string, no user name and no fragment is stored.
  const address = u.origin === "null" ? `${u.protocol}${u.pathname}` : `${u.origin}${u.pathname}`;
  return address.slice(0, 200);
}

/**
 * The renewal checks this run could answer, sorted: only with --renewals, and only a check that ran
 * (it passed or found something) and did not fail or say could-not-check. A site finding missing from
 * a run is "gone" only when its check is in this list; a run that cannot say lists nothing.
 */
export function renewalChecksRead(
  renewing: boolean,
  findings: readonly Pick<Finding, "checkId">[],
  result: Pick<RunResult, "passed" | "failed" | "couldNotCheck">,
): string[] {
  if (!renewing) return [];
  const ran = new Set([...result.passed, ...findings.map((f) => f.checkId)]);
  for (const c of result.couldNotCheck) ran.delete(c.id);
  for (const c of result.failed) ran.delete(c.id);
  return [...RENEWAL_CHECK_IDS].filter((id) => ran.has(id)).sort();
}

/**
 * What one run keeps: the checked page's record, the findings on that page, and the site's own
 * findings. A page finding on any other page (a broken link found here, say) cannot be compared with
 * an earlier run of this one, so it is counted, not recorded, and the report says how many. A renewal
 * or certificate finding is about the site, not a page (a domain, a token, a hosting project, the
 * certificate of www), and every run asks the same question, so it is kept by the address its check
 * gave it. Only a renewal finding whose address cannot be read is counted with the others.
 */
export function buildRunRecord(
  snapshot: Pick<PageSnapshot, "finalUrl">,
  record: PageRecord,
  findings: readonly Pick<Finding, "checkId" | "url" | "title">[],
  at: Date,
  options: { renewalChecks?: readonly string[] } = {},
): RunRecord {
  const base = new URL(snapshot.finalUrl);
  const pagePath = base.pathname;
  const here: RunRecord["findings"] = [];
  const site = new Map<string, RecordedSiteFinding>();
  let offPage = 0;
  for (const f of findings) {
    let url: URL | undefined;
    try {
      url = new URL(f.url, base);
    } catch {
      url = undefined;
    }
    if (url !== undefined && url.origin === base.origin && url.pathname === pagePath)
      here.push({ checkId: f.checkId, path: pagePath, title: f.title.slice(0, 200) });
    else {
      const address = RENEWAL_CHECK_IDS.has(f.checkId) ? siteAddress(f.url, base) : undefined;
      if (address === undefined) offPage++;
      else {
        const found = { checkId: f.checkId, address, title: f.title.slice(0, 200) };
        site.set(`${found.checkId} ${found.address}`, found);
      }
    }
  }
  return {
    schema: HISTORY_SCHEMA,
    id: runId(at),
    takenAt: at.toISOString(),
    pages: { [pagePath]: record },
    findings: here,
    ...(offPage > 0 ? { offPage } : {}),
    ...(site.size > 0 ? { siteFindings: [...site.values()] } : {}),
    ...(options.renewalChecks && options.renewalChecks.length > 0
      ? { renewalChecks: [...options.renewalChecks] }
      : {}),
  };
}
