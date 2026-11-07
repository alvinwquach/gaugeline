import { createCsvStream, type CsvRecord } from "./csv-stream.js";

/**
 * A crawler's export, translated: each row's address classified as a page, an asset, a data route
 * or a framework prefetch payload, and every payload resolved back to the page it belongs to.
 * Pure: no request is made, so it runs on an export for a site you can't reach.
 */
export interface CrawlRow {
  line: number;
  address: string;
  issue?: string;
}

/** What a summary keeps per page: the export lines that resolved to it, and how many were payloads. */
export interface PageRows {
  lines: number[];
  payloads: number;
}

export type RowKind = "page" | "asset" | "data-route" | "prefetch-payload";
export const ROW_KINDS: readonly RowKind[] = ["prefetch-payload", "asset", "data-route", "page"];
export type Framework = "next" | "astro" | "nuxt";

export interface Classified {
  kind: RowKind;
  framework?: Framework;
  /** The page a payload or page row stands for, as its page key. Absent for assets and data routes. */
  pageUrl?: string;
}

export interface CrawlColumns {
  address: string;
  issue?: string;
}

/** Header names, normalised, that hold the address. Screaming Frog says Address; sitemaps say loc. */
const ADDRESS_HEADERS = new Set(["address", "url", "urls", "loc", "page url", "uri"]);
const ISSUE_HEADERS = new Set(["issue", "issues", "issue name", "issue type", "problem"]);
const norm = (h: string) =>
  h
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const isUrl = (s: string) => {
  try {
    return /^https?:$/.test(new URL(s.trim()).protocol);
  } catch {
    return false;
  }
};

/**
 * The address column: a header named like one, else (an export in another language) the first
 * column where most of the sample's cells parse as http(s) addresses. undefined when neither.
 */
export function detectColumns(
  header: readonly string[],
  sample: readonly (readonly string[])[],
): { address: number; issue?: number } | undefined {
  const names = header.map(norm);
  let address = names.findIndex((h) => ADDRESS_HEADERS.has(h));
  if (address < 0) {
    address = header.findIndex((_, i) => {
      const cells = sample.map((r) => r[i] ?? "").filter((c) => c.trim() !== "");
      return cells.length > 0 && cells.filter(isUrl).length / cells.length > 0.5;
    });
  }
  if (address < 0) return undefined;
  const issue = names.findIndex((h) => ISSUE_HEADERS.has(h));
  return { address, ...(issue >= 0 && issue !== address ? { issue } : {}) };
}

/** The key a page is compared on: lower-case host, no fragment, no trailing slash (but /), query kept. */
export function pageKey(u: URL): string {
  const x = new URL(u.href);
  x.hash = "";
  x.hostname = x.hostname.toLowerCase();
  if (x.pathname.length > 1) x.pathname = x.pathname.replace(/\/+$/, "") || "/";
  return x.href;
}

const ASSET_EXT =
  /\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|woff2?|ttf|otf|eot|pdf)$/i;
const BUILD_DIRS = /^\/(?:_next\/static|_astro|_nuxt)(?:\/|$)/;
const SITEMAP_OR_FEED = /(?:sitemap[^/]*|(?:^|\/)(?:rss|atom|feed|index)\.xml|\/feed\.json)$/i;

