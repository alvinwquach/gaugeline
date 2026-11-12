import { isIP } from "node:net";
import { parseSrcset } from "../checks/images/refs.js";
import type { PageSnapshot } from "../snapshot.js";

/**
 * Image optimizers (XF-04, ADR-0007). An optimizer is an address on the site that fetches the image
 * named in its query, resizes it and sends it back. It is safe only as far as its allowlist is. This
 * file is the pure part: no request is made here. Sources: Next.js images.remotePatterns, the
 * Vercel build output images block, Nuxt Image IPX domains, Astro image.domains and
 * remotePatterns, the Netlify Image CDN remote_images setting [docs] (see ADR-0007, Sources).
 */

export type OptimizerId = "next" | "vercel" | "ipx" | "astro" | "netlify";

export interface Optimizer {
  id: OptimizerId;
  /** What the report calls it. */
  label: string;
  /** The path on the site's own origin, as it appears in a report. */
  path: string;
  /** The query parameter that names the source image (IPX carries it in the path). */
  param?: "url" | "href";
}

export const OPTIMIZERS: readonly Optimizer[] = Object.freeze([
  { id: "next", label: "Next.js", path: "/_next/image", param: "url" },
  { id: "vercel", label: "Vercel", path: "/_vercel/image", param: "url" },
  { id: "ipx", label: "Nuxt Image (IPX)", path: "/_ipx/" },
  { id: "astro", label: "Astro", path: "/_image", param: "href" },
  { id: "netlify", label: "Netlify Image CDN", path: "/.netlify/images", param: "url" },
]);

const BY_ID = new Map(OPTIMIZERS.map((o) => [o.id, o] as const));

/** One address of an optimizer that the page itself uses. */
export interface OptimizerAddress {
  optimizer: OptimizerId;
  /** The optimizer's path (no query). */
  path: string;
  /** The address as the page wrote it, resolved: kept for sorting, never printed. */
  raw: string;
  width?: number;
  quality?: number;
  /** IPX only: the modifiers segment as written (w_320,f_webp). */
  modifiers?: string;
  /** The host the address already fetches from, when its source is an absolute address. */
  sourceHost?: string;
}

