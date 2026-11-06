import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { Finding } from "../model.js";
import { parseCsv } from "./columns.js";
import type { PlanRow } from "./read.js";
import { splitLegacy } from "./redirects.js";

/**
 * Pages with nowhere to go: addresses that exist today (a crawl export, a sitemap, a Search Console
 * export or a plain list, read as a stream) that have no row in the plan and no redirect. The plan
 * is one Set of paths; each live address is one lookup, so a 200,000-row crawl is linear.
 */
export type LiveFormat = "crawl" | "search-console" | "sitemap" | "list";

export interface LiveUrl {
  url: string;
  /** Clicks, impressions or position, when the export has the column. */
  metric?: number;
}

export interface LiveRead {
  format: LiveFormat;
  /** Which column ranks the uncovered pages, when there is one. */
  metric?: "clicks" | "impressions" | "position";
}

const ASSET =
  /\.(?:css|js|mjs|map|json|xml|txt|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|pdf|zip|mp4|webm|mp3|wav)$/i;
const FEED = /(?:^|\/)(?:feed|rss|atom)(?:\/|$)|\.(?:rss|atom)$/i;
const PAGED = /[?&]page=\d+|\/page\/\d+\/?$/i;

/** The path a plan or a live address is compared on: lower case, no trailing slash, no query or #. */
export function coverageKey(address: string): string | undefined {
  let path: string;
  try {
    path = new URL(address.trim(), "https://plan.invalid").pathname;
  } catch {
    return undefined;
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw path when it isn't valid percent-encoding.
  }
  path = path.toLowerCase().replace(/\/+$/, "");
  return path === "" ? "/" : path;
}