export function classify(row: Pick<CrawlRow, "address">): Classified {
  let u: URL;
  try {
    u = new URL(row.address.trim());
  } catch {
    return { kind: "page" };
  }
  const path = u.pathname;
  // Next.js App Router: a prefetch of a page's React Server Component payload, ?_rsc=<hash>.
  if (u.searchParams.has("_rsc")) {
    const page = new URL(u.href);
    page.searchParams.delete("_rsc");
    return { kind: "prefetch-payload", framework: "next", pageUrl: pageKey(page) };
  }
  // Next.js Pages Router: /_next/data/<build id>/<page>.json is the page's props.
  const nextData = /^\/_next\/data\/[^/]+\/(.+)\.json$/.exec(path);
  if (nextData) {
    const page = new URL(u.href);
    const p = (nextData[1] ?? "").replace(/(?:^|\/)index$/, "");
    page.pathname = `/${p}`;
    return { kind: "prefetch-payload", framework: "next", pageUrl: pageKey(page) };
  }
  // Nuxt: <page>/_payload.json, sometimes with a bare build hash as its query.
  if (/(?:^|\/)_payload\.json$/.test(path)) {
    const page = new URL(u.href);
    page.pathname = path.replace(/_payload\.json$/, "");
    for (const k of [...page.searchParams.keys()])
      if (page.searchParams.get(k) === "") page.searchParams.delete(k);
    return { kind: "prefetch-payload", framework: "nuxt", pageUrl: pageKey(page) };
  }
  // Astro: JSON data written under its build directory. Which page it serves isn't in the address.
  if (/^\/_astro\/.+\.json$/i.test(path)) return { kind: "prefetch-payload", framework: "astro" };
  if (ASSET_EXT.test(path) || BUILD_DIRS.test(path)) return { kind: "asset" };
  if (/^\/api(?:\/|$)/i.test(path)) return { kind: "data-route" };
  if (/\.(?:json|xml)$/i.test(path) && !SITEMAP_OR_FEED.test(path)) return { kind: "data-route" };
  return { kind: "page", pageUrl: pageKey(u) };
}

export interface CrawlSummary {
  /** Rows read with an address. */
  total: number;
  byKind: Record<RowKind, number>;
  /**
   * Page key -> the export lines that resolved to it (real page rows included) and how many were
   * payloads. Line numbers only, never the rows' text: memory follows pages and lines, not bytes.
   */
  pages: Map<string, PageRows>;
  /** Issue name -> rows and payload rows under it, when the export has an issue column. */
  byIssue: Map<string, { total: number; payloads: number }>;
  /** Rows with an empty address: skipped and counted. */
  skipped: number;
}

const emptyKinds = (): Record<RowKind, number> => ({
  "prefetch-payload": 0,
  asset: 0,
  "data-route": 0,
  page: 0,
});

/** Count and group rows, one at a time. */
export function createSummariser() {
  const s: CrawlSummary = {
    total: 0,
    byKind: emptyKinds(),
    pages: new Map(),
    byIssue: new Map(),
    skipped: 0,
  };
  return {
    add(row: CrawlRow) {
      if (row.address.trim() === "") {
        s.skipped++;
        return;
      }
      s.total++;
      const c = classify(row);
      s.byKind[c.kind]++;
      if (row.issue !== undefined) {
        const g = s.byIssue.get(row.issue) ?? { total: 0, payloads: 0 };
        g.total++;
        if (c.kind === "prefetch-payload") g.payloads++;
        s.byIssue.set(row.issue, g);
      }
      if (c.pageUrl !== undefined) {
        const p = s.pages.get(c.pageUrl) ?? { lines: [], payloads: 0 };
        p.lines.push(row.line);
        if (c.kind === "prefetch-payload") p.payloads++;
        s.pages.set(c.pageUrl, p);
      }
    },
    result: () => s,
  };
}

export function summarise(rows: Iterable<CrawlRow>): CrawlSummary {
  const sum = createSummariser();
  for (const r of rows) sum.add(r);
  return sum.result();
}

export interface CrawlExport {
  rows: CrawlRow[];
  columns: CrawlColumns;
  warnings: string[];
}

/** No address column: the export can't be read (the command exits 2). */
export class NoAddressColumnError extends Error {
  constructor(readonly header: readonly string[]) {
    super(
      `No address column found: the header has ${header.length === 0 ? "no columns" : header.map((h) => `"${h}"`).join(", ")}, and no column holds mostly web addresses.`,
    );
    this.name = "NoAddressColumnError";
  }
}

const SAMPLE = 50;

/**
 * Read an export in chunks: the header and a sample decide the columns, then each record becomes
 * a row as it arrives. `onRow` sees every row in order; nothing else is kept.
 */