function hostOf(source: string | null | undefined): string | undefined {
  if (!source) return undefined;
  const m = /^https?:\/{1,2}([^/?#:]+)/i.exec(source);
  return m?.[1]?.toLowerCase();
}

function positive(n: string | null | undefined): number | undefined {
  const v = Number(n);
  return n && Number.isInteger(v) && v > 0 ? v : undefined;
}

function classify(u: URL): OptimizerAddress | undefined {
  const base = { raw: u.href };
  const path = u.pathname.replace(/(.)\/$/, "$1");
  const query = OPTIMIZERS.find((o) => o.param && o.path === path);
  if (query?.param) {
    const width = positive(u.searchParams.get("w"));
    const quality = positive(u.searchParams.get("q"));
    const sourceHost = hostOf(u.searchParams.get(query.param));
    return {
      ...base,
      optimizer: query.id,
      path: query.path,
      ...(width ? { width } : {}),
      ...(quality ? { quality } : {}),
      ...(sourceHost ? { sourceHost } : {}),
    };
  }
  if (!u.pathname.startsWith("/_ipx/")) return undefined;
  const rest = u.pathname.slice("/_ipx/".length);
  const slash = rest.indexOf("/");
  if (slash < 1) return undefined;
  const modifiers = rest.slice(0, slash);
  let source = rest.slice(slash + 1);
  try {
    source = decodeURIComponent(source);
  } catch {
    // keep it as written
  }
  const w = /(?:^|[,&])(?:w|width)_(\d+)/.exec(modifiers) ?? /(?:^|[,&])s_(\d+)x/.exec(modifiers);
  const q = /(?:^|[,&])(?:q|quality)_(\d+)/.exec(modifiers);
  const width = positive(w?.[1]);
  const quality = positive(q?.[1]);
  const sourceHost = hostOf(source);
  return {
    ...base,
    optimizer: "ipx",
    path: "/_ipx/",
    modifiers,
    ...(width ? { width } : {}),
    ...(quality ? { quality } : {}),
    ...(sourceHost ? { sourceHost } : {}),
  };
}

/**
 * The optimizer addresses on the page's own origin that its images, srcset and sources, and its
 * og:image, name. Nothing is requested. An address on another origin is not this site's optimizer.
 */
export function findOptimizerAddresses(
  page: Pick<PageSnapshot, "images" | "og" | "finalUrl">,
): OptimizerAddress[] {
  const candidates: string[] = [];
  for (const img of page.images) {
    candidates.push(img.src);
    for (const c of parseSrcset(img.srcset ?? "")) candidates.push(c.url);
    for (const s of img.sources ?? [])
      for (const c of parseSrcset(s.srcset)) candidates.push(c.url);
  }
  for (const [key, value] of Object.entries(page.og))
    if (/image/i.test(key)) candidates.push(value);
  const origin = new URL(page.finalUrl).origin;
  const seen = new Set<string>();
  const out: OptimizerAddress[] = [];
  for (const c of candidates) {
    let u: URL;
    try {
      u = new URL(c, page.finalUrl);
    } catch {
      continue;
    }
    if (u.origin !== origin || seen.has(u.href)) continue;
    seen.add(u.href);
    const found = classify(u);
    if (found) out.push(found);
  }
  return out;
}

/** The optimizer's name, for a report. */
export function optimizerLabel(id: OptimizerId): string {
  return BY_ID.get(id)?.label ?? id;
}

/** The optimizer's label and path, for a report. */
export function describeOptimizer(id: OptimizerId): string {
  const o = BY_ID.get(id);
  return o ? `${o.label} (${o.path})` : id;
}

/** The address to ask with: the smallest width the page itself used, ties by address, so it is the same every run. */
export function pickAddress(addresses: readonly OptimizerAddress[]): OptimizerAddress | undefined {
  return [...addresses].sort(
    (a, b) =>
      (a.width ?? Number.MAX_SAFE_INTEGER) - (b.width ?? Number.MAX_SAFE_INTEGER) ||
      a.raw.localeCompare(b.raw),
  )[0];
}

/**
 * The one request that asks an optimizer to fetch the owner's probe address. It uses the width and
 * quality the page itself asked with (so they are known to be accepted); Gaugeline does not guess
 * either. A query-style optimizer whose page address gave no width gets no probe.
 */
export function buildProbe(
  origin: string,
  address: OptimizerAddress,
  probeUrl: string,
): string | undefined {
  const target = encodeURIComponent(probeUrl);
  if (address.optimizer === "ipx") return `${origin}/_ipx/${address.modifiers || "_"}/${target}`;
  const o = BY_ID.get(address.optimizer);
  if (!o?.param || address.width === undefined) return undefined;
  const q = address.quality === undefined ? "" : `&q=${address.quality}`;
  return `${origin}${o.path}?${o.param}=${target}&w=${address.width}${q}`;
}

export interface ProbeContext {
  siteHost: string;
  /** Hosts the page's optimizer addresses already fetch from: known to be allowed. */
  seenHosts: readonly string[];
  /** The text of the settings files given, if any. */
  settingsText?: string;
}

/**
 * Why the owner's probe address cannot be used, or undefined when it can. A 200 from an allowed
 * host proves nothing, and an address that points inward would be an attack payload (CLAUDE.md
 * rule 14), so both are refused before anything is sent. Reads after "could not be checked:".
 */
export function probeRefusal(probeUrl: string, ctx: ProbeContext): string | undefined {
  let u: URL;
  try {
    u = new URL(probeUrl);
  } catch {
    return "imageOptimizerProbeUrl is not a full web address";
  }
  if (u.protocol !== "https:") return "imageOptimizerProbeUrl must start with https://";
  const host = u.hostname.toLowerCase();
  if (host.startsWith("[") || isIP(host) !== 0)
    return "imageOptimizerProbeUrl is an IP address; use a public host name you control";
  if (!host.includes(".") || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host))
    return "imageOptimizerProbeUrl names a private host; use a public host name you control";
  if (host === ctx.siteHost.toLowerCase())
    return "imageOptimizerProbeUrl is on your own host, which is always allowed, so an answer would prove nothing";
  if (ctx.seenHosts.includes(host))
    return "imageOptimizerProbeUrl is on a host your image addresses already use, so an answer would prove nothing";
  if (ctx.settingsText?.toLowerCase().includes(host))
    return "imageOptimizerProbeUrl is on a host named in the image settings you gave, so an answer would prove nothing";
  return undefined;
}

/** What the first bytes of an answer are, for the probe: an image, a web page, other bytes, nothing. */
export function sniffImage(data: Uint8Array): "image" | "html" | "other" | "empty" {
  if (data.byteLength === 0) return "empty";
  const at = (i: number, s: string) =>
    data.byteLength >= i + s.length && [...s].every((c, k) => data[i + k] === c.charCodeAt(0));
  if (data[0] === 0x89 && at(1, "PNG")) return "image";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image";
  if (at(0, "GIF8") || at(0, "BM")) return "image";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image";
  if (at(4, "ftyp") && (at(8, "avif") || at(8, "avis") || at(8, "heic"))) return "image";
  const lead = Buffer.from(data.subarray(0, Math.min(data.byteLength, 256)))
    .toString("latin1")
    .trimStart()
    .toLowerCase();
  if (/^(?:<!doctype html|<html|<head|<body|<!--)/.test(lead)) return "html";
  if (/^(?:<svg|<\?xml[^>]*\?>\s*<svg)/.test(lead)) return "image";
  return "other";
}

export interface SettingsIssue {
  file: string;
  /** 1-based line of the entry. */
  line: number;
  kind: "wide" | "unanchored";
  /** The entry as written, cut to 80 characters. */
  entry: string;
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
}

/** A hostname pattern that matches every host: only wildcards, or a wildcard and a bare top-level name. */
function wideHost(h: string): boolean {
  return /^\*+(?:\.\*+)*$/.test(h) || /^\*+\.[a-z]{2,}$/i.test(h);
}

/** The matching close bracket's index for the bracket at `open`, or the end of the text. */
function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) return i;
  }
  return text.length;
}

