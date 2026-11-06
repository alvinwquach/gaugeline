import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { ConfigError } from "../errors.js";
import type { Finding } from "../model.js";
import { normaliseHeader, parseCsv } from "./columns.js";
import { coverageKey } from "./coverage.js";

/**
 * What an uncovered page is worth: a Search Console pages export or a rank tracker's export,
 * joined on the same path key as --live (G19). One streamed pass builds a Map from path to Worth;
 * each uncovered page is then one lookup. Numbers only: a query column is never read.
 */
export interface Worth {
  clicks?: number;
  impressions?: number;
  position?: number;
  source: "search-console" | "rank-export";
}

export interface RankExport {
  worth: Map<string, Worth>;
  source: Worth["source"];
  /** The date range, when the export states one (a "Date range" line above the header). */
  range?: string;
  rows: number;
}

type Field = "page" | "clicks" | "impressions" | "position" | "query";

/** Header aliases, matched after normaliseHeader (G15): lower case, punctuation to spaces. */
export const RANK_COLUMNS: Readonly<Record<string, Field>> = Object.freeze({
  "top pages": "page",
  page: "page",
  pages: "page",
  "landing page": "page",
  "landing pages": "page",
  url: "page",
  address: "page",
  "ranking url": "page",
  clicks: "clicks",
  impressions: "impressions",
  position: "position",
  "avg position": "position",
  "average position": "position",
  rank: "position",
  "current rank": "position",
  "current position": "position",
  "top queries": "query",
  query: "query",
  queries: "query",
  keyword: "query",
});

