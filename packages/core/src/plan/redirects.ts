import { ConfigError, NetworkError } from "../errors.js";
import { FetchError, type Fetcher, type Hop } from "../fetcher.js";
import { SEVERITY_ORDER, type Finding } from "../model.js";
import { addressKey } from "./keys.js";
import type { PlanRow } from "./read.js";

/**
 * The 301 map: each legacy address on a plan row, requested on --base, and its trail of hops read
 * for three facts: one hop, a permanent status, the right destination. The fetcher already records
 * every hop, so this is a classifier over data that exists.
 */
export const REDIRECT_CHECK_IDS = [
  "plan-redirect-missing",
  "plan-redirect-not-301",
  "plan-redirect-wrong-destination",
  "plan-redirect-chain",
  "plan-redirect-drops-query",
] as const;
export type RedirectCheckId = (typeof REDIRECT_CHECK_IDS)[number] | "plan-redirect-conflict";

export const REDIRECT_TITLES: Readonly<Record<RedirectCheckId, string>> = {
  "plan-redirect-missing": "An old address doesn't redirect",
  "plan-redirect-not-301": "An old address redirects with a temporary status",
  "plan-redirect-wrong-destination": "An old address redirects somewhere the plan doesn't say",
  "plan-redirect-chain": "An old address takes more than one redirect",
  "plan-redirect-drops-query": "A redirect drops the old address's query string",
  "plan-redirect-conflict": "One old address is claimed by two rows",
};