/** A glob over paths: * is one segment's characters, ** any number of segments. */
export function globToRegExp(glob: string): RegExp {
  const body = glob
    .trim()
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${body.startsWith("/") ? "" : "/?"}${body}$`, "i");
}

/** Assets, feeds, paginated pages and the --ignore globs are not pages to plan for. */
export function ignored(address: string, globs: readonly RegExp[] = []): boolean {
  let u: URL;
  try {
    u = new URL(address.trim(), "https://plan.invalid");
  } catch {
    return true;
  }
  if (ASSET.test(u.pathname) || FEED.test(u.pathname) || PAGED.test(`${u.pathname}${u.search}`))
    return true;
  return globs.some((g) => g.test(u.pathname));
}

/** Which export this is, from its first lines: XML, a CSV header, or one address per line. */
export function detectLiveFormat(head: string): LiveRead {
  const text = head.replace(/^\uFEFF/, "").trimStart();
  if (/^<\?xml|<urlset\b|<sitemapindex\b/i.test(text)) return { format: "sitemap" };
  const first = text.split(/\r?\n/)[0] ?? "";
  const header = (parseCsv(first)[0]?.cells ?? []).map((c) => c.trim().toLowerCase());
  const has = (name: string) => header.includes(name);
  const metric = has("clicks")
    ? "clicks"
    : has("impressions")
      ? "impressions"
      : has("position")
        ? "position"
        : undefined;
  if (has("address")) return { format: "crawl", ...(metric ? { metric } : {}) };
  if (has("top pages") || has("page") || has("pages") || has("url"))
    return { format: "search-console", ...(metric ? { metric } : {}) };
  return { format: "list" };
}

/**
 * Every live address in the export, one at a time: lines are read from the stream and dropped, so
 * memory doesn't grow with the file. A crawl export keeps only rows answering 200 when it has a
 * Status Code column; a sitemap yields its <loc>s.
 */
export async function* readLive(
  stream: Readable,
  onFormat?: (read: LiveRead) => void,
): AsyncGenerator<LiveUrl> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let read: LiveRead | undefined;
  let columns: { url: number; metric?: number; status?: number } | undefined;
  for await (const raw of lines) {
    const line = read === undefined ? raw.replace(/^\uFEFF/, "") : raw;
    if (read === undefined) {
      if (line.trim() === "") continue;
      read = detectLiveFormat(line);
      onFormat?.(read);
      if (read.format === "crawl" || read.format === "search-console") {
        const header = (parseCsv(line)[0]?.cells ?? []).map((c) => c.trim().toLowerCase());
        const url = header.findIndex((h) =>
          ["address", "top pages", "page", "pages", "url"].includes(h),
        );
        const metric = read.metric ? header.indexOf(read.metric) : -1;
        const status = header.indexOf("status code");
        columns = {
          url: Math.max(0, url),
          ...(metric >= 0 ? { metric } : {}),
          ...(status >= 0 ? { status } : {}),
        };
        continue;
      }
    }
    if (read.format === "sitemap") {
      for (const m of line.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi))
        if (m[1]) yield { url: m[1].replace(/&amp;/g, "&") };
      continue;
    }
    if (read.format === "list") {
      const url = line.trim();
      if (url !== "" && !url.startsWith("#")) yield { url };
      continue;
    }
    const cells = parseCsv(line)[0]?.cells ?? [];
    const url = cells[columns?.url ?? 0]?.trim() ?? "";
    if (url === "") continue;
    if (columns?.status !== undefined) {
      const status = cells[columns.status]?.trim();
      if (status !== undefined && status !== "" && status !== "200") continue;
    }
    const metric =
      columns?.metric !== undefined
        ? Number((cells[columns.metric] ?? "").replace(/[,%\s]/g, ""))
        : Number.NaN;
    yield Number.isFinite(metric) ? { url, metric } : { url };
  }
}

export interface CoverageOptions {
  file?: string;
  /** --ignore globs over paths. */
  ignore?: readonly string[];
  /** Which column the metric came from (sets the sort and the evidence wording). */
  metric?: LiveRead["metric"];
  /** At least this many pages sharing one prefix swap are reported once. */
  prefixGroup?: number;
}

export interface CoverageResult {
  findings: Finding[];
  /** Live addresses read, and how many were left out as assets, feeds, pages or --ignore. */
  live: number;
  ignored: number;
}

const segments = (path: string) => path.split("/").filter((s) => s !== "");

/**
 * Live addresses against the plan: covered is every row's path and every legacy path. What is
 * left is plan-uncovered-page, sorted by clicks (or impressions, or position) when the export has
 * them. When at least `prefixGroup` of them differ from planned rows only by a leading path prefix
 * (/blog/x live, /resources/blog/x planned), that is one finding for the prefix, not one each.
 */
export async function checkCoverage(
  rows: readonly PlanRow[],
  live: AsyncIterable<LiveUrl> | Iterable<LiveUrl>,
  opts: CoverageOptions = {},
): Promise<CoverageResult> {
  const file = opts.file ?? "the plan";
  const globs = (opts.ignore ?? []).map(globToRegExp);
  const covered = new Set<string>();
  const planned = new Map<string, PlanRow[]>();
  for (const row of rows) {
    const key = coverageKey(row.path);
    if (key) {
      covered.add(key);
      const list = planned.get(key);
      if (list) list.push(row);
      else planned.set(key, [row]);
    }
    for (const legacy of splitLegacy(row.legacyUrl)) {
      const k = coverageKey(legacy);
      if (k) covered.add(k);
    }
  }
  let count = 0;
  let skipped = 0;
  const uncovered = new Map<string, LiveUrl>();
  /** Planned paths that exist today: only the others can be a planned page under another prefix. */
  const plannedLive = new Set<string>();
  for await (const item of live) {
    count++;
    if (ignored(item.url, globs)) {
      skipped++;
      continue;
    }
    const key = coverageKey(item.url);
    if (!key || uncovered.has(key)) continue;
    if (covered.has(key)) {
      if (planned.has(key)) plannedLive.add(key);
      continue;
    }
    uncovered.set(key, item);
  }

  // A planned path that is a live path with a prefix added (or taken away): grouped by the prefix.
  const swaps = new Map<string, { live: string[]; rows: PlanRow[] }>();
  const plannedNotLive = [...planned.keys()].filter((k) => !plannedLive.has(k));
  const bySuffix = new Map<string, string>();
  for (const p of plannedNotLive) {
    const s = segments(p);
    for (let i = 1; i < s.length; i++) bySuffix.set(`/${s.slice(i).join("/")}`, p);
  }
  for (const key of uncovered.keys()) {
    let planPath = bySuffix.get(key);
    let swap: string | undefined;
    if (planPath) swap = `${planPath.slice(0, planPath.length - key.length)} → (none)`;
    else {
      const s = segments(key);
      for (let i = 1; i < s.length && !planPath; i++) {
        const tail = `/${s.slice(i).join("/")}`;
        if (planned.has(tail)) {
          planPath = tail;
          swap = `(none) → /${s.slice(0, i).join("/")}`;
        }
      }
    }
    if (!planPath || !swap) continue;
    const group = swaps.get(swap) ?? { live: [], rows: [] };
    group.live.push(key);
    group.rows.push(...(planned.get(planPath) ?? []));
    swaps.set(swap, group);
  }
  const findings: Finding[] = [];
  const grouped = new Set<string>();
  for (const [swap, group] of swaps) {
    if (group.live.length < (opts.prefixGroup ?? 3)) continue;
    for (const k of group.live) grouped.add(k);
    const [planPrefix, livePrefix] = swap.split(" → ");
    const example = group.live[0] ?? "";
    findings.push({
      checkId: "plan-uncovered-page",
      severity: "high",
      title: "A page that exists today has no row in the plan",
      evidence: `${group.rows.length} rows assume a path prefix that does not exist today: the plan has ${planPrefix === "(none)" ? "no prefix" : `${planPrefix}/…`}, the site has ${livePrefix === "(none)" ? "none" : `${livePrefix}/…`} (${group.live.length} pages, e.g. ${example})`,
      url: file,
      group: { key: `prefix:${swap}`, lines: [...new Set(group.rows.map((r) => r.line))] },
    });
  }
  const rest = [...uncovered].filter(([k]) => !grouped.has(k));
  if (opts.metric)
    rest.sort(([, a], [, b]) =>
      opts.metric === "position"
        ? (a.metric ?? Infinity) - (b.metric ?? Infinity)
        : (b.metric ?? -1) - (a.metric ?? -1),
    );
  for (const [key, item] of rest)
    findings.push({
      checkId: "plan-uncovered-page",
      severity: "high",
      title: "A page that exists today has no row in the plan",
      evidence: `${key} exists today and has no row or redirect in the plan${item.metric !== undefined && opts.metric ? ` (${opts.metric === "position" ? `position ${item.metric}` : `${item.metric.toLocaleString("en-GB")} ${opts.metric}`})` : ""}`,
      url: file,
      group: { key, lines: [] },
    });
  return { findings, live: count, ignored: skipped };
}
