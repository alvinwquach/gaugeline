import { FetchError, type Fetcher, type Hop } from "../fetcher.js";
import { SEVERITY_ORDER, type Finding } from "../model.js";
import type { PrintedRow } from "./register.js";

/**
 * Every printed address, requested as printed (GET, through the fetcher), its trail of hops read:
 * a QR code on a table tent can't be reprinted when a restructure moves its page.
 */
export const PRINTED_CHECK_IDS = [
  "printed-dead",
  "printed-wrong-destination",
  "printed-to-home",
  "printed-tags-lost",
  "printed-chain",
] as const;
export type PrintedCheckId = (typeof PRINTED_CHECK_IDS)[number];

export const PRINTED_TITLES: Readonly<Record<PrintedCheckId, string>> = {
  "printed-dead": "A printed address doesn't land on a page",
  "printed-wrong-destination": "A printed address lands somewhere it shouldn't",
  "printed-to-home": "A printed link to a page now lands on the home page",
  "printed-tags-lost": "A printed address loses its tracking tags",
  "printed-chain": "A printed address takes more than two redirects",
};

const SEVERITY: Readonly<Record<PrintedCheckId, Finding["severity"]>> = {
  "printed-dead": "high",
  "printed-wrong-destination": "high",
  "printed-to-home": "medium",
  "printed-tags-lost": "medium",
  "printed-chain": "low",
};

const REDIRECT = new Set([301, 302, 303, 307, 308]);
/** Query parameters a printed address carries for counting scans: utm_ by default. */
export const DEFAULT_TAG_PREFIXES: readonly string[] = Object.freeze(["utm_"]);

const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");
const norm = (path: string) => {
  const p = path.toLowerCase().replace(/\/+$/, "");
  return p === "" ? "/" : p;
};

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