const SEVERITY: Readonly<Record<RedirectCheckId, Finding["severity"]>> = {
  "plan-redirect-missing": "high",
  "plan-redirect-not-301": "high",
  "plan-redirect-wrong-destination": "high",
  "plan-redirect-chain": "medium",
  "plan-redirect-drops-query": "low",
  "plan-redirect-conflict": "high",
};

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/** A Legacy URL cell may hold several addresses, one per line or separated by commas. */
export function splitLegacy(cell: string | undefined): string[] {
  if (!cell) return [];
  return cell
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** A legacy address as path + query: absolute ones keep only their path, since it moves onto --base. */
export function legacyPath(address: string): { path: string; search: string } | undefined {
  try {
    const u = new URL(address, "https://plan.invalid");
    return { path: u.pathname, search: u.search };
  } catch {
    return undefined;
  }
}

const norm = (path: string) => {
  let p = path.toLowerCase();
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p === "" ? "/" : p;
};
const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");

export interface RedirectVerdict {
  /** The check ids this trail fails, in the order above. */
  ids: RedirectCheckId[];
  /** One sentence per id, the evidence. */
  evidence: Partial<Record<RedirectCheckId, string>>;
  /** Accepted, but worth saying (a 308). */
  note?: string;
}

/** Where the trail ends: the last hop's own address, or where its Location points when it stopped there. */
function finalAddress(hops: readonly Hop[]): URL | undefined {
  const last = hops.at(-1);
  if (!last) return undefined;
  const location = REDIRECT.has(last.status) ? last.headers.location : undefined;
  try {
    return new URL(location ?? last.url, last.url);
  } catch {
    return undefined;
  }
}

const shown = (u: URL, base: URL) =>
  u.host === base.host ? `${u.pathname}${u.search}` : `${u.host}${u.pathname}${u.search}`;

/**
 * Read one legacy address's trail. `expected` is the row's planned URL (production), `base` the
 * preview the legacy address was requested on; the destination is right when its path is the
 * row's and its host is the preview's or exactly the plan's.
 */
export function classify(
  hops: readonly Hop[],
  expected: Pick<PlanRow, "url" | "path">,
  legacy: string,
  base: string,
  opts: { skipDestination?: boolean } = {},
): RedirectVerdict {
  const out: RedirectVerdict = { ids: [], evidence: {} };
  const add = (id: RedirectCheckId, text: string) => {
    out.ids.push(id);
    out.evidence[id] = text;
  };
  const baseUrl = new URL(base);
  const first = hops[0];
  if (!first) return out;
  if (!REDIRECT.has(first.status)) {
    const body = first.body ?? "";
    const meta = /<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(body);
    const script =
      /(?:window\.|document\.)?location(?:\.href)?\s*=|location\.(?:replace|assign)\s*\(/i.test(
        body.replace(/<!--[\s\S]*?-->/g, ""),
      );
    add(
      "plan-redirect-missing",
      first.status === 200 && (meta || script)
        ? `${legacy} returns 200 and redirects with ${meta ? "a meta refresh" : "JavaScript"}: that isn't a 301, and search engines may not pass its ranking on`
        : first.status === 404 || first.status === 410
          ? `${legacy} returns ${first.status}: nothing redirects it`
          : `${legacy} still returns ${first.status}: it doesn't redirect`,
    );
    return out;
  }
  const end = finalAddress(hops);
  const redirects = hops.filter((h) => REDIRECT.has(h.status)).length;
  let planHost = "";
  try {
    planHost = new URL(expected.url).host.toLowerCase();
  } catch {
    planHost = "";
  }
  const pathRight = end !== undefined && norm(end.pathname) === norm(expected.path);
  const hostRight =
    end !== undefined && (end.host === baseUrl.host || end.host.toLowerCase() === planHost);
  const right = pathRight && hostRight;

  if (!opts.skipDestination && end && !right)
    add(
      "plan-redirect-wrong-destination",
      pathRight && bare(end.host) === bare(planHost)
        ? `${legacy} redirects to the right path on ${end.host}, the plan says ${planHost}: one more redirect for every visitor`
        : `${legacy} redirects to ${shown(end, baseUrl)}, the plan says ${expected.path}`,
    );

  if (first.status === 302 || first.status === 303 || first.status === 307)
    add("plan-redirect-not-301", `${legacy} redirects with ${first.status}, not 301`);
  else if (first.status === 308 && !right && !opts.skipDestination)
    add(
      "plan-redirect-not-301",
      `${legacy} redirects with 308 to the wrong place: permanent, so browsers keep the wrong address`,
    );
  else if (first.status === 308)
    out.note = `${legacy} redirects with 308 (permanent, keeps the method): accepted like a 301`;

  if (redirects > 1) {
    const trail = [new URL(first.url), ...hops.slice(1).map((h) => new URL(h.url))];
    if (end && end.href !== trail.at(-1)?.href) trail.push(end);
    const second = hops[1] ? new URL(hops[1].url) : undefined;
    const slashOnly =
      second !== undefined &&
      second.pathname === `${new URL(first.url).pathname}/` &&
      second.host === new URL(first.url).host;
    add(
      "plan-redirect-chain",
      `${legacy} takes ${redirects} redirects: ${trail.map((u) => shown(u, baseUrl)).join(" → ")}${slashOnly ? " (the server adds a trailing slash first, then redirects again: point the old address's own form at the destination)" : ""}`,
    );
  }

  const asked = new URL(first.url);
  if (asked.search !== "" && end && end.search === "")
    add(
      "plan-redirect-drops-query",
      `${legacy} redirects to ${shown(end, baseUrl)} without its query string ${asked.search}`,
    );
  return out;
}

export interface RedirectOptions {
  base: string;
  fetcher: Fetcher;
  file?: string;
  onProgress?: (done: number, total: number) => void;
}

export interface RedirectResult {
  findings: Finding[];
  /** Accepted trails worth a line (a 308). */
  notes: string[];
  /** Legacy addresses requested. */
  checked: number;
}

/** One legacy address, by path and query (lower case, no trailing slash), with every row claiming it. */
export function legacyClaims(
  rows: readonly PlanRow[],
): Map<string, { legacy: string; rows: PlanRow[] }> {
  const out = new Map<string, { legacy: string; rows: PlanRow[] }>();
  for (const row of rows)
    for (const legacy of splitLegacy(row.legacyUrl)) {
      const p = legacyPath(legacy);
      if (!p) continue;
      const key = `${norm(p.path)}${p.search}`;
      const claim = out.get(key);
      if (claim) {
        if (!claim.rows.includes(row)) claim.rows.push(row);
      } else out.set(key, { legacy, rows: [row] });
    }
  return out;
}

/**
 * plan-redirect-conflict: one old address claimed by rows that plan different pages. It can only
 * redirect to one of them; no request shows that, so it runs without --base.
 */
export function redirectConflicts(rows: readonly PlanRow[], file = "the plan"): Finding[] {
  const out: Finding[] = [];
  for (const [key, claim] of legacyClaims(rows)) {
    const targets = new Set(claim.rows.map((r) => addressKey({ url: r.url, path: r.path })));
    if (targets.size < 2) continue;
    out.push({
      checkId: "plan-redirect-conflict",
      severity: SEVERITY["plan-redirect-conflict"],
      title: REDIRECT_TITLES["plan-redirect-conflict"],
      evidence: `${claim.legacy} is the legacy address of ${claim.rows.length} rows: ${claim.rows.map((r) => r.path).join(", ")}`,
      url: file,
      group: { key, lines: claim.rows.map((r) => r.line) },
    });
  }
  return out;
}

/**
 * Request every legacy address once on --base (GET, through the fetcher) and classify its trail
 * against the row that claims it. A legacy address that is the row's own address needs no redirect
 * and isn't requested.
 */
export async function checkRedirects(
  rows: readonly PlanRow[],
  opts: RedirectOptions,
): Promise<RedirectResult> {
  const file = opts.file ?? "the plan";
  let origin: string;
  try {
    origin = new URL(opts.base).origin;
  } catch {
    throw new ConfigError(`--base: "${opts.base}" is not an address.`);
  }
  const claims = [...legacyClaims(rows)].filter(
    ([, c]) => !c.rows.every((r) => norm(legacyPath(c.legacy)?.path ?? "") === norm(r.path)),
  );
  const findings: Finding[] = [];
  const notes: string[] = [];
  let done = 0;
  for (const [key, claim] of claims) {
    const p = legacyPath(claim.legacy);
    if (!p) continue;
    const url = new URL(`${p.path}${p.search}`, origin).href;
    let hops: Hop[];
    try {
      hops = await opts.fetcher.get(url);
    } catch (err) {
      // A trail that leaves the preview (to production, a loop, too many hops): what was read.
      if (err instanceof FetchError && err.hops.length > 0) hops = err.hops;
      else if (err instanceof NetworkError)
        throw new ConfigError(`The preview at ${origin} could not be reached: ${err.message}`);
      else throw err;
    }
    done++;
    opts.onProgress?.(done, claims.length);
    const row = claim.rows[0];
    if (!row) continue;
    const shown = `${p.path}${p.search}`;
    // Claimed by rows planning different pages: that's plan-redirect-conflict, not a wrong destination.
    const conflict =
      new Set(claim.rows.map((r) => addressKey({ url: r.url, path: r.path }))).size > 1;
    const verdict = classify(hops, row, shown, origin, { skipDestination: conflict });
    if (verdict.note) notes.push(verdict.note);
    for (const id of verdict.ids)
      findings.push({
        checkId: id,
        severity: SEVERITY[id],
        title: REDIRECT_TITLES[id],
        evidence: verdict.evidence[id] ?? "",
        url: file,
        group: { key, lines: claim.rows.map((r) => r.line) },
      });
  }
  const first = (f: Finding) => f.group?.lines[0] ?? 0;
  return {
    findings: findings.sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || first(a) - first(b),
    ),
    notes,
    checked: done,
  };
}
