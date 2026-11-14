import type { EventObserver } from "../events/observe.js";
import type { A11yRead } from "../a11y/types.js";
import type { UntrustedText } from "../untrusted.js";

/**
 * The renderer seam (ADR-0009, accepted in part on 13 Nov 2026). A Renderer loads ONE public page in a
 * browser and hands back data about what the page did: the final address and status, the text and links
 * it was asked to expose, and the requests it made. It never hands back a live page, so core imports no
 * browser. Off unless a run names a renderer (`--renderer playwright`).
 */

/** The renderers a run may name. One today; a name outside this list is refused at the flag. */
export const RENDERER_NAMES = ["playwright"] as const;
export type RendererName = (typeof RENDERER_NAMES)[number];

/** Hard caps. A cap that trips makes the page could-not-check, never a finding (ADR-0009, part 3). */
export interface RenderLimits {
  /** Requests the page may attempt, allowed or blocked. */
  requests: number;
  /** Bytes the page may download in all. */
  bytes: number;
  /** Bytes one response may be. */
  responseBytes: number;
  /** Milliseconds one page may take. */
  ms: number;
  /** Pages one renderer renders in a run. */
  pages: number;
  /** Milliseconds all the pages of a run may take. */
  runMs: number;
  /** Redirects followed in a row. */
  redirects: number;
  /** Characters of page text kept. */
  textChars: number;
  /** Links kept. */
  links: number;
  /** Characters of rendered HTML kept, when it is asked for. */
  htmlChars: number;
}

/** The ADR's proposed numbers; the uncited ones are said so in the docs page. */
export const DEFAULT_RENDER_LIMITS: Readonly<RenderLimits> = Object.freeze({
  requests: 300,
  bytes: 100 * 1024 * 1024,
  responseBytes: 20 * 1024 * 1024,
  ms: 20_000,
  pages: 10,
  runMs: 5 * 60_000,
  redirects: 10,
  textChars: 50_000,
  links: 500,
  htmlChars: 1_000_000,
});

