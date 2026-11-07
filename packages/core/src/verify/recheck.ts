import { NetworkError } from "../errors.js";
import { FetchError, type Fetcher, type Hop } from "../fetcher.js";
import type { Finding } from "../model.js";
import { buildSnapshot } from "../snapshot.js";
import type { PageRows } from "./classify.js";

/**
 * What a crawler gets from one page: a normal request, the same address with the framework's
 * prefetch header (RSC: 1), and whether either response tells caches the two differ (Vary: RSC).
 * Two GETs per page, through the fetcher; the RSC header is the only header added.
 */
export interface CrawlerView {
  url: string;
  normal: { status: number; contentType: string; words: number };
  prefetch: { status: number; contentType: string };
  /** The Vary tokens of both responses, lower case, de-duplicated. */
  vary: string[];
  /** The export lines that resolved to this page. */
  exportLines: number[];
  /** CDN headers seen (cf-ray, x-cache, via…): a stripped Vary may be the CDN's doing. */
  cdn?: string[];
}

export const RSC_HEADER = { rsc: "1" } as const;

export const RSC_TITLES = {
  "rsc-served-as-page": "The page address returns app data, not a page",
  "rsc-vary-missing": "One address serves a page and app data, and caches aren't told",
} as const;
export type RscCheckId = keyof typeof RSC_TITLES;

/** "RSC, Next-Router-State-Tree" -> ["rsc", "next-router-state-tree"]. A repeated header arrives joined. */
export function parseVary(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t !== ""),
    ),
  ];
}

/** Vary: * varies on everything: no cache reuses the response, so RSC is covered too. */
export const varyCoversRsc = (tokens: readonly string[]) =>
  tokens.includes("rsc") || tokens.includes("*");

const COMPONENT = /text\/x-component/i;
const HTML = /text\/html|application\/xhtml/i;
const CDN_HEADERS = [
  "cf-ray",
  "x-cache",
  "x-served-by",
  "via",
  "x-vercel-cache",
  "x-amz-cf-id",
  "x-fastly-request-id",
];

/** The decision table: which of the two checks a view fails, with the evidence. Pure. */
export function judge(view: CrawlerView): Finding[] {
  const out: Finding[] = [];
  const add = (checkId: RscCheckId, evidence: string) =>
    out.push({ checkId, severity: "high", title: RSC_TITLES[checkId], evidence, url: view.url });
  const prefetchWorks = COMPONENT.test(view.prefetch.contentType) && view.prefetch.status < 300;
  if (COMPONENT.test(view.normal.contentType))
    add(
      "rsc-served-as-page",
      `A normal request returns ${view.normal.contentType}: visitors and search engines get the framework's data format instead of HTML`,
    );
  else if (HTML.test(view.normal.contentType) && view.normal.words === 0 && prefetchWorks)
    add(
      "rsc-served-as-page",
      "A normal request returns HTML with no words a search engine can read, while the prefetch request returns the page's data: the content arrives only by script",
    );
  if (HTML.test(view.normal.contentType) && prefetchWorks && !varyCoversRsc(view.vary))
    add(
      "rsc-vary-missing",
      `The address returns HTML to a normal request and text/x-component to RSC: 1, and neither response lists RSC in Vary${view.vary.length > 0 ? ` (Vary: ${view.vary.join(", ")})` : ""}: a shared cache can hand the data format to a visitor${view.cdn && view.cdn.length > 0 ? `. A CDN answered (${view.cdn.join(", ")}): if the origin sends Vary: RSC, the CDN may be stripping it; check its cache key and header settings` : ""}`,
    );
  return out;
}

/** A page that couldn't be read: rate-limited, refused, an error, or gone. Never a finding. */
export interface Unread {
  url: string;
  reason: string;
  exportLines: number[];
}

