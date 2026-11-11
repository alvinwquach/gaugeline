import { REQUEST_KINDS, type RequestKind, type RequestRow, type Result } from "../types";

/** One line of the Pages checked table. */
export interface Row {
  /** The address as requested. Shown as text, never as a link. */
  address: string;
  kind: RequestKind;
  method: "GET" | "HEAD" | "POST";
  /** On a read-only query: the id of the allowlist entry that let it through. */
  allow?: string;
  status: number | null;
  /** A short phrase built from the status: "Loaded", "Moved to <address>", "Not found" ... */
  answer: string;
  /** Where a 3xx pointed. */
  redirectedTo?: string;
  ms: number;
}

const RANK: ReadonlyMap<RequestKind, number> = new Map(REQUEST_KINDS.map((k, i) => [k, i]));

/** The phrase for one request: a status, or why there was none. */
export function answerFor(r: RequestRow): string {
  if (r.status === null)
    return r.error === "private-address-refused" ? "Not followed (private address)" : "No answer";
  const s = r.status;
  if (s >= 200 && s < 300) return "Loaded";
  if (s >= 300 && s < 400)
    return r.location ? `Moved to ${r.location}` : "Moved (no address given)";
  if (s === 404 || s === 410) return "Not found";
  if (s === 401 || s === 403 || s === 429) return `Refused (${s})`;
  if (s >= 400 && s < 500) return `Error ${s}`;
  if (s >= 500 && s < 600) return "Server error";
  return `Error ${s}`;
}

/**
 * The requests as table rows: by kind, then in the order the server gave them (which is the order
 * they were requested). A redirect is not nested under its start: each hop is a row, and each
 * "Moved to" row names where it went. The sort is stable, and the input is not changed.
 */
export function toRows(requests: readonly RequestRow[]): Row[] {
  return requests
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (RANK.get(a.r.kind) ?? 0) - (RANK.get(b.r.kind) ?? 0) || a.i - b.i)
    .map(({ r }) => ({
      address: r.url,
      kind: r.kind,
      method: r.method,
      ...(r.allow === undefined ? {} : { allow: r.allow }),
      status: r.status,
      answer: answerFor(r),
      ...(r.location !== undefined && r.status !== null && r.status >= 300 && r.status < 400
        ? { redirectedTo: r.location }
        : {}),
      ms: r.ms,
    }));
}

/** Anything that did not end in a 2xx: a redirect, an error, or no answer at all. */
export function isProblem(row: Row): boolean {
  return row.status === null || row.status < 200 || row.status >= 300;
}

/** The most rows a run can list from its sampled kinds: the page and every limit full (1+30+20+25+3+15). */
export const LIMIT_ROWS = 94;

/** The kinds the table samples, with the key `sampled` uses and the words the footer uses. */
const SAMPLES: readonly [key: string, one: string, many: string][] = [
  ["links", "same-site link", "same-site links"],
  ["images", "image", "images"],
  ["sitemapPages", "sitemap page", "sitemap pages"],
  ["feeds", "feed", "feeds"],
  ["scripts", "JavaScript file", "JavaScript files"],
];

/** "24 of up to 30 same-site links (52 found)": what was read against the published limit. Nothing for a kind with none found. */
export function footerLines(sampled: Result["sampled"]): string[] {
  const lines: string[] = [];
  for (const [key, one, many] of SAMPLES) {
    const s = sampled[key];
    if (!s || s.seen === 0) continue;
    const noun = s.limit === 1 ? one : many;
    const found = s.seen > s.taken ? ` (${s.seen} found)` : "";
    lines.push(`${s.taken} of up to ${s.limit} ${noun}${found}`);
  }
  return lines;
}