export function createCrawlReader(onRow: (row: CrawlRow) => void) {
  const csv = createCsvStream();
  let header: string[] | undefined;
  let cols: { address: number; issue?: number } | undefined;
  let held: CsvRecord[] = [];
  const warnings: string[] = [];
  const emit = (r: CsvRecord) => {
    if (!cols) return;
    if (r.cells.length === 1 && r.cells[0] === "") return;
    const address = (r.cells[cols.address] ?? "").trim();
    const issue = cols.issue !== undefined ? (r.cells[cols.issue] ?? "").trim() : undefined;
    onRow({ line: r.line, address, ...(issue ? { issue } : {}) });
  };
  const decide = () => {
    if (!header) return;
    cols = detectColumns(
      header,
      held.map((r) => r.cells),
    );
    if (!cols) throw new NoAddressColumnError(header);
    if (!ADDRESS_HEADERS.has(norm(header[cols.address] ?? "")))
      warnings.push(
        `No column is named Address or URL: read "${header[cols.address] ?? ""}", where most cells are web addresses.`,
      );
    for (const r of held) emit(r);
    held = [];
  };
  const take = (records: CsvRecord[]) => {
    for (const r of records) {
      if (!header) {
        // A title line above the header ("Internal - All"): one cell, skip it.
        if (r.cells.length === 1 && !ADDRESS_HEADERS.has(norm(r.cells[0] ?? ""))) continue;
        header = r.cells;
        continue;
      }
      if (cols) emit(r);
      else {
        held.push(r);
        if (held.length >= SAMPLE) decide();
      }
    }
  };
  return {
    push(chunk: string) {
      take(csv.push(chunk));
    },
    end(): { columns: CrawlColumns; warnings: string[] } {
      take(csv.end());
      if (!cols) {
        if (!header) throw new NoAddressColumnError([]);
        decide();
      }
      const c = cols as { address: number; issue?: number };
      const h = header as string[];
      return {
        columns: {
          address: h[c.address] ?? "",
          ...(c.issue !== undefined ? { issue: h[c.issue] ?? "" } : {}),
        },
        warnings,
      };
    },
  };
}

export function readCrawlExport(text: string): CrawlExport {
  const rows: CrawlRow[] = [];
  const reader = createCrawlReader((r) => rows.push(r));
  reader.push(text);
  return { rows, ...reader.end() };
}

/** Stream an export (a file's chunks) straight into a summary: memory follows pages, not rows. */
export async function summariseStream(
  chunks: AsyncIterable<string | Uint8Array>,
): Promise<{ summary: CrawlSummary; columns: CrawlColumns; warnings: string[] }> {
  const sum = createSummariser();
  const reader = createCrawlReader((r) => sum.add(r));
  const decoder = new TextDecoder();
  for await (const chunk of chunks)
    reader.push(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
  reader.push(decoder.decode());
  const end = reader.end();
  return { summary: sum.result(), ...end };
}

const n = (v: number) => v.toLocaleString("en-US");
const LABEL: Record<RowKind, [string, string]> = {
  "prefetch-payload": ["prefetch payload", "prefetch payloads"],
  asset: ["asset", "assets"],
  "data-route": ["data route", "data routes"],
  page: ["page", "pages"],
};
/** "Orphan URLs" reads "orphan URLs" mid-sentence; an acronym keeps its case. */
const midSentence = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]?.toLowerCase() + s.slice(1) : s);

/** The summary the docs quote: the payload line (per issue when there is one), counts, page count. */
export function formatSummary(s: CrawlSummary): string {
  const lines: string[] = [];
  const payloads = s.byKind["prefetch-payload"];
  if (s.byIssue.size > 0)
    for (const [issue, g] of [...s.byIssue].sort((a, b) => b[1].total - a[1].total))
      lines.push(`${n(g.payloads)} of ${n(g.total)} ${midSentence(issue)} were prefetch payloads`);
  else lines.push(`${n(payloads)} of ${n(s.total)} rows were prefetch payloads`);
  const width = Math.max(...ROW_KINDS.map((k) => n(s.byKind[k]).length));
  for (const k of ROW_KINDS)
    lines.push(`  ${n(s.byKind[k]).padStart(width)} ${LABEL[k][s.byKind[k] === 1 ? 0 : 1]}`);
  lines.push(
    `${n(s.pages.size)} distinct page${s.pages.size === 1 ? "" : "s"} behind them, the addresses to re-check`,
  );
  if (s.skipped > 0)
    lines.push(`${n(s.skipped)} row${s.skipped === 1 ? "" : "s"} with no address skipped`);
  return lines.join("\n");
}