const contentType = (h: Hop | undefined) =>
  (h?.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
const unreadStatus = (s: number) =>
  s === 401 || s === 403 || s === 404 || s === 410 || s === 429 || s >= 500;

async function hopsOf(
  fetcher: Fetcher,
  url: string,
  headers?: Record<string, string>,
): Promise<Hop[] | string> {
  try {
    return await fetcher.get(url, headers ? { headers, headersSameOrigin: true } : {});
  } catch (err) {
    if (err instanceof FetchError && err.hops.length > 0) return err.hops;
    if (err instanceof NetworkError) return err.message;
    throw err;
  }
}

/** The prefetch half of a view, for a page already read normally (the plain site check). */
export async function prefetchOf(
  fetcher: Fetcher,
  url: string,
): Promise<{ status: number; contentType: string; vary: string[]; cdn: string[] } | string> {
  const hops = await hopsOf(fetcher, url, RSC_HEADER);
  if (typeof hops === "string") return hops;
  const last = hops.at(-1);
  const status = last?.status ?? 0;
  if (unreadStatus(status)) return `the prefetch request answered ${status}`;
  return {
    status,
    contentType: contentType(last),
    vary: parseVary(last?.headers.vary),
    cdn: CDN_HEADERS.filter((h) => last?.headers[h] !== undefined),
  };
}

/** Both requests for one page. */
export async function viewPage(
  fetcher: Fetcher,
  url: string,
  exportLines: number[] = [],
): Promise<CrawlerView | Unread> {
  const hops = await hopsOf(fetcher, url);
  if (typeof hops === "string") return { url, reason: hops, exportLines };
  const last = hops.at(-1);
  const final = last?.url ?? url;
  const status = last?.status ?? 0;
  if (unreadStatus(status)) return { url: final, reason: `answered ${status}`, exportLines };
  const pre = await prefetchOf(fetcher, url);
  if (typeof pre === "string") return { url: final, reason: pre, exportLines };
  const cdn = [
    ...new Set([...CDN_HEADERS.filter((h) => last?.headers[h] !== undefined), ...pre.cdn]),
  ];
  return {
    url: final,
    normal: { status, contentType: contentType(last), words: buildSnapshot(hops).wordCount },
    prefetch: { status: pre.status, contentType: pre.contentType },
    vary: [...new Set([...parseVary(last?.headers.vary), ...pre.vary])],
    exportLines,
    ...(cdn.length > 0 ? { cdn } : {}),
  };
}

export interface PageToCheck {
  url: string;
  rows: PageRows;
}

/** The same export always gives the same pages: most export rows first, then by address. */
export function selectPages(pages: ReadonlyMap<string, PageRows>, limit: number): PageToCheck[] {
  return [...pages]
    .sort(([a, ra], [b, rb]) => rb.lines.length - ra.lines.length || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, Math.max(0, limit))
    .map(([url, rows]) => ({ url, rows }));
}

export interface RecheckResult {
  results: CrawlerView[];
  findings: Finding[];
  couldNotCheck: Unread[];
  /** Prefetch-payload rows behind the pages that answered. */
  explained: number;
}

export async function recheck(
  pages: readonly PageToCheck[],
  opts: { fetcher: Fetcher; limit?: number },
): Promise<RecheckResult> {
  const chosen = pages.slice(0, opts.limit ?? pages.length);
  const views = await Promise.all(chosen.map((p) => viewPage(opts.fetcher, p.url, p.rows.lines)));
  const results: CrawlerView[] = [];
  const couldNotCheck: Unread[] = [];
  let explained = 0;
  views.forEach((v, i) => {
    if ("reason" in v) {
      couldNotCheck.push(v);
      return;
    }
    results.push(v);
    explained += chosen[i]?.rows.payloads ?? 0;
  });
  return { results, findings: results.flatMap(judge), couldNotCheck, explained };
}

const n = (v: number) => v.toLocaleString("en-US");
const shortUrl = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.pathname}${x.search}`;
  } catch {
    return u;
  }
};

/** The re-check's lines, ending with the line the docs quote. */
export function formatRecheck(
  r: RecheckResult,
  opts: { asked: number; available: number },
): string {
  const checked = r.results.length + r.couldNotCheck.length;
  const lines = [
    opts.available < opts.asked
      ? `Re-checked all ${n(checked)} page${checked === 1 ? "" : "s"} (the export has fewer than --limit ${n(opts.asked)}):`
      : `Re-checked the ${n(checked)} page${checked === 1 ? "" : "s"} behind the most export rows:`,
  ];
  const bad = new Map<string, Finding[]>();
  for (const f of r.findings) bad.set(f.url, [...(bad.get(f.url) ?? []), f]);
  for (const v of r.results) {
    const found = bad.get(v.url);
    if (!found)
      lines.push(
        `  ✓ ${shortUrl(v.url)}  ${n(v.normal.words)} words; explains ${n(v.exportLines.length)} export row${v.exportLines.length === 1 ? "" : "s"}`,
      );
    else
      for (const f of found)
        lines.push(`  ✗ ${shortUrl(v.url)}  ${f.checkId}`, `      ${f.evidence}`);
  }
  for (const u of r.couldNotCheck)
    lines.push(`  ? ${shortUrl(u.url)} could not be checked: ${u.reason}`);
  const fix = new Set(r.findings.map((f) => f.url)).size;
  const readable = r.results.length - fix;
  lines.push(
    `${n(checked)} page${checked === 1 ? "" : "s"} re-checked: ${n(readable)} return${readable === 1 ? "s" : ""} a readable page, ${n(fix)} need${fix === 1 ? "s" : ""} a fix${r.couldNotCheck.length > 0 ? `, ${n(r.couldNotCheck.length)} could not be checked` : ""}. ${n(r.explained)} export row${r.explained === 1 ? "" : "s"} explained.`,
  );
  return lines.join("\n");
}
