/**
 * The post-publish check, for a Sanity Function (Node). It runs after every publish, resolves the
 * page the document renders to, runs the same checks the Publish button runs, and reports anything
 * that slipped past: a script or integration that wrote through the API and went around the button.
 *
 * Read-only by construction. The document arrives in the event, so the Function needs no Sanity
 * client and no token; the envelope's own context (where the Function's token lives) is never
 * read. The page is read through the core fetcher (GET and HEAD). Reporting goes to a sink you
 * give it; the default writes one JSON line to the Function's log. Nothing is written to a dataset.
 */
import { sanitise } from "@gaugeline/core";
import {
  blocking,
  checkPage,
  type GateFinding,
  type GateSeverity,
  type GateTransport,
} from "./check.js";
import { resolvePage, type GateDocument, type PageRules } from "./resolve.js";

export type { GateFinding, GateReport, GateSeverity, GateTransport } from "./check.js";
export { blocking, checkPage } from "./check.js";
export { resolvePage } from "./resolve.js";
export type { GateDocument, PageRule, PageRules, Resolution } from "./resolve.js";

/** Every status a check can end in; the docs page lists the same four. */
export const GATE_STATUSES = ["clean", "slipped", "not-gated", "could-not-check"] as const;

export type GateOutcome =
  /** The page is right. Nothing is reported. */
  | { status: "clean"; documentId: string; type: string; url: string; checkedAt: string }
  /** The page has problems the button would have held. Reported. */
  | {
      status: "slipped";
      documentId: string;
      type: string;
      url: string;
      checkedAt: string;
      findings: GateFinding[];
    }
  /** A draft, or a document that renders to no page. Nothing was requested. */
  | { status: "not-gated"; documentId: string; type: string; reason: string }
  /** The check could not run (site down, a slug that cannot be trusted, no document in the event). Reported: this is not a pass. */
  | {
      status: "could-not-check";
      documentId: string;
      type: string;
      url?: string;
      checkedAt?: string;
      reason: string;
    };

export interface GateOptions {
  /** The live site, for example "https://lantern-yard.example". */
  site: string;
  /** Which document types render to a page, and at what address. */
  pages: PageRules;
  /** The lowest severity that counts as a problem. Default "high". */
  blockOn?: GateSeverity;
  /** Milliseconds to wait after a publish before reading the page, for a site that rebuilds. Default 0. */
  settleMs?: number;
  /** Where a problem is recorded. Default: one JSON line on the Function's log. */
  report?: (outcome: GateOutcome) => void | Promise<void>;
  /** Replaces the network; for tests. */
  transport?: GateTransport;
  now?: () => Date;
  wait?: (ms: number) => Promise<void>;
}

/** Format and control characters: zero-width, bidi, tag characters. */
const INVISIBLE = /[\p{Cf}\p{Cc}]/gu;

const NOTHING = { documentId: "", type: "" } as const;

function isDocument(data: unknown): data is GateDocument {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const d = data as Record<string, unknown>;
  return typeof d._id === "string" && d._id !== "" && typeof d._type === "string" && d._type !== "";
}

/** The check for one document, as the Function runs it. Never throws for a document or a site problem. */
export async function checkDocument(data: unknown, options: GateOptions): Promise<GateOutcome> {
  if (!isDocument(data))
    return {
      status: "could-not-check",
      ...NOTHING,
      reason: "The event held no document with an _id and a _type.",
    };
  // Rules and the draft test see the id and type exactly as the dataset has them (a type with a
  // hidden character is not the type it imitates); only what is output is cleaned and capped.
  const documentId = sanitise(data._id, 200).text;
  const type = sanitise(data._type, 100).text;
  // Invisible characters in front of the prefix must not hide a draft.
  if (/^(?:drafts|versions)\./.test(data._id.replace(INVISIBLE, "")))
    return {
      status: "not-gated",
      documentId,
      type,
      reason: "A draft or a release version is not published.",
    };
  const resolved = resolvePage(data, { site: options.site, pages: options.pages });
  if (resolved.kind === "no-page")
    return { status: "not-gated", documentId, type, reason: resolved.reason };
  if (resolved.kind === "unresolved")
    return { status: "could-not-check", documentId, type, reason: resolved.reason };
  const wait = options.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if ((options.settleMs ?? 0) > 0) await wait(options.settleMs ?? 0);
  const report = await checkPage({
    url: resolved.url,
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const at = { url: report.url, checkedAt: report.checkedAt };
  if (report.unreachable !== undefined)
    return { status: "could-not-check", documentId, type, ...at, reason: report.unreachable };
  const problems = blocking(report, options.blockOn ?? "high");
  return problems.length === 0
    ? { status: "clean", documentId, type, ...at }
    : { status: "slipped", documentId, type, ...at, findings: problems };
}

const toLog = (outcome: GateOutcome): void =>
  console.log(JSON.stringify({ gaugeline: "publish-gate", ...outcome }));

/**
 * The handler for a document-event Function. It takes only `event.data`; whatever else the envelope
 * carries (the Function's context and token included) is not read. A problem is handed to
 * `report`; a clean page and a document that is not a page report nothing.
 */
export function gateHandler(
  options: GateOptions,
): (envelope: { event: { data: unknown } }) => Promise<void> {
  return async (envelope) => {
    const outcome = await checkDocument(envelope?.event?.data, options);
    if (outcome.status === "slipped" || outcome.status === "could-not-check")
      await (options.report ?? toLog)(outcome);
  };
}