/**
 * Read a framework settings file as text for an image allowlist that lets any host through: a
 * wildcard hostname, a remotePatterns entry with no hostname (an https-only pattern), a domains list
 * holding a wildcard, a Netlify remote_images expression that matches everything or is not anchored
 * with ^ and $. A statement about the file: certain, and silent when the settings are tight. The
 * file is only read as text, never run.
 */
export function readImageSettings(file: string, text: string): SettingsIssue[] {
  const issues = new Map<string, SettingsIssue>();
  const add = (index: number, kind: SettingsIssue["kind"], entry: string) =>
    issues.set(`${index}:${kind}`, { file, line: lineOf(text, index), kind, entry: clip(entry) });

  for (const m of text.matchAll(/\bhostname\s*:\s*(["'`])([^"'`]*)\1/g))
    if (wideHost(m[2] ?? "")) add(m.index, "wide", m[0]);

  for (const m of text.matchAll(/\b(?:domains|allowedDomains)\s*:\s*\[([^\]]*)\]/g)) {
    const inner = m[1] ?? "";
    const base = m.index + m[0].indexOf("[") + 1;
    for (const s of inner.matchAll(/(["'`])([^"'`]*)\1/g))
      if (wideHost(s[2] ?? "")) add(base + s.index, "wide", `domains: ${s[0]}`);
  }

  for (const m of text.matchAll(/\bremotePatterns\s*:\s*\[/g)) {
    const open = m.index + m[0].length - 1;
    const segment = text.slice(open, closeOf(text, open));
    for (const o of segment.matchAll(/\{[^{}]*\}/g))
      if (!/\bhostname\b/.test(o[0])) add(open + o.index, "wide", `remotePattern ${o[0]}`);
  }

  for (const m of text.matchAll(/\bremote_images\s*=\s*\[([^\]]*)\]/g)) {
    const base = m.index + m[0].indexOf("[") + 1;
    for (const s of (m[1] ?? "").matchAll(/(["'])((?:\\.|(?!\1).)*)\1/g)) {
      const expr = s[2] ?? "";
      const core = expr.replace(/^\^/, "").replace(/\$$/, "");
      if (/^(?:https\??:\/\/)?\.[*+]$/.test(core)) add(base + s.index, "wide", s[0]);
      else if (!expr.startsWith("^") || !expr.endsWith("$"))
        add(base + s.index, "unanchored", s[0]);
    }
  }
  return [...issues.values()].sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
}
