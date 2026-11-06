import type { PlanRow } from "./read.js";

/**
 * What counts as "the same" in a plan, in two small functions every grouping rule shares.
 */

/** Host (lower case, without www.) and path (lower case, no trailing slash, no query), then #fragment. */
export function addressKey(row: Pick<PlanRow, "url" | "path" | "fragment">): string {
  let host = "";
  try {
    host = new URL(row.url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    host = "";
  }
  let path = row.path.split("?")[0]?.toLowerCase() ?? "";
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (path === "") path = "/";
  return `${host}${path}${row.fragment ? `#${row.fragment.toLowerCase()}` : ""}`;
}

/** Trimmed, whitespace collapsed, lower case, curly quotes and dashes straightened. */
export function textKey(s: string): string {
  return s
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Items by key, groups in first-seen order and file order inside each; undefined keys left out. */
export function groupBy<T>(
  items: readonly T[],
  key: (t: T) => string | undefined,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === undefined) continue;
    const group = out.get(k);
    if (group) group.push(item);
    else out.set(k, [item]);
  }
  return out;
}
