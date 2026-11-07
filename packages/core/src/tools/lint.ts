/**
 * The free tools' checks that run in the browser: a redirect list (from, to) and a launch plan
 * (old address, new address, title). No imports and no requests: what is pasted or uploaded is
 * read here and never leaves the page.
 */
export interface ListRow {
  /** The line it was on, from 1, header included. */
  line: number;
  from: string;
  to: string;
}

export interface PlanToolRow {
  line: number;
  old: string;
  new: string;
  title: string;
}

export type RedirectRule = "duplicate" | "chain" | "self" | "mixed-slash";
export type PlanRule = "no-destination" | "shared-title";

export interface Issue<R extends string> {
  rule: R;
  /** The lines it is about. */
  lines: number[];
  message: string;
}

/** The input isn't a list this tool can read: the message says what shape it needs. */
export class ShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShapeError";
  }
}

/** The live check takes this many rows; everything is linted. */
export const LIVE_LIMIT = 25;

/** Cells of one line: tab first (a spreadsheet paste), else CSV with quotes, else an arrow or spaces. */
export function splitLine(line: string): string[] {
  if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
  if (line.includes(",")) {
    const out: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"' && cell.trim() === "") quoted = true;
      else if (c === ",") {
        out.push(cell.trim());
        cell = "";
      } else cell += c;
    }
    out.push(cell.trim());
    return out;
  }
  return line
    .split(/\s*(?:→|->|=>)\s*|\s+/)
    .map((c) => c.trim())
    .filter((c) => c !== "");
}

const norm = (h: string) =>
  h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const looksLikeAddress = (s: string) => /^(?:https?:\/\/|\/)/i.test(s.trim());

function lines(text: string): { line: number; cells: string[] }[] {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\n|\r/)
    .map((l, i) => ({ line: i + 1, cells: splitLine(l) }))
    .filter((r) => r.cells.some((c) => c !== ""));
}

const FROM = new Set([
  "from",
  "old",
  "old url",
  "old address",
  "source",
  "redirect from",
  "legacy url",
]);
const TO = new Set([
  "to",
  "new",
  "new url",
  "new address",
  "target",
  "destination",
  "redirect to",
  "url",
]);

/** A from/to list, with or without a header row. */
export function parseRedirectList(text: string): ListRow[] {
  const rows = lines(text);
  if (rows.length === 0)
    throw new ShapeError(
      "The list is empty: paste one redirect per line, the old address then the new one.",
    );
  let from = 0;
  let to = 1;
  let body = rows;
  const head = rows[0]?.cells ?? [];
  if (!head.some(looksLikeAddress)) {
    const names = head.map(norm);
    const f = names.findIndex((n) => FROM.has(n));
    const t = names.findIndex((n) => TO.has(n));
    if (f < 0 || t < 0 || f === t)
      throw new ShapeError(
        `The first line ("${head.join(", ")}") isn't a redirect or a header the tool knows. Put the old address first and the new one second, one redirect per line (/old-page,/new-page), or name the columns From and To.`,
      );
    from = f;
    to = t;
    body = rows.slice(1);
  }
  const out: ListRow[] = [];
  for (const r of body) {
    const a = r.cells[from] ?? "";
    const b = r.cells[to] ?? "";
    if (a === "" && b === "") continue;
    if (!looksLikeAddress(a) || !looksLikeAddress(b))
      throw new ShapeError(
        `Line ${r.line} isn't a redirect: each line needs an old address and a new one, each starting with / or https:// ("${r.cells.join(", ")}").`,
      );
    out.push({ line: r.line, from: a, to: b });
  }
  if (out.length === 0) throw new ShapeError("The list has a header but no redirects under it.");
  return out;
}

/** The key two addresses are compared on: host (when given) and path, no trailing slash or fragment. */
export function addressKey(address: string): string {
  try {
    const u = new URL(address, "https://list.invalid");
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    const host =
      u.hostname === "list.invalid" ? "" : u.hostname.toLowerCase().replace(/^www\./, "");
    return `${host}${path}${u.search}`;
  } catch {
    return address.trim();
  }
}
/** Same, without the host: a relative and an absolute address on the list's own site match. */
const pathKey = (address: string) => addressKey(address).replace(/^[^/]*/, "");
/** Exactly the address, trailing slash kept: /kids/ to /kids is a redirect, not a loop. */
const exactKey = (address: string) => {
  try {
    const u = new URL(address, "https://list.invalid");
    return `${u.pathname}${u.search}`;
  } catch {
    return address.trim();
  }
};

