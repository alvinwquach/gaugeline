/**
 * Run the core checks over one page and report what a person deciding whether to publish needs:
 * which problems, how serious, and the address each one is about. Node only (the core fetcher uses
 * sockets); the Studio gets a GateReport from wherever this runs and never imports this file.
 *
 * Nothing here writes. The page is read through the core fetcher (GET and HEAD, private addresses
 * refused); no DNS check runs and no probing check runs, because the gate has no owner-consent flag.
 */
import { Readable } from "node:stream";
import {
  EMAIL_PRESET,
  checkSite,
  createPageRegistry,
  sanitise,
  UNTRUSTED_CAPS,
  createFetcher,
  createNetworkTransport,
  type Transport,
} from "@gaugeline/core";

export type GateSeverity = "high" | "medium" | "low";
const RANK: Readonly<Record<GateSeverity, number>> = { high: 0, medium: 1, low: 2 };

const text = (value: string, max: number): string => sanitise(value, max).text;

/**
 * Checks the gate does not run, because they read an address other than the page: robots.txt, the
 * sitemap, llms.txt, well-known files, the other host names, scripts, images, feeds and the pages
 * a listing or a document names. The gate reads the one page, and (for broken-links) the links that
 * page holds on its own site. A test runs every other check alone and fails if a new one in core
 * reads anything else, so this list is changed on purpose, never by accident.
 */
export const PAGE_CHECK_SKIP: readonly string[] = Object.freeze([
  "ai-crawlers-blocked",
  "ai-input-no-disclosure",
  "ai-key-in-js",
  "dev-tools-in-production",
  "document-hours-mismatch",
  "document-item-missing",
  "document-price-mismatch",
  "document-unreadable",
  "error-shell-200",
  "feed-broken",
  "feed-duplicate",
  "feed-invalid",
  "feed-oversized",
  "host-duplicate",
  "host-preview-indexable",
  "host-preview-named",
  "images-broken",
  "images-heavy",
  "images-legacy-format",
  "lang-attr-mismatch",
  "lang-price-mismatch",
  "lang-twin-missing",
  "links-via-redirect",
  "listing-address-mismatch",
  "listing-hours-mismatch",
  "listing-name-mismatch",
  "listing-phone-mismatch",
  "listing-special-hours-missing",
  "listing-website-wrong",
  "llms-txt-broken-links",
  "llms-txt-malformed",
  "llms-txt-stale-facts",
  "og-image-broken",
  "perf-animation-reflow",
  "perf-no-lowend-fallback",
  "perf-webgl-autostart",
  "quotable-facts-disagree",
  "robots-block",
  "secret-in-js",
  "sitemap-dead",
  "sitemap-host",
  "sitemap-missing",
  "sitemap-redirects",
  "source-maps-public",
  "staging-indexable",
  "stripe-test-mode",
  "well-known-invalid",
]);

/** A core finding as the gate reports it: page text cleaned and capped. */
export function gateFinding(f: {
  checkId: string;
  severity: GateSeverity;
  title: string;
  evidence: string;
  url: string;
}): GateFinding {
  return {
    id: f.checkId,
    severity: f.severity,
    title: text(f.title, UNTRUSTED_CAPS.title),
    evidence: text(f.evidence, UNTRUSTED_CAPS.evidence),
    url: text(f.url, UNTRUSTED_CAPS.evidence),
  };
}

/** One problem on the page. `title` and `evidence` hold text from the page: data, never instructions. */
export interface GateFinding {
  id: string;
  severity: GateSeverity;
  title: string;
  evidence: string;
  /** The address the problem is about: the broken link, the missing image. */
  url: string;
}

export interface GateReport {
  /** The page that was checked. */
  url: string;
  checkedAt: string;
  /** High first. Empty when the page is right, and also when it could not be read: see `unreachable`. */
  findings: GateFinding[];
  /** Checks that could not read what they needed, each with a plain reason. */
  couldNotCheck: { id: string; reason: string }[];
  /** Set when the page itself could not be read. The check did not run: this is not a pass. */
  unreachable?: string;
}