/** A 200 page that sends people on by itself: a meta refresh or a location assignment. */
function interstitial(hop: Hop | undefined): "a meta refresh" | "JavaScript" | undefined {
  const body = hop?.status === 200 ? (hop.body ?? "") : "";
  if (/<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(body)) return "a meta refresh";
  if (/location(?:\.href)?\s*=|location\.(?:replace|assign)\s*\(/i.test(body)) return "JavaScript";
  return undefined;
}

export interface PrintedVerdict {
  ids: PrintedCheckId[];
  evidence: Partial<Record<PrintedCheckId, string>>;
}

/** One printed address's trail, against where it should land. `label` names where it is printed. */
export function classifyPrinted(
  hops: readonly Hop[],
  printed: string,
  label: string,
  opts: { expected?: string; tags?: readonly string[] } = {},
): PrintedVerdict {
  const out: PrintedVerdict = { ids: [], evidence: {} };
  const add = (id: PrintedCheckId, text: string) => {
    out.ids.push(id);
    out.evidence[id] = `${label}: ${text}`;
  };
  const end = finalAddress(hops);
  const last = hops.at(-1);
  if (!end || !last) return out;
  const start = new URL(printed);
  const shown = (u: URL) => `${u.host}${u.pathname}${u.search}`;
  const redirects = hops.filter((h) => REDIRECT.has(h.status)).length;

  if (!REDIRECT.has(last.status) && last.status >= 400) {
    add("printed-dead", `${printed} ends in ${last.status} at ${shown(end)}`);
    return out;
  }
  const via = redirects === 0 ? interstitial(last) : undefined;
  let expected: URL | undefined;
  try {
    expected = opts.expected ? new URL(opts.expected, start) : undefined;
  } catch {
    expected = undefined;
  }
  if (via)
    add(
      "printed-wrong-destination",
      `${printed} stops on a page of its own that sends people on with ${via} (an interstitial), instead of redirecting`,
    );
  else if (
    expected &&
    (bare(end.host) !== bare(expected.host) || norm(end.pathname) !== norm(expected.pathname))
  )
    add(
      "printed-wrong-destination",
      `${printed} lands on ${end.pathname === "/" ? "the home page" : shown(end)}, it should land on ${shown(expected)}`,
    );
  else if (!expected && norm(start.pathname) !== "/" && norm(end.pathname) === "/")
    add("printed-to-home", `${printed} now lands on the home page (${end.host}/)`);

  const prefixes = opts.tags ?? DEFAULT_TAG_PREFIXES;
  const lost = [...start.searchParams.keys()].filter(
    (k) =>
      prefixes.some((p) => k.toLowerCase().startsWith(p.toLowerCase())) && !end.searchParams.has(k),
  );
  if (lost.length > 0)
    add("printed-tags-lost", `${printed} arrives at ${shown(end)} without ${lost.join(", ")}`);

  if (redirects > 2)
    add(
      "printed-chain",
      `${printed} takes ${redirects} redirects: ${[...hops.map((h) => new URL(h.url)), end]
        .filter((u, i, all) => i === 0 || u.href !== all[i - 1]?.href)
        .map(shown)
        .join(" → ")}`,
    );
  return out;
}

export interface PrintedOptions {
  fetcher: Fetcher;
  file?: string;
  /** Query parameter prefixes that must survive to the destination (default utm_). */
  tags?: readonly string[];
  onProgress?: (done: number, total: number) => void;
}

export interface PrintedResult {
  findings: Finding[];
  /** Addresses that couldn't be read at all (no answer): neither a finding nor a pass. */
  couldNotCheck: { url: string; reason: string; lines: number[] }[];
  checked: number;
}

/** The register's rows by address: one request for the same URL on three flyers. */
export function byAddress(rows: readonly PrintedRow[]): Map<string, PrintedRow[]> {
  const out = new Map<string, PrintedRow[]>();
  for (const row of rows) {
    let key: string;
    try {
      key = new URL(row.url).href;
    } catch {
      continue;
    }
    const group = out.get(key);
    if (group) group.push(row);
    else out.set(key, [row]);
  }
  return out;
}

const places = (rows: readonly PrintedRow[]) => [...new Set(rows.map((r) => r.where))].join(", ");

export async function checkPrinted(
  rows: readonly PrintedRow[],
  opts: PrintedOptions,
): Promise<PrintedResult> {
  const file = opts.file ?? "the printed register";
  const groups = [...byAddress(rows)];
  const findings: Finding[] = [];
  const couldNotCheck: PrintedResult["couldNotCheck"] = [];
  let done = 0;
  for (const [url, group] of groups) {
    const lines = group.map((r) => r.line);
    const label = places(group);
    let hops: Hop[] = [];
    let failure: string | undefined;
    try {
      hops = await opts.fetcher.get(url);
    } catch (err) {
      if (err instanceof FetchError && err.hops.length > 0) hops = err.hops;
      else failure = err instanceof Error ? err.message : String(err);
    }
    done++;
    opts.onProgress?.(done, groups.length);
    if (failure !== undefined) {
      // Printed as http://, and the site now answers only on https: phones open what's printed.
      const secure = url.startsWith("http://")
        ? `https://${url.slice("http://".length)}`
        : undefined;
      let answers = false;
      if (secure)
        try {
          answers = (await opts.fetcher.get(secure)).length > 0;
        } catch (err) {
          answers = err instanceof FetchError && err.hops.length > 0;
        }
      if (answers)
        findings.push(
          finding(
            "printed-dead",
            `${label}: ${url} doesn't answer on http, the address on the print; https does. Answer on http and redirect to https`,
            url,
            lines,
            file,
          ),
        );
      else couldNotCheck.push({ url, reason: failure, lines });
      continue;
    }
    const expected = group.find((r) => r.expectedDestination)?.expectedDestination;
    const verdict = classifyPrinted(hops, url, label, {
      ...(expected ? { expected } : {}),
      ...(opts.tags ? { tags: opts.tags } : {}),
    });
    for (const id of verdict.ids)
      findings.push(finding(id, verdict.evidence[id] ?? "", url, lines, file));
  }
  const first = (f: Finding) => f.group?.lines[0] ?? 0;
  return {
    findings: findings.sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || first(a) - first(b),
    ),
    couldNotCheck,
    checked: done,
  };
}

function finding(
  id: PrintedCheckId,
  evidence: string,
  key: string,
  lines: number[],
  file: string,
): Finding {
  return {
    checkId: id,
    severity: SEVERITY[id],
    title: PRINTED_TITLES[id],
    evidence,
    url: file,
    group: { key, lines },
  };
}