/** "1,240" → 1240, "12.5%" → 12.5, "3.4" → 3.4; an empty cell or a dash → undefined. */
export function parseNumber(cell: string | undefined): number | undefined {
  const t = (cell ?? "").trim().replace(/[,\s%]/g, "");
  if (t === "" || /^[-–—]+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

const RANGE = /^\s*#?\s*(?:date range|dates|period)\s*[:,]\s*"?([^"]+?)"?\s*,*\s*$/i;

/**
 * Read a pages export as a stream. A Search Console export has Clicks or Impressions; a rank
 * export has an address and a position. The Queries tab (no address column) is a ConfigError
 * naming the export to download. The same path under two rows (http and https, www and bare) is
 * one page: clicks and impressions add up, the better position is kept.
 */
export async function readRankExport(input: Readable | string): Promise<RankExport> {
  const stream = typeof input === "string" ? Readable.from([input]) : input;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let columns: Partial<Record<Field, number>> | undefined;
  let source: Worth["source"] = "search-console";
  let range: string | undefined;
  let rows = 0;
  const worth = new Map<string, Worth>();
  // A ConfigError mid-file (the Queries tab) must still close the file: Windows can't remove an
  // open one, and a long-running caller would leak the handle.
  try {
    for await (const raw of lines) {
      const line = raw.replace(/^\uFEFF/, "");
      if (columns === undefined) {
        if (line.trim() === "") continue;
        const r = RANGE.exec(line);
        if (r?.[1]) {
          range = r[1].trim();
          continue;
        }
        const header = parseCsv(line)[0]?.cells ?? [];
        const found: Partial<Record<Field, number>> = {};
        header.forEach((h, i) => {
          const f = RANK_COLUMNS[normaliseHeader(h)];
          if (f && found[f] === undefined) found[f] = i;
        });
        if (found.page === undefined) {
          if (found.query !== undefined)
            throw new ConfigError(
              "--rank: this is a Search Console Queries export; it has no page addresses.",
              {
                hint: "In Search Console's Performance report, open the Pages tab and export that.",
              },
            );
          throw new ConfigError(`--rank: no page column. Headers: ${header.join(", ")}.`, {
            hint: "Use a Search Console Pages export, or a rank export with a URL and a Position column.",
          });
        }
        if (
          found.clicks === undefined &&
          found.impressions === undefined &&
          found.position === undefined
        )
          throw new ConfigError("--rank: no Clicks, Impressions or Position column.", {
            hint: "Use a Search Console Pages export, or a rank export with a URL and a Position column.",
          });
        source =
          found.clicks !== undefined || found.impressions !== undefined
            ? "search-console"
            : "rank-export";
        columns = found;
        continue;
      }
      const cells = parseCsv(line)[0]?.cells ?? [];
      const key = coverageKey(cells[columns.page ?? 0] ?? "");
      if (!key || (cells[columns.page ?? 0] ?? "").trim() === "") continue;
      rows++;
      const clicks = parseNumber(cells[columns.clicks ?? -1]);
      const impressions = parseNumber(cells[columns.impressions ?? -1]);
      const position = parseNumber(cells[columns.position ?? -1]);
      const had = worth.get(key);
      const best = (a?: number, b?: number) =>
        a === undefined || a <= 0 ? b : b === undefined || b <= 0 ? a : Math.min(a, b);
      const sum = (a?: number, b?: number) =>
        a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
      const next: Worth = { source };
      const c = sum(had?.clicks, clicks);
      const i = sum(had?.impressions, impressions);
      const p = best(had?.position, position);
      if (c !== undefined) next.clicks = c;
      if (i !== undefined) next.impressions = i;
      if (p !== undefined && p > 0) next.position = p;
      worth.set(key, next);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (columns === undefined) throw new ConfigError("--rank: the export is empty.");
  return { worth, source, ...(range ? { range } : {}), rows };
}

const n = (v: number) => v.toLocaleString("en-GB");

/** Clicks, then impressions, then position, then path; a page with no data last. */
export function compareWorth(
  a: { key: string; worth?: Worth },
  b: { key: string; worth?: Worth },
): number {
  const has = (w?: Worth) =>
    w !== undefined &&
    (w.clicks !== undefined || w.impressions !== undefined || w.position !== undefined);
  if (has(a.worth) !== has(b.worth)) return has(a.worth) ? -1 : 1;
  return (
    (b.worth?.clicks ?? -1) - (a.worth?.clicks ?? -1) ||
    (b.worth?.impressions ?? -1) - (a.worth?.impressions ?? -1) ||
    (a.worth?.position ?? Infinity) - (b.worth?.position ?? Infinity) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

export interface Ranked {
  findings: Finding[];
  /** "18 live pages have no row in the plan. 5 of them had clicks: 1,240 in total." */
  summary: string;
}

/**
 * The plan-uncovered-page findings, sorted by what they are worth with the numbers in the
 * evidence; every other finding as it was. `pages` counts uncovered pages (a grouped prefix
 * finding counts its pages).
 */
export function rankUncovered(
  findings: readonly Finding[],
  rank: Pick<RankExport, "worth" | "range">,
  opts: { pages?: number; file?: string } = {},
): Ranked {
  const uncovered = findings.filter(
    (f) => f.checkId === "plan-uncovered-page" && !f.group?.key.startsWith("prefix:"),
  );
  const rest = findings.filter((f) => !uncovered.includes(f));
  const scored = uncovered
    .map((f) => {
      const key = f.group?.key ?? "";
      const w = rank.worth.get(key);
      return { f, key, ...(w ? { worth: w } : {}) };
    })
    .sort(compareWorth);
  const ranked = scored.map(({ f, worth }) => {
    if (!worth) return f;
    const parts = [
      ...(worth.clicks !== undefined ? [`${n(worth.clicks)} clicks`] : []),
      ...(worth.impressions !== undefined ? [`${n(worth.impressions)} impressions`] : []),
      worth.position !== undefined ? `position ${worth.position}` : "position unknown",
      ...(rank.range ? [rank.range] : []),
    ];
    // G19's own numbers from --live are replaced: --rank wins.
    return { ...f, evidence: `${f.evidence.replace(/ \([^)]*\)$/, "")} (${parts.join(", ")})` };
  });
  const withClicks = scored.filter((s) => (s.worth?.clicks ?? 0) > 0);
  const total = withClicks.reduce((t, s) => t + (s.worth?.clicks ?? 0), 0);
  const pages = opts.pages ?? uncovered.length;
  const summary = `${n(pages)} live page${pages === 1 ? " has" : "s have"} no row in the plan. ${withClicks.length} of them had clicks: ${n(total)} in total.${opts.file ? ` Numbers from ${opts.file}${rank.range ? `, ${rank.range}` : ""}.` : ""}`;
  return { findings: [...ranked, ...rest], summary };
}

/**
 * plan-rank-unknown-address (low): pages in the export that are neither live nor planned. One
 * finding with the count and a few examples: an export of another site, or of pages already gone.
 */
export function rankUnknown(
  rank: Pick<RankExport, "worth">,
  known: (key: string) => boolean,
  file = "the rank export",
): Finding[] {
  const unknown = [...rank.worth.keys()].filter((k) => !known(k)).sort();
  if (unknown.length === 0) return [];
  return [
    {
      checkId: "plan-rank-unknown-address",
      severity: "low",
      title: "Addresses in the rank export are neither live nor planned",
      evidence: `${n(unknown.length)} address${unknown.length === 1 ? " in" : "es in"} ${file} ${unknown.length === 1 ? "is" : "are"} in neither --live nor the plan, e.g. ${unknown.slice(0, 3).join(", ")}`,
      url: file,
      group: { key: "rank-unknown", lines: [] },
    },
  ];
}