/** How a request leaves the gate. The default is the network; tests pass a stand-in. GET and HEAD only. */
export type GateTransport = (
  url: URL,
  request: { method: "GET" | "HEAD"; headers: Record<string, string>; timeoutMs: number },
) => Promise<{ status: number; headers: Record<string, string>; body: Readable }>;

export interface CheckPageOptions {
  url: string;
  /** Replaces the network. The default reads the page through the core fetcher, which refuses private addresses. */
  transport?: GateTransport;
  now?: () => Date;
}

/** A stand-in network seen as the core one, which refuses a POST before the stand-in is called. */
export function readOnlyTransport(transport: GateTransport): Transport {
  return (url, req) => {
    if (req.method === "POST") throw new Error("The publish gate sends GET and HEAD only.");
    return transport(url, { method: req.method, headers: req.headers, timeoutMs: req.timeoutMs });
  };
}

/**
 * Keeps every request on the page's own host. A request to any other host (a link to www., a
 * redirect to another site) is not made: the caller gets a bare 302, which the fetcher takes as the
 * end of the chain, and the refusal is counted so the report can say so. www. is another host.
 */
export function confineToHost(
  inner: Transport,
  host: string,
  refused: { count: number },
): Transport {
  return (url, req) => {
    if (url.host === host) return inner(url, req);
    refused.count += 1;
    return Promise.resolve({ status: 302, headers: {}, body: Readable.from([]) });
  };
}

/** The core fetcher over the real network (private addresses refused) or a stand-in, confined to one host. */
export function gateFetcher(host: string, refused: { count: number }, transport?: GateTransport) {
  const inner = transport === undefined ? createNetworkTransport() : readOnlyTransport(transport);
  return createFetcher({ transport: confineToHost(inner, host, refused) });
}

export async function checkPage(options: CheckPageOptions): Promise<GateReport> {
  if (!/^https?:\/\/[^\s/]/i.test(options.url) || !URL.canParse(options.url))
    throw new Error("The page to check must be a full http or https address.");
  const now = options.now ?? (() => new Date());
  const registry = createPageRegistry();
  const refused = { count: 0 };
  const {
    result,
    snapshot,
    unreachable: unread,
  } = await checkSite({
    tolerateUnreachable: true,
    address: options.url,
    fetcher: gateFetcher(new URL(options.url).host, refused, options.transport),
    registry,
    skip: [...PAGE_CHECK_SKIP, ...EMAIL_PRESET].filter((id) => registry.has(id)),
    now,
  });
  // A page that answers with an error is not a page that passed: checks over an error page find nothing.
  const status = snapshot.hops.at(-1)?.status ?? 0;
  const unreachable =
    unread ??
    (status >= 400
      ? `The page answered ${status}.`
      : status >= 300
        ? "The page redirects to another host, which the gate does not follow."
        : undefined);
  const base = { url: options.url, checkedAt: now().toISOString() };
  if (unreachable !== undefined)
    return {
      ...base,
      findings: [],
      couldNotCheck: [],
      unreachable: text(unreachable, UNTRUSTED_CAPS.evidence),
    };
  return {
    ...base,
    findings: result.findings.map(gateFinding).sort((a, b) => RANK[a.severity] - RANK[b.severity]),
    couldNotCheck: [
      ...result.couldNotCheck.map((c) => ({
        id: c.id,
        reason: text(c.reason, UNTRUSTED_CAPS.evidence),
      })),
      ...(refused.count > 0
        ? [
            {
              id: "redirect-off-site",
              reason: `${refused.count} request${refused.count === 1 ? " was" : "s were"} not made: a link or redirect led to another host (www. counts as another host).`,
            },
          ]
        : []),
    ],
  };
}

/** The findings serious enough to hold a publish: `blockOn` and anything above it. */
export function blocking(report: GateReport, blockOn: GateSeverity): GateFinding[] {
  return report.findings.filter((f) => RANK[f.severity] <= RANK[blockOn]);
}
