import type { Finding } from "../model.js";
import { normaliseHeader } from "./columns.js";
import { addressKey, groupBy, textKey } from "./keys.js";
import type { PlanRow } from "./read.js";

/**
 * Pages competing for one keyword: the same Primary Keyword on two pages (cannibalisation), and
 * a page's primary that is another page's secondary (overlap, often deliberate, so lower). Exact
 * match after normalising: singular and plural are different keywords, by design.
 */

const PLACEHOLDER = /^(?:n\/?a|none|tbd|-+|—)$/i;

/** Trimmed, lower case, spaces collapsed, quotes straightened, a trailing full stop removed. */
export function keywordKey(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const k = textKey(s)
    .replace(/[.,;:!]+$/, "")
    .trim();
  if (k === "" || PLACEHOLDER.test(k) || /^[([{].*[)\]}]$/.test(k)) return undefined;
  return k;
}

/** A Secondary Keyword cell can hold several terms: commas, semicolons or line breaks. */
export function secondaryTerms(cell: string | undefined): string[] {
  return (cell ?? "")
    .split(/[,;\n]+/)
    .map((t) => keywordKey(t))
    .filter((t): t is string => t !== undefined);
}

const VOLUME_HEADERS = new Set(["primary volume", "volume", "search volume", "monthly volume"]);

/** The row's volume cell, as written, when the plan has one. */
function volumeOf(row: PlanRow): string | undefined {
  for (const [h, v] of Object.entries(row.raw))
    if (VOLUME_HEADERS.has(normaliseHeader(h)) && v.trim() !== "") return v.trim();
  return undefined;
}

function volumeNumber(v: string | undefined): number | undefined {
  if (v === undefined || !/^\s*[\d,.]+\s*$/.test(v)) return undefined;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** A page is its path: a page and its anchor rows count once. The first row stands for it. */
function pages(rows: readonly PlanRow[]): PlanRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = addressKey({ url: r.url, path: r.path });
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function lines(rows: readonly PlanRow[]): string {
  const ns = rows.map((r) => String(r.line));
  return ns.length === 1
    ? `line ${ns[0] ?? ""}`
    : `lines ${ns.slice(0, -1).join(", ")} and ${ns.at(-1) ?? ""}`;
}

interface Group {
  key: string;
  rows: PlanRow[];
  volume?: string;
  n?: number;
}

/** Numeric volumes first, highest first; then the rest in file order. */
function byVolume(a: Group, b: Group): number {
  if (a.n !== undefined && b.n !== undefined) return b.n - a.n;
  if (a.n !== undefined) return -1;
  if (b.n !== undefined) return 1;
  return 0;
}

function withVolume(key: string, rows: PlanRow[]): Group {
  const vols = rows.map(volumeOf).filter((v): v is string => v !== undefined);
  const nums = vols.map(volumeNumber).filter((n): n is number => n !== undefined);
  const n = nums.length > 0 ? Math.max(...nums) : undefined;
  const volume = n !== undefined ? vols.find((v) => volumeNumber(v) === n) : vols[0];
  return {
    key,
    rows,
    ...(volume !== undefined ? { volume } : {}),
    ...(n !== undefined ? { n } : {}),
  };
}

export function checkKeywords(rows: readonly PlanRow[], file = "the plan"): Finding[] {
  const primaryIndex = groupBy(rows, (r) => keywordKey(r.primaryKeyword));
  const secondaryIndex = new Map<string, PlanRow[]>();
  for (const r of rows)
    for (const term of new Set(secondaryTerms(r.secondaryKeyword))) {
      const list = secondaryIndex.get(term) ?? [];
      list.push(r);
      secondaryIndex.set(term, list);
    }

  const cannibal: Group[] = [];
  const overlap: { group: Group; secondary: PlanRow[] }[] = [];
  for (const [key, primaries] of primaryIndex) {
    const own = pages(primaries);
    const group = withVolume(key, own);
    if (own.length >= 2) cannibal.push(group);
    const ownPaths = new Set(own.map((r) => addressKey({ url: r.url, path: r.path })));
    const others = pages(
      (secondaryIndex.get(key) ?? []).filter(
        (r) => !ownPaths.has(addressKey({ url: r.url, path: r.path })),
      ),
    );
    if (others.length > 0 && own.length === 1) overlap.push({ group, secondary: others });
  }
  const vol = (g: Group) => (g.volume !== undefined ? ` (volume ${g.volume})` : "");
  return [
    ...[...cannibal].sort(byVolume).map((g): Finding => ({
      checkId: "plan-keyword-cannibalisation",
      severity: "medium",
      title: "Two pages in the plan target the same primary keyword",
      evidence: `"${g.key}"${vol(g)} is the primary keyword of ${g.rows.length} pages`,
      url: file,
      group: { key: g.key, lines: g.rows.map((r) => r.line) },
    })),
    ...[...overlap]
      .sort((a, b) => byVolume(a.group, b.group))
      .map(({ group, secondary }): Finding => ({
        checkId: "plan-keyword-overlap",
        severity: "low",
        title: "One page's primary keyword is another page's secondary",
        evidence: `"${group.key}"${vol(group)} is the primary for ${lines(group.rows)} and a secondary for ${lines(secondary)}`,
        url: file,
        group: {
          key: group.key,
          lines: [...group.rows, ...secondary].map((r) => r.line).sort((a, b) => a - b),
        },
      })),
  ];
}
