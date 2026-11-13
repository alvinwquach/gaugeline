import { ConfigError, NetworkError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import { SEVERITY_ORDER, type Finding } from "../model.js";
import { protectionMessage, protectionOf, type PreviewAuth } from "../fetch/preview-auth.js";
import { buildSnapshot, type PageSnapshot } from "../snapshot.js";
import { addressKey, groupBy, textKey } from "./keys.js";
import type { PlanRow } from "./read.js";
import { legacyPath, splitLegacy } from "./redirects.js";

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
  "plan-moved-not-indexable",
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
  "plan-moved-not-indexable": "A moved page is set not to be indexed",
};

const NOINDEX = /(^|[\s,:])(noindex|none)(\s*(,|$)|$)/i;

const trimPath = (path: string) => {
  const p = path.toLowerCase().replace(/\/+$/, "");
  return p === "" ? "/" : p;
};

/** The first old address of these rows whose path is not the page's own: the page has moved. */
function movedFrom(rows: readonly PlanRow[]): { legacy: string; lines: number[] } | undefined {
  const lines: number[] = [];
  let legacy: string | undefined;
  for (const r of rows)
    for (const l of splitLegacy(r.legacyUrl)) {
      const p = legacyPath(l);
      if (!p || trimPath(p.path) === trimPath(r.path)) continue;
      legacy ??= p.path;
      if (!lines.includes(r.line)) lines.push(r.line);
    }
  return legacy === undefined ? undefined : { legacy, lines };
}

/** Why a page can't be indexed: what it sends (a robots meta tag, an X-Robots-Tag header). */
function indexability(
  hop: { headers: Record<string, string> } | undefined,
  page: PageSnapshot,
): string[] {
  const why: string[] = [];
  if (page.metaRobots && NOINDEX.test(page.metaRobots))
    why.push(`says noindex in <meta name="robots" content="${page.metaRobots}">`);
  const header = hop?.headers["x-robots-tag"];
  if (header && NOINDEX.test(header))
    why.push(`says noindex in the X-Robots-Tag header (${header})`);
  return why;
}

/** Said when every page read is set not to be indexed: that is the preview's switch, not a moved page's. */
export const HIDDEN_PREVIEW_REASON =
  "every page read on the preview is set not to be indexed, so a moved page's own setting can't be told from the preview's: run the plan again against the live site after launch";

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
  /** The preview's protection secret, when one is set: named in a message, never shown. */
  auth?: Pick<PreviewAuth, "describe">;
  /** Called after each page is read. */
  onProgress?: (done: number, total: number) => void;
}

/** A planned page that couldn't be read: the rows on it are neither checked nor passed. */
export interface BuiltCouldNotCheck {
  url: string;
  reason: string;
  lines: number[];
}

export interface BuiltResult {
  findings: Finding[];
  couldNotCheck: BuiltCouldNotCheck[];
}

async function read(fetcher: Fetcher, url: string, origin: string) {
  try {
    return await fetcher.get(url);
  } catch (err) {
    if (err instanceof NetworkError)
      throw new ConfigError(`The preview at ${origin} could not be reached: ${err.message}`);
    throw err;
  }
}

/**
 * Probe the base once, then fetch each planned path on the preview once and compare its rows. A
 * locked preview (401, 403 or a protection page on the probe) is a ConfigError: it can't be checked,
 * and fifty findings would be wrong. A single locked page after a good probe is could-not-check.
 */
export async function checkBuilt(
  rows: readonly PlanRow[],
  opts: BuiltOptions,
): Promise<BuiltResult> {
  const file = opts.file ?? "the plan";
  let origin: string;
  try {
    origin = new URL(opts.base).origin;
  } catch {
    throw new ConfigError(`--base: "${opts.base}" is not an address.`, {
      hint: "Give the preview's address, for example https://preview.yoursite.com.",
    });
  }
  const locked = protectionOf((await read(opts.fetcher, `${origin}/`, origin)).at(-1));
  if (locked) throw protectionMessage(locked, origin, opts.auth);

  const groups = [...groupBy(rows, (r) => addressKey({ url: r.path, path: r.path })).values()];
  const out: Finding[] = [];
  const couldNotCheck: BuiltCouldNotCheck[] = [];
  let done = 0;
  /** Every page that was read, with why it can't be indexed: the moved ones are judged after the loop. */
  const states: { path: string; url: string; group: readonly PlanRow[]; why: string[] }[] = [];
  for (const group of groups) {
    const path = group[0]?.path ?? "/";
    const url = new URL(path, origin).href;
    const hops = await read(opts.fetcher, url, origin);
    const last = hops.at(-1);
    done++;
    opts.onProgress?.(done, groups.length);
    const p = protectionOf(last);
    if (p) {
      couldNotCheck.push({
        url,
        reason:
          p.kind === "password"
            ? `asked for a password (${p.status})`
            : `refused the request (${p.status})`,
        lines: group.map((r) => r.line),
      });
      continue;
    }
    // A server error says nothing about the page: could not check, never title or H1 drift.
    if (last && last.status >= 500) {
      couldNotCheck.push({
        url,
        reason: `answered ${last.status}`,
        lines: group.map((r) => r.line),
      });
      continue;
    }
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
    const snapshot = buildSnapshot(hops);
    out.push(...compare(snapshot, group, origin, file));
    states.push({ path, url, group, why: indexability(last, snapshot) });
  }
  // A moved page set not to be indexed is a finding. When every page read is set that way (two or
  // more), it is the preview's own switch and says nothing about the moved page: could not check.
  const hidden = states.length >= 2 && states.every((st) => st.why.length > 0);
  for (const st of states) {
    const moved = movedFrom(st.group);
    if (!moved || st.why.length === 0) continue;
    if (hidden) {
      couldNotCheck.push({ url: st.url, reason: HIDDEN_PREVIEW_REASON, lines: moved.lines });
      continue;
    }
    out.push(
      finding(
        "plan-moved-not-indexable",
        "high",
        BUILT_TITLES["plan-moved-not-indexable"],
        st.path,
        st.group.filter((r) => moved.lines.includes(r.line)),
        `${st.path} (moved from ${moved.legacy}) ${st.why.join("; and ")}`,
        file,
      ),
    );
  }
  const first = (f: Finding) => f.group?.lines[0] ?? 0;
  return {
    findings: out.sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || first(a) - first(b),
    ),
    couldNotCheck,
  };
}