/** Why a request was stopped. Every one is counted, and none is ever sent. */
export const BLOCK_REASONS = [
  /** Not GET or HEAD: a POST, PUT, PATCH, DELETE or a preflight. */
  "method",
  /** Not http or https. */
  "scheme",
  /** A private, loopback, link-local or metadata address (the fetcher's refusal). */
  "address",
  /** An analytics, advertising or session-replay host from the built-in list. */
  "analytics",
  /** A WebSocket: nothing is sent over one. */
  "websocket",
  /** A window the page opened. */
  "popup",
  /** A form the page tried to submit. */
  "form",
  /** A cap: requests, bytes, redirects or time. */
  "cap",
  /** The request could not be answered (no host, timeout, reset). */
  "failed",
  /** Refused by the load's own variant (a script from another site, PERF-02): never sent. */
  "variant",
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

/** One request the page made. The address has no query string or fragment: those can carry a token. */
export interface RenderedRequest {
  /** Origin and path only. */
  url: string;
  method: string;
  /** What asked for it: "document", "script", "image", "fetch", ... */
  kind: string;
  /** "allowed": answered through the egress gate. "blocked": see reason. */
  verdict: "allowed" | "blocked";
  reason?: BlockReason;
  status?: number;
  bytes?: number;
}

/**
 * One thing changed about how the page loads, to see which change moves the numbers (PERF-02). Every option can
 * only take something away from the page: none of them lets the browser reach anything it could not.
 */
export interface RenderVariant {
  /** Force `prefers-reduced-motion: reduce`, as a visitor who asked for less motion has it. */
  reducedMotion?: boolean;
  /** `false` loads the page with JavaScript turned off. */
  javaScript?: false;
  /** Refuse every script that comes from another site than the page's. Refused, never requested. */
  blockThirdPartyScripts?: boolean;
}

/** Ask for the load's timings. `sample` is which repeat this is: it only tells two identical loads apart. */
export interface RenderMeasure {
  sample: number;
}

/** What one load measured, in whole milliseconds from the moment the load was started. Local and unthrottled. */
export interface PagePerformance {
  /** Largest Contentful Paint: the last candidate the browser reported, from just before the load was started. Absent: none was reported. */
  lcpMs?: number;
  /**
   * Total blocking time: every long task's time over 50 ms, from the start (not from first paint), never more than
   * the load took. Absent when it is not measured: with JavaScript off there are no long tasks to observe.
   */
  tbtMs?: number;
  /** Scripts this variant refused (blockThirdPartyScripts). Never requested; also counted in `blocked.variant`. */
  scriptsRefused: number;
  /**
   * The page reported long tasks that cannot be real (too many, too short, longer than the load, more in all than the
   * load took), so its blocking time was dropped rather than reported. A page can call the measurement function
   * and lie to its own measurement; this catches the lies that cannot be true, not all of them.
   */
  tampered?: true;
}

export interface RenderRequest {
  /** The page to load: http or https. */
  url: string;
  /** Load it with something taken away (see RenderVariant). Default: as a visitor's browser would. */
  variant?: RenderVariant;
  /** Measure the load (see PagePerformance). Off by default. */
  measure?: RenderMeasure;
  /** Viewport in CSS pixels. Default 1280 x 800. */
  viewport?: { width: number; height: number };
  /** What to hand back. Text and links by default; the HTML only when asked for. */
  expose?: { text?: boolean; links?: boolean; html?: boolean; a11y?: boolean };
}

export interface RenderedLink {
  href: string;
  text: string;
}

/** What the page did. Everything a page wrote is untrusted data (rule 11): sanitised, bounded, labelled. */
export interface RenderedPage {
  kind: "rendered";
  /** The address the page ended on, after redirects and any script that navigated. */
  finalUrl: string;
  /** The status of the last document the browser was given for the main frame. */
  status: number;
  title: UntrustedText;
  text?: UntrustedText;
  links?: RenderedLink[];
  html?: UntrustedText;
  /** The requests the page made, at most `limits.requests`. */
  requests: RenderedRequest[];
  /** How many of each kind of request, window and form was stopped. */
  blocked: Record<BlockReason, number>;
  /** Everything the page did, including requests past the list's cap. */
  totals: { requests: number; bytes: number };
  /** What was cut to stay in bounds: "text", "links", "html". */
  truncated: string[];
  /** What the browser computed about contrast, focus order, names, landmarks and motion, only when asked for (N16). */
  a11y?: A11yRead;
  /** The load's timings, only when the request asked to measure it. */
  performance?: PagePerformance;
}

/** The page was not read, and the reason is a plain sentence. Never a pass, never a finding. */
export interface RenderCouldNotCheck {
  kind: "could-not-check";
  reason: string;
  /** What the person can do about it: how to install a browser, say. */
  hint?: string;
  /** What was stopped before the render ended, when anything was. */
  blocked?: Record<BlockReason, number>;
}

export type RenderResult = RenderedPage | RenderCouldNotCheck;

/** Whether a render can start, found without starting a browser: nothing is launched or fetched. */
export type RendererAvailability = { kind: "available"; detail: string } | RenderCouldNotCheck;

export interface Renderer {
  readonly name: RendererName;
  /**
   * Clicks the tracking plan's links in the browser and reports what the page sent (ADR-0009: links only,
   * analytics recorded and never delivered). Absent: the renderer cannot click, and the click checks say
   * could not check.
   */
  readonly observer?: EventObserver;
  /** Can this renderer render here? Looks for the driver and the browser and starts neither. */
  availability(): Promise<RendererAvailability>;
  /** Load one page. Never throws for a page that misbehaves: the answer is could-not-check. */
  render(request: RenderRequest): Promise<RenderResult>;
  /** Stop the browser. Safe to call twice. */
  close(): Promise<void>;
}

/** A count of zero for every reason, for a result that has not blocked anything yet. */
export function emptyBlocked(): Record<BlockReason, number> {
  return Object.fromEntries(BLOCK_REASONS.map((r) => [r, 0])) as Record<BlockReason, number>;
}
