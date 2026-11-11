import { registrableOf } from "../renewals/suffix.js";
import type { PageSnapshot } from "../snapshot.js";

/** One header's directives: name -> its values, in the order sent. A header with no names uses "". */
export type Directives = Record<string, string[]>;

/**
 * What a run remembers about a page's scripts and security headers, for the next run to compare with
 * (the PCI DSS 11.6.1 idea: know what the page loads and what protects it, and notice a change).
 * Hosts, paths without a query string, whether the tag has an integrity attribute, and header
 * names with their directive lists: never page text, query strings, nonces or keys.
 */
export interface ScriptBaseline {
  /** "host/path" of each third-party script -> whether every tag for it has an integrity attribute. */
  scripts: Record<string, { sri: boolean }>;
  /** Lower-case header name -> its directives. Only the headers in SECURITY_HEADERS are kept. */
  headers: Record<string, Directives>;
}

export const SECURITY_HEADERS: readonly string[] = Object.freeze([
  "content-security-policy",
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
]);

/** The most third-party scripts, directives and values kept, and the longest path or value. */
export const BASELINE_LIMITS = Object.freeze({
  scripts: 200,
  directives: 60,
  values: 100,
  text: 160,
});

/** A nonce or a hash: it changes with every page or build, so it is kept as this one word. */
export const NONCE_OR_HASH = "'nonce-or-hash'";

/** A record with no prototype, so a directive named "constructor" or "__proto__" is only a name. */
export function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** An own value of a record read from a file, never one inherited from Object.prototype. */
export function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

const printable = (s: string) =>
  // eslint-disable-next-line no-control-regex -- control characters are removed on purpose
  s.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, BASELINE_LIMITS.text);

/** The site a host belongs to: its registrable domain, or the host itself when it has none. */
function siteOfHost(host: string): string {
  const r = registrableOf(host);
  return r.kind === "domain" ? r.domain : r.kind === "platform" ? r.host : host;
}

/** "host/path" of a script address, or undefined when it is not a third-party http(s) script. */
export function thirdPartyKey(src: string, pageUrl: string): string | undefined {
  try {
    const u = new URL(src);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    const page = new URL(pageUrl);
    if (siteOfHost(u.hostname.toLowerCase()) === siteOfHost(page.hostname.toLowerCase()))
      return undefined;
    return printable(`${u.host.toLowerCase()}${u.pathname}`);
  } catch {
    return undefined;
  }
}

function tokens(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((t) => t !== "")
    .map((t) => printable(t.toLowerCase()))
    .slice(0, BASELINE_LIMITS.values);
}

const collapse = (t: string) => (/^'(?:nonce|sha256|sha384|sha512)-/.test(t) ? NONCE_OR_HASH : t);

/**
 * A Content-Security-Policy as directive -> sources. A nonce or hash becomes one marker. A response
 * with several policies (joined by commas) keeps the first as written and names the others
 * "directive#2", "directive#3", so dropping a second policy reads as those directives going.
 */
export function parseCsp(value: string): Directives {
  const out: Directives = dict();
  value.split(",").forEach((policy, i) => {
    for (const part of policy.split(";")) {
      const [name, ...rest] = tokens(part);
      if (name === undefined || Object.keys(out).length >= BASELINE_LIMITS.directives) continue;
      const key = i === 0 ? name : `${name}#${i + 1}`;
      if (key in out) continue;
      out[key] = [...new Set(rest.map(collapse))];
    }
  });
  return out;
}

/** Strict-Transport-Security: "max-age=63072000; includeSubDomains" -> { max-age: [63072000], includesubdomains: [] }. */
export function parseHsts(value: string): Directives {
  const out: Directives = dict();
  for (const part of value.split(";")) {
    const [name, ...rest] = printable(part.trim().toLowerCase()).split("=");
    if (name && !(name.trim() in out))
      out[name.trim()] = rest.join("=") ? [rest.join("=").trim()] : [];
  }
  return out;
}

/** Permissions-Policy: "camera=(), geolocation=(self "https://x.example")" -> camera: [], geolocation: [self, https://x.example]. */
export function parsePermissions(value: string): Directives {
  const out: Directives = dict();
  for (const part of value.split(/,(?![^(]*\))/)) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = printable(part.slice(0, eq).trim().toLowerCase());
    const list = part
      .slice(eq + 1)
      .replace(/[()"]/g, " ")
      .replace(/\s+/g, " ");
    if (name && !(name in out) && Object.keys(out).length < BASELINE_LIMITS.directives)
      out[name] = tokens(list);
  }
  return out;
}

/** A header whose value is a short list of words (nosniff, DENY, strict-origin-when-cross-origin). */
function parseWords(value: string): Directives {
  return {
    "": value
      .split(",")
      .map((w) => printable(w.trim().toLowerCase()))
      .filter((w) => w !== "")
      .slice(0, BASELINE_LIMITS.values),
  };
}

export function parseHeader(name: string, value: string): Directives {
  if (name === "content-security-policy") return parseCsp(value);
  if (name === "strict-transport-security") return parseHsts(value);
  if (name === "permissions-policy") return parsePermissions(value);
  return parseWords(value);
}

/** The inventory of one page: its third-party scripts and the security headers of its final response. */
export function buildBaseline(page: PageSnapshot): ScriptBaseline {
  const scripts: ScriptBaseline["scripts"] = dict();
  for (const tag of page.scriptTags ?? []) {
    if (tag.src === undefined) continue;
    const key = thirdPartyKey(tag.src, page.finalUrl);
    if (key === undefined) continue;
    const sri = tag.integrity === true;
    if (key in scripts) {
      // The same file twice: it counts as protected only when every tag is.
      scripts[key] = { sri: (scripts[key]?.sri ?? false) && sri };
    } else if (Object.keys(scripts).length < BASELINE_LIMITS.scripts) {
      scripts[key] = { sri };
    }
  }
  const headers: ScriptBaseline["headers"] = dict();
  const sent = page.hops.at(-1)?.headers ?? {};
  for (const [rawName, value] of Object.entries(sent)) {
    const name = rawName.toLowerCase();
    if (SECURITY_HEADERS.includes(name) && typeof value === "string" && !(name in headers))
      headers[name] = parseHeader(name, value);
  }
  return { scripts, headers };
}

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** A saved baseline, or undefined when the file's value is not one (a hand-edited or older file). */
export function readBaseline(value: unknown): ScriptBaseline | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { scripts?: unknown; headers?: unknown };
  if (typeof v.scripts !== "object" || v.scripts === null) return undefined;
  if (typeof v.headers !== "object" || v.headers === null) return undefined;
  for (const s of Object.values(v.scripts)) {
    if (typeof s !== "object" || s === null || typeof (s as { sri?: unknown }).sri !== "boolean")
      return undefined;
  }
  for (const h of Object.values(v.headers)) {
    if (typeof h !== "object" || h === null) return undefined;
    if (!Object.values(h).every(isStrings)) return undefined;
  }
  return value as ScriptBaseline;
}
