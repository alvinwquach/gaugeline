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
  /**
   * Where a limit cut the inventory short, so what is past it is not compared. Each is reported as
   * "could not check" by the check it belongs to, never dropped silently. Absent when nothing was cut.
   */
  cut?: Cut[];
}

/** One place the inventory was cut short, and the check that cannot compare what was left out. */
export interface Cut {
  check: "script-changed" | "csp-loosened" | "security-header-loosened";
  reason: string;
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

/**
 * The most third-party scripts, directives, and sources per directive kept, and the longest path or
 * value. A real policy is far below these; a page past one gets a "could not check" naming it.
 */
export const BASELINE_LIMITS = Object.freeze({
  scripts: 200,
  directives: 100,
  values: 500,
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

/** Text from a page or a saved file, as it may be printed: no control characters, cut to a line. */
export const printable = (s: string) =>
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

/** Directives whose value is an address that can carry a key: only that they are set is kept. */
const VALUE_DROPPED = new Set(["report-uri", "report-to"]);

/** A token with no userinfo, query or fragment: a source never has one, and a key could ride in it. */
function bare(token: string): string {
  return printable(
    token
      .replace(/\/\/[^/@\s]*@/, "//")
      .replace(/[?#].*$/, "")
      .toLowerCase(),
  );
}

/** All the tokens of a text, bare. Capping is the caller's, so it can say so. */
function tokens(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((t) => t !== "")
    .map(bare);
}

const collapse = (t: string) => (/^'(?:nonce|sha256|sha384|sha512)-/.test(t) ? NONCE_OR_HASH : t);

/** The first `values` entries, and a note in `cuts` (when the caller wants them) if there were more. */
function capped(list: string[], where: string, check: Cut["check"], cuts?: Cut[]): string[] {
  if (list.length <= BASELINE_LIMITS.values) return list;
  cuts?.push({
    check,
    reason: `${where} has more than ${BASELINE_LIMITS.values} sources: only the first ${BASELINE_LIMITS.values} are compared`,
  });
  return list.slice(0, BASELINE_LIMITS.values);
}

/**
 * A Content-Security-Policy as directive -> sources. A nonce or hash becomes one marker. The value of
 * report-uri and report-to is dropped (a reporting address often carries a key). A response with
 * several policies (joined by commas) keeps the first as written and names the others
 * "directive#2", "directive#3", so dropping a second policy reads as those directives going.
 * What a limit cuts is added to `cuts`.
 */
export function parseCsp(value: string, cuts?: Cut[]): Directives {
  const out: Directives = dict();
  let cutDirectives = false;
  value.split(",").forEach((policy, i) => {
    for (const part of policy.split(";")) {
      const [name, ...rest] = tokens(part);
      if (name === undefined) continue;
      if (Object.keys(out).length >= BASELINE_LIMITS.directives) {
        cutDirectives = true;
        continue;
      }
      const key = i === 0 ? name : `${name}#${i + 1}`;
      if (key in out) continue;
      out[key] = VALUE_DROPPED.has(name)
        ? []
        : capped([...new Set(rest.map(collapse))], key, "csp-loosened", cuts);
    }
  });
  if (cutDirectives)
    cuts?.push({
      check: "csp-loosened",
      reason: `the policy has more than ${BASELINE_LIMITS.directives} directives: only the first ${BASELINE_LIMITS.directives} are compared`,
    });
  return out;
}

/** Strict-Transport-Security: "max-age=63072000; includeSubDomains" -> { max-age: [63072000], includesubdomains: [] }. */
export function parseHsts(value: string): Directives {
  const out: Directives = dict();
  for (const part of value.split(";")) {
    const [name, ...rest] = printable(part.trim().toLowerCase()).split("=");
    // A quoted value (max-age="300") is read as the number inside the quotes.
    const v = rest
      .join("=")
      .trim()
      .replace(/^"(.*)"$/, "$1");
    if (name && !(name.trim() in out)) out[name.trim()] = v ? [bare(v)] : [];
  }
  return out;
}

/** Permissions-Policy: "camera=(), geolocation=(self "https://x.example")" -> camera: [], geolocation: [self, https://x.example]. */
export function parsePermissions(value: string, cuts?: Cut[]): Directives {
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
      out[name] = capped(tokens(list), name, "security-header-loosened", cuts);
  }
  return out;
}

/** A header whose value is a short list of words (nosniff, DENY, strict-origin-when-cross-origin). */
function parseWords(value: string): Directives {
  return {
    "": value
      .split(",")
      .map((w) => bare(w.trim()))
      .filter((w) => w !== "")
      .slice(0, BASELINE_LIMITS.values),
  };
}

export function parseHeader(name: string, value: string, cuts?: Cut[]): Directives {
  if (name === "content-security-policy") return parseCsp(value, cuts);
  if (name === "strict-transport-security") return parseHsts(value);
  if (name === "permissions-policy") return parsePermissions(value, cuts);
  return parseWords(value);
}

/** The inventory of one page: its third-party scripts and the security headers of its final response. */
export function buildBaseline(page: PageSnapshot): ScriptBaseline {
  const scripts: ScriptBaseline["scripts"] = dict();
  let dropped = 0;
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
    } else {
      dropped += 1;
    }
  }
  const cut: Cut[] = [];
  if (dropped > 0)
    cut.push({
      check: "script-changed",
      reason: `${dropped} third-party script${dropped === 1 ? "" : "s"} past the first ${BASELINE_LIMITS.scripts} ${dropped === 1 ? "is" : "are"} not compared`,
    });
  const headers: ScriptBaseline["headers"] = dict();
  const sent = page.hops.at(-1)?.headers ?? {};
  for (const [rawName, value] of Object.entries(sent)) {
    const name = rawName.toLowerCase();
    if (SECURITY_HEADERS.includes(name) && typeof value === "string" && !(name in headers))
      headers[name] = parseHeader(name, value, cut);
  }
  return { scripts, headers, ...(cut.length > 0 ? { cut } : {}) };
}

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** What a saved file may hold before it is not read: well above what buildBaseline writes. */
const READ_LIMITS = Object.freeze({
  scripts: 1000,
  headers: 20,
  directives: 400,
  values: 2000,
  text: 1000,
});

const isCut = (c: unknown): c is Cut =>
  typeof c === "object" &&
  c !== null &&
  ["script-changed", "csp-loosened", "security-header-loosened"].includes((c as Cut).check) &&
  typeof (c as Cut).reason === "string";

/**
 * A saved baseline, or undefined when the file's value is not one: a hand-edited or older file, or
 * one larger than anything buildBaseline writes (it is read from disk and could be anything).
 */
export function readBaseline(value: unknown): ScriptBaseline | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { scripts?: unknown; headers?: unknown; cut?: unknown };
  if (typeof v.scripts !== "object" || v.scripts === null) return undefined;
  if (typeof v.headers !== "object" || v.headers === null) return undefined;
  const scripts = Object.entries(v.scripts);
  const headers = Object.entries(v.headers);
  if (scripts.length > READ_LIMITS.scripts || headers.length > READ_LIMITS.headers)
    return undefined;
  for (const [key, s] of scripts) {
    if (key.length > READ_LIMITS.text) return undefined;
    if (typeof s !== "object" || s === null || typeof (s as { sri?: unknown }).sri !== "boolean")
      return undefined;
  }
  for (const [name, h] of headers) {
    if (name.length > READ_LIMITS.text || typeof h !== "object" || h === null) return undefined;
    const dirs = Object.entries(h);
    if (dirs.length > READ_LIMITS.directives) return undefined;
    for (const [dir, list] of dirs) {
      if (dir.length > READ_LIMITS.text || !isStrings(list) || list.length > READ_LIMITS.values)
        return undefined;
      if (list.some((t) => t.length > READ_LIMITS.text)) return undefined;
    }
  }
  if (v.cut !== undefined && !(Array.isArray(v.cut) && v.cut.length <= 20 && v.cut.every(isCut)))
    return undefined;
  return value as ScriptBaseline;
}
