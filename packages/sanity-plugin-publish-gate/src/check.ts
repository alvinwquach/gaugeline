/**
 * Run the core checks over one page and report what a person deciding whether to publish needs:
 * which problems, how serious, and the address each one is about. Node only (the core fetcher uses
 * sockets); the Studio gets a GateReport from wherever this runs and never imports this file.
 *
 * Nothing here writes. The page is read through the core fetcher (GET and HEAD, private addresses
 * refused); no DNS check runs and no probing check runs, because the gate has no owner-consent flag.
 */
import type { Readable } from "node:stream";
import {
  EMAIL_PRESET,
  checkSite,
  createPageRegistry,
  sanitise,
  UNTRUSTED_CAPS,
  createFetcher,
  type Transport,
} from "@gaugeline/core";

export type GateSeverity = "high" | "medium" | "low";
const RANK: Readonly<Record<GateSeverity, number>> = { high: 0, medium: 1, low: 2 };

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

/** The core fetcher, with a stand-in network when one is given. A request that is not GET or HEAD is refused here too. */
export function gateFetcher(transport?: GateTransport) {
  if (transport === undefined) return createFetcher();
  const readOnly: Transport = (url, req) => {
    if (req.method === "POST") throw new Error("The publish gate sends GET and HEAD only.");
    return transport(url, { method: req.method, headers: req.headers, timeoutMs: req.timeoutMs });
  };
  return createFetcher({ transport: readOnly });
}

const text = (value: string, max: number): string => sanitise(value, max).text;

export async function checkPage(options: CheckPageOptions): Promise<GateReport> {
  if (!/^https?:\/\/[^\s/]/i.test(options.url) || !URL.canParse(options.url))
    throw new Error("The page to check must be a full http or https address.");
  const now = options.now ?? (() => new Date());
  const registry = createPageRegistry();
  const {
    result,
    snapshot,
    unreachable: unread,
  } = await checkSite({
    tolerateUnreachable: true,
    address: options.url,
    fetcher: gateFetcher(options.transport),
    registry,
    skip: EMAIL_PRESET.filter((id) => registry.has(id)),
    now,
  });
  // A page that answers with an error is not a page that passed: checks over an error page find nothing.
  const status = snapshot.hops.at(-1)?.status ?? 0;
  const unreachable = unread ?? (status >= 400 ? `The page answered ${status}.` : undefined);
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
    findings: result.findings
      .map((f): GateFinding => ({
        id: f.checkId,
        severity: f.severity,
        title: text(f.title, UNTRUSTED_CAPS.title),
        evidence: text(f.evidence, UNTRUSTED_CAPS.evidence),
        url: text(f.url, UNTRUSTED_CAPS.evidence),
      }))
      .sort((a, b) => RANK[a.severity] - RANK[b.severity]),
    couldNotCheck: result.couldNotCheck.map((c) => ({
      id: c.id,
      reason: text(c.reason, UNTRUSTED_CAPS.evidence),
    })),
  };
}

/** The findings serious enough to hold a publish: `blockOn` and anything above it. */
export function blocking(report: GateReport, blockOn: GateSeverity): GateFinding[] {
  return report.findings.filter((f) => RANK[f.severity] <= RANK[blockOn]);
}
