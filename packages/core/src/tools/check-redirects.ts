import { parseAddress } from "../address.js";
import {
  createFetcher,
  createNetworkTransport,
  FetchError,
  type Fetcher,
  type FetcherOptions,
  type Transport,
} from "../fetcher.js";
import { checkRedirects } from "../plan/redirects.js";
import type { PlanRow } from "../plan/read.js";
import { LIVE_LIMIT, type ListRow } from "./lint.js";

/**
 * The free redirect tool's live check: up to 25 rows of a from/to list, requested on the one
 * domain the visitor typed, read by the same redirect-map code as `gaugeline plan --base`.
 * Every request is a GET through the fetcher; a hop to any other host is never sent.
 */
export interface LiveRow {
  line: number;
  checkId: string;
  title: string;
  evidence: string;
}

export interface LiveResult {
  domain: string;
  /** Rows requested (at most 25). */
  checked: number;
  /** Rows in the list beyond the first 25: linted in the browser, not requested. */
  skipped: number;
  findings: LiveRow[];
  couldNotCheck: { line: number; reason: string }[];
}

/** The list can't be checked live: the message is shown to the visitor as it is. */
export class LiveRefusal extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "LiveRefusal";
  }
}

const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");

/** The domain typed, bare: shop.example for "https://www.shop.example/". */
export function liveDomain(typed: string): string {
  const a = parseAddress(typed);
  if (!a.ok)
    throw new LiveRefusal(
      `"${typed}" is not a domain: type it the way it appears in a browser, such as shop.example.`,
    );
  return bare(a.url.hostname);
}

/** A fetcher whose requests stay on the domain and its www.: any other host is refused, unsent. */
export function domainFetcher(domain: string, options: FetcherOptions = {}): Fetcher {
  const network: Transport = options.transport ?? createNetworkTransport(options);
  return createFetcher({
    ...options,
    transport: (url, req) => {
      if (bare(url.hostname) !== domain)
        return Promise.reject(
          new FetchError(
            "refused",
            `${url.hostname} is not on ${domain}: the live check stops there.`,
            url.href,
            [],
          ),
        );
      return network(url, req);
    },
  });
}

export async function liveCheck(
  input: { domain: string; rows: readonly ListRow[] },
  opts: {
    fetcher?: Fetcher;
    fetcherOptions?: FetcherOptions;
    /** Tests only: request the domain over http (the fixture servers are plain http). */
    scheme?: "http" | "https";
  } = {},
): Promise<LiveResult> {
  const domain = liveDomain(input.domain);
  const other = new Set<string>();
  for (const r of input.rows) {
    try {
      const u = new URL(r.from);
      if (bare(u.hostname) !== domain) other.add(bare(u.hostname));
    } catch {
      /* a path: on the typed domain */
    }
  }
  if (other.size > 0)
    throw new LiveRefusal(
      `The list spans more than one domain (${[domain, ...other].join(", ")}): the live check only requests addresses on the domain you typed, ${domain}. Check one domain at a time.`,
    );
  const rows = input.rows.slice(0, LIVE_LIMIT);
  const base = `${opts.scheme ?? "https"}://${domain}`;
  const planRows: PlanRow[] = rows.map((r) => {
    const to = new URL(r.to, base);
    return { line: r.line, url: to.href, path: to.pathname, legacyUrl: r.from, raw: {} };
  });
  const fetcher = opts.fetcher ?? domainFetcher(domain, opts.fetcherOptions);
  const result = await checkRedirects(planRows, { base, fetcher, file: "the list" });
  return {
    domain,
    checked: result.checked,
    skipped: Math.max(0, input.rows.length - LIVE_LIMIT),
    findings: result.findings.map((f) => ({
      line: f.group?.lines[0] ?? 0,
      checkId: f.checkId,
      title: f.title,
      evidence: f.evidence,
    })),
    couldNotCheck: result.couldNotCheck.map((c) => ({ line: c.lines[0] ?? 0, reason: c.reason })),
  };
}

/** Requests per visitor, in a sliding window, held in this instance's memory. */
export function createLimiter(opts: { max: number; windowMs: number; now?: () => number }) {
  const seen = new Map<string, number[]>();
  const now = opts.now ?? (() => Date.now());
  return {
    take(visitor: string): boolean {
      const t = now();
      const recent = (seen.get(visitor) ?? []).filter((x) => t - x < opts.windowMs);
      if (recent.length >= opts.max) {
        seen.set(visitor, recent);
        return false;
      }
      recent.push(t);
      seen.set(visitor, recent);
      return true;
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * The HTTP side: POST { domain, rows: [{ line, from, to }] }. Nothing is stored or logged; the
 * visitor is told the reason for any refusal. `visitor` is the client address the host reports.
 */
export async function handleCheckRedirects(
  req: Request,
  deps: {
    limiter: ReturnType<typeof createLimiter>;
    visitor: string;
    fetcherOptions?: FetcherOptions;
  },
): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "Send the list with POST." });
  if (!deps.limiter.take(deps.visitor))
    return json(429, {
      error:
        "Too many live checks from this address: wait a minute, or run the full check locally.",
    });
  let body: { domain?: unknown; rows?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json(400, { error: "The request isn't JSON." });
  }
  const rows = Array.isArray(body.rows)
    ? body.rows.filter(
        (r): r is ListRow =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as ListRow).from === "string" &&
          typeof (r as ListRow).to === "string" &&
          typeof (r as ListRow).line === "number",
      )
    : [];
  if (typeof body.domain !== "string" || rows.length === 0)
    return json(400, { error: "Send a domain and at least one row with from and to." });
  try {
    return json(
      200,
      await liveCheck(
        { domain: body.domain, rows },
        { ...(deps.fetcherOptions ? { fetcherOptions: deps.fetcherOptions } : {}) },
      ),
    );
  } catch (err) {
    if (err instanceof LiveRefusal) return json(err.status, { error: err.message });
    return json(502, { error: (err as Error).message });
  }
}
