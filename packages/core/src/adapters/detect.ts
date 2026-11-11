import { load } from "cheerio/slim";
import { ADAPTER_ENTRIES } from "./entries.generated.js";
import type { AdapterDetection, AdapterEntry } from "./entry.js";

/** What a response and its HTML show of the platform behind them. Plain data, so a test can write one by hand. */
export interface AdapterSigns {
  /** The generator meta tag's content, as written. */
  generator?: string;
  /** Hostnames of the files the page loads (scripts, styles, images), lower case, sorted. */
  hosts: readonly string[];
  /** Paths of those files, lower case, sorted. */
  paths: readonly string[];
  /** Response headers, lower-case names. */
  headers: Readonly<Record<string, string>>;
}

/** One platform a page shows signs of, and the sign that said so. */
export interface AdapterSighting {
  /** The adapter id to write in gaugeline.adapters.json. */
  id: string;
  name: string;
  /** One line a person can check by looking at the page: `generator tag "WordPress 6.4.2"`. */
  evidence: string;
}

const LOADS = /\b(stylesheet|preload|icon|modulepreload)\b/i;

/**
 * The signs in one page: the generator tag, and where its scripts, stylesheets, preloads and images come from.
 * A link to another site, or a word in the text, is never a sign. Reads text that was already fetched.
 */
export function signsOf(
  html: string,
  pageUrl: string,
  headers: Readonly<Record<string, string>>,
): AdapterSigns {
  const $ = load(html);
  let generator: string | undefined;
  $("meta[name]").each((_, el) => {
    if (generator === undefined && (el.attribs.name ?? "").toLowerCase() === "generator")
      generator = (el.attribs.content ?? "").trim().slice(0, 100) || undefined;
  });
  const hosts = new Set<string>();
  const paths = new Set<string>();
  $("script[src], link[href], img[src], source[src]").each((_, el) => {
    if (el.tagName === "link" && !LOADS.test(el.attribs.rel ?? "")) return;
    try {
      const u = new URL((el.attribs.src ?? el.attribs.href ?? "").trim(), pageUrl);
      hosts.add(u.hostname.toLowerCase());
      paths.add(u.pathname.toLowerCase());
    } catch {
      // not an address
    }
  });
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ...(generator ? { generator } : {}),
    hosts: [...hosts].sort(),
    paths: [...paths].sort(),
    headers: lower,
  };
}

const hostIn = (host: string, wanted: string): boolean =>
  host === wanted || host.endsWith(`.${wanted}`);

/** The first hint of `detect` that these signs match, as one line of evidence; undefined when none does. */
export function matchDetection(detect: AdapterDetection, signs: AdapterSigns): string | undefined {
  const generator = (signs.generator ?? "").toLowerCase();
  if (generator !== "")
    for (const g of detect.generator ?? [])
      if (generator.startsWith(g)) return `generator tag "${(signs.generator ?? "").trim()}"`;
  for (const wanted of detect.hosts ?? []) {
    const host = signs.hosts.find((h) => hostIn(h, wanted));
    if (host !== undefined) return `files loaded from ${host}`;
  }
  for (const wanted of detect.paths ?? [])
    if (signs.paths.some((p) => p.includes(wanted))) return `files under ${wanted}`;
  for (const [name, fragment] of Object.entries(detect.headers ?? {})) {
    const value = signs.headers[name];
    if (value !== undefined && value.toLowerCase().includes(fragment))
      return `the ${name} response header`;
  }
  return undefined;
}

/**
 * The platforms a page shows signs of, in the order of the entries (which is the order of their files, so the
 * same page gives the same list). Only built entries with a `detect` hint are looked at: a platform with none
 * is never reported. Pure: no request.
 */
export function detectAdapters(
  signs: AdapterSigns,
  entries: readonly AdapterEntry[] = ADAPTER_ENTRIES,
): AdapterSighting[] {
  const out: AdapterSighting[] = [];
  for (const e of entries) {
    if (e.status !== "built" || !e.detect) continue;
    const evidence = matchDetection(e.detect, signs);
    if (evidence !== undefined) out.push({ id: e.id, name: e.name, evidence });
  }
  return out;
}
