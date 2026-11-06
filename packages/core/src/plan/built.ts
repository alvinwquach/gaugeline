import { ConfigError, NetworkError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import { SEVERITY_ORDER, type Finding } from "../model.js";
import { classifyHop } from "../refusal.js";
import { buildSnapshot, type PageSnapshot } from "../snapshot.js";
import { addressKey, groupBy, textKey } from "./keys.js";
import type { PlanRow } from "./read.js";

/**
 * The built site against the plan: each planned path on --base (a preview), fetched once with GET,
 * and every row on that path compared with what the page sends: 404, title, H1, canonical, anchor.
 */
export const BUILT_CHECK_IDS = [
  "plan-404",
  "plan-title-drift",
  "plan-h1-drift",
  "plan-canonical-elsewhere",
  "plan-anchor-missing",
] as const;

function lower(url: string): { host: string; path: string } | undefined {
  try {
    const u = new URL(url);
    let path = u.pathname.toLowerCase();
    if (path.length > 1) path = path.replace(/\/+$/, "");
    return { host: u.hostname.toLowerCase().replace(/^www\./, ""), path };
  } catch {
    return undefined;
  }
}

/**
 * A canonical is this page when it names the row's own path on a host that is this site: the
 * preview's, or the plan's production host (with or without www). On a preview the canonical
 * should already name production, so the preview host is mapped back before comparing.
 */
export function canonicalIsThisPage(
  canonical: string,
  row: Pick<PlanRow, "url" | "path">,
  base: string,
): boolean {
  const c = lower(canonical);
  if (!c) return false;
  const want =
    row.path.length > 1 ? row.path.toLowerCase().replace(/\/+$/, "") : row.path.toLowerCase();
  const hosts = new Set<string>();
  const b = lower(base);
  if (b) hosts.add(b.host);
  const p = lower(row.url);
  if (p) hosts.add(p.host);
  return c.path === want && (hosts.has(c.host) || hosts.size === 0);
}

function finding(
  id: (typeof BUILT_CHECK_IDS)[number],
  severity: Finding["severity"],
  title: string,
  key: string,
  rows: readonly PlanRow[],
  evidence: string,
  file: string,
): Finding {
  return {
    checkId: id,
    severity,
    title,
    evidence,
    url: file,
    group: { key, lines: rows.map((r) => r.line) },
  };
}

export const BUILT_TITLES: Readonly<Record<(typeof BUILT_CHECK_IDS)[number], string>> = {
  "plan-404": "A planned page doesn't exist on the preview",
  "plan-title-drift": "A title tag isn't what the plan says",
  "plan-h1-drift": "An H1 isn't what the plan says",
  "plan-canonical-elsewhere": "A canonical points somewhere other than the planned page",
  "plan-anchor-missing": "A planned #section isn't on the page",
};

/** Every row on one fetched page, compared with it. */
function compare(
  page: PageSnapshot,
  rows: readonly PlanRow[],
  base: string,
  file: string,
): Finding[] {
  const out: Finding[] = [];
  const path = rows[0]?.path ?? "/";
  const pageRow = rows.find((r) => !r.fragment) ?? rows[0];
  if (pageRow?.titleTag && textKey(pageRow.titleTag) !== textKey(page.title ?? "")) {
    out.push(
      finding(
        "plan-title-drift",
        "medium",
        BUILT_TITLES["plan-title-drift"],
        path,
        [pageRow],
        page.title
          ? `${path}: the plan says "${pageRow.titleTag}", the page says "${page.title}"`
          : `${path}: the plan says "${pageRow.titleTag}", the page sends no title tag (it may be set by JavaScript, which this read doesn't run)`,
        file,
      ),
    );
  }
  const h1s = page.headings.filter((h) => h.level === 1).map((h) => h.text);
  if (pageRow?.h1 && textKey(pageRow.h1) !== textKey(h1s[0] ?? "")) {
    const note = h1s.length > 1 ? ` (the page has ${h1s.length} H1s; the first was compared)` : "";
    out.push(
      finding(
        "plan-h1-drift",
        "medium",
        BUILT_TITLES["plan-h1-drift"],
        path,
        [pageRow],
        h1s[0] !== undefined
          ? `${path}: the plan says "${pageRow.h1}", the page says "${h1s[0]}"${note}`
          : `${path}: the plan says "${pageRow.h1}", the page has no H1 in the HTML it sends`,
        file,
      ),
    );
  }
  if (pageRow && page.canonical && !canonicalIsThisPage(page.canonical, pageRow, base)) {
    out.push(
      finding(
        "plan-canonical-elsewhere",
        "high",
        BUILT_TITLES["plan-canonical-elsewhere"],
        path,
        [pageRow],
        `${path}: the canonical is ${page.canonical}`,
        file,
      ),
    );
  }
  for (const r of rows) {
    if (!r.fragment || page.ids.has(r.fragment)) continue;
    out.push(
      finding(
        "plan-anchor-missing",
        "medium",
        BUILT_TITLES["plan-anchor-missing"],
        `${path}#${r.fragment}`,
        [r],
        `${path}#${r.fragment}: no element has id="${r.fragment}"`,
        file,
      ),
    );
  }
  return out;
}

export interface BuiltOptions {
  /** The preview's origin, e.g. https://preview.yoursite.example. */
  base: string;
  fetcher: Fetcher;
  file?: string;
  /** Called after each page is read. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Fetch each planned path on the preview once and compare its rows. A preview that asks for a login
 * (401 or 403) is a ConfigError: it can't be checked, and fifty findings would be wrong.
 */
export async function checkBuilt(rows: readonly PlanRow[], opts: BuiltOptions): Promise<Finding[]> {
  const file = opts.file ?? "the plan";
  let origin: string;
  try {
    origin = new URL(opts.base).origin;
  } catch {
    throw new ConfigError(`--base: "${opts.base}" is not an address.`, {
      hint: "Give the preview's address, for example https://preview.yoursite.com.",
    });
  }
  const groups = [...groupBy(rows, (r) => addressKey({ url: r.path, path: r.path })).values()];
  const out: Finding[] = [];
  let done = 0;
  for (const group of groups) {
    const path = group[0]?.path ?? "/";
    const url = new URL(path, origin).href;
    let hops;
    try {
      hops = await opts.fetcher.get(url);
    } catch (err) {
      if (err instanceof NetworkError)
        throw new ConfigError(`The preview at ${origin} could not be reached: ${err.message}`);
      throw err;
    }
    const last = hops.at(-1);
    const outcome = classifyHop(last);
    if (outcome.kind === "refused" && (last?.status === 401 || last?.status === 403))
      throw new ConfigError(
        `The preview at ${origin} asked for a login (${last.status}): it is protected, so the plan can't be checked against it.`,
        {
          hint: "Check a preview that is open to read, or one you can reach with its protection bypass.",
        },
      );
    done++;
    opts.onProgress?.(done, groups.length);
    if (last?.status === 404 || last?.status === 410) {
      out.push(
        finding(
          "plan-404",
          "high",
          BUILT_TITLES["plan-404"],
          path,
          group,
          `${path} returned ${last.status} on the preview`,
          file,
        ),
      );
      continue;
    }
    out.push(...compare(buildSnapshot(hops), group, origin, file));
  }
  const first = (f: Finding) => f.group?.lines[0] ?? 0;
  return out.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || first(a) - first(b),
  );
}