/** Duplicates, chains within the list, a row pointing at itself, and mixed trailing slashes. */
export function lintRedirects(rows: readonly ListRow[]): Issue<RedirectRule>[] {
  const out: Issue<RedirectRule>[] = [];
  const byFrom = new Map<string, ListRow[]>();
  for (const r of rows) byFrom.set(pathKey(r.from), [...(byFrom.get(pathKey(r.from)) ?? []), r]);
  for (const [, same] of byFrom) {
    if (same.length < 2) continue;
    const targets = new Set(same.map((r) => pathKey(r.to)));
    out.push({
      rule: "duplicate",
      lines: same.map((r) => r.line),
      message:
        targets.size > 1
          ? `${same[0]?.from} is listed ${same.length} times with different destinations (lines ${same.map((r) => r.line).join(", ")}): a server uses only one of them`
          : `${same[0]?.from} is listed ${same.length} times (lines ${same.map((r) => r.line).join(", ")})`,
    });
  }
  for (const r of rows) {
    if (exactKey(r.from) === exactKey(r.to)) {
      out.push({
        rule: "self",
        lines: [r.line],
        message: `Line ${r.line}: ${r.from} redirects to itself (${r.to}): a loop for every visitor`,
      });
      continue;
    }
    if (pathKey(r.from) === pathKey(r.to)) continue;
    const next = byFrom.get(pathKey(r.to))?.find((n) => exactKey(n.to) !== exactKey(n.from));
    if (next)
      out.push({
        rule: "chain",
        lines: [r.line, next.line],
        message: `Line ${r.line}: ${r.from} → ${r.to}, which line ${next.line} redirects again to ${next.to}: point ${r.from} straight at ${next.to}`,
      });
  }
  const paths = rows
    .flatMap((r) => [r.from, r.to])
    .map((a) => {
      try {
        return new URL(a, "https://list.invalid").pathname;
      } catch {
        return a;
      }
    })
    .filter((p) => p !== "/" && !/\.[a-z0-9]{1,5}$/i.test(p));
  const slash = paths.filter((p) => p.endsWith("/")).length;
  if (slash > 0 && slash < paths.length)
    out.push({
      rule: "mixed-slash",
      lines: rows.filter((r) => [r.from, r.to].some((a) => a.endsWith("/"))).map((r) => r.line),
      message: `${slash} of ${paths.length} addresses end with a slash and the rest don't: pick one form, or each one costs an extra redirect on a server that adds or removes it`,
    });
  return out.sort((a, b) => (a.lines[0] ?? 0) - (b.lines[0] ?? 0));
}

const OLD = new Set([
  "old",
  "old url",
  "old address",
  "legacy url",
  "legacy address",
  "current url",
  "from",
]);
const NEW = new Set(["new", "new url", "new address", "url", "destination", "to", "page url"]);
const TITLE = new Set(["title", "title tag", "page title", "meta title"]);

/** A launch plan: old address, new address and title, found by their headers. */
export function parsePlanSheet(text: string): PlanToolRow[] {
  const rows = lines(text);
  const names = (rows[0]?.cells ?? []).map(norm);
  const o = names.findIndex((n) => OLD.has(n));
  const w = names.findIndex((n) => NEW.has(n));
  const t = names.findIndex((n) => TITLE.has(n));
  if (o < 0 || w < 0 || t < 0)
    throw new ShapeError(
      `The first line needs three column names: the old address (Old URL), the new address (New URL) and the title (Title). It has ${rows[0] ? `"${rows[0].cells.join('", "')}"` : "nothing"}.`,
    );
  return rows.slice(1).map((r) => ({
    line: r.line,
    old: r.cells[o] ?? "",
    new: r.cells[w] ?? "",
    title: r.cells[t] ?? "",
  }));
}

/** Old addresses with no destination, and two rows that share one title. */
export function lintPlan(rows: readonly PlanToolRow[]): Issue<PlanRule>[] {
  const out: Issue<PlanRule>[] = [];
  for (const r of rows)
    if (r.old.trim() !== "" && r.new.trim() === "")
      out.push({
        rule: "no-destination",
        lines: [r.line],
        message: `Line ${r.line}: ${r.old} has no new address: after launch it answers 404`,
      });
  const byTitle = new Map<string, PlanToolRow[]>();
  for (const r of rows) {
    const k = r.title.trim().toLowerCase().replace(/\s+/g, " ");
    if (k !== "") byTitle.set(k, [...(byTitle.get(k) ?? []), r]);
  }
  for (const same of byTitle.values())
    if (same.length > 1)
      out.push({
        rule: "shared-title",
        lines: same.map((r) => r.line),
        message: `Lines ${same.map((r) => r.line).join(", ")} share the title "${same[0]?.title.trim()}": search results can't tell the pages apart`,
      });
  return out.sort((a, b) => (a.lines[0] ?? 0) - (b.lines[0] ?? 0));
}

/** The command that runs the full check locally, ending every result. */
export const REDIRECT_COMMAND =
  "npx gaugeline plan redirects.csv --base https://www.yoursite.com   (columns: Redirect from, Destination)";
export const PLAN_COMMAND = "npx gaugeline plan plan.csv --plan-only";
