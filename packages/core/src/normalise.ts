/**
 * The comparisons almost every check makes: is this the same address, is this the same text.
 * Pure functions over the WHATWG URL class and String.prototype.normalize. One answer everywhere.
 * The corpus in __tests__/corpus/normalise.corpus.ts pins the behaviour.
 */

/**
 * Lowercase scheme and host (IDN hosts become punycode), drop the default port and the fragment,
 * keep the query and the trailing slash as they are. A relative input resolves against `base`.
 */
export function normaliseUrl(input: string, base?: string): string {
  const url = base === undefined ? new URL(input.trim()) : new URL(input.trim(), base);
  url.hash = "";
  return url.href;
}

export interface CompareOptions {
  /** Is www.example.com the same host as example.com? Default "distinct". */
  www?: "distinct" | "same";
  /** Is /a/ the same path as /a? Default "same". */
  trailingSlash?: "distinct" | "same";
  /** Does the query count? Default "distinct". */
  query?: "distinct" | "ignore";
}

export type AddressDifference =
  "scheme" | "www" | "host" | "port" | "path-case" | "trailing-slash" | "path" | "query";

export type AddressComparison = { same: true } | { same: false; differsBy: AddressDifference[] };

function tryUrl(input: string): URL | undefined {
  try {
    return new URL(input.trim());
  } catch {
    return undefined;
  }
}

const WEB = new Set(["http:", "https:"]);

function stripOneWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

/** Percent-encoding hex digits compare case-insensitively (%2f is %2F). */
function upperPercent(path: string): string {
  return path.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
}

function stripSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Never throws. A bad address is "not the same", differing by host. */
export function compareAddresses(
  a: string,
  b: string,
  opts: CompareOptions = {},
): AddressComparison {
  const www = opts.www ?? "distinct";
  const trailingSlash = opts.trailingSlash ?? "same";
  const query = opts.query ?? "distinct";
  const ua = tryUrl(a);
  const ub = tryUrl(b);
  if (!ua || !ub) return { same: false, differsBy: ["host"] };

  const differsBy: AddressDifference[] = [];
  if (ua.protocol !== ub.protocol) differsBy.push("scheme");
  if (!WEB.has(ua.protocol) || !WEB.has(ub.protocol)) {
    if (differsBy.length === 0 && ua.href !== ub.href) differsBy.push("scheme");
    return differsBy.length === 0 ? { same: true } : { same: false, differsBy: ["scheme"] };
  }

  const ha = ua.hostname;
  const hb = ub.hostname;
  const userinfoDiffers = ua.username !== ub.username || ua.password !== ub.password;
  if (ha !== hb) {
    if (stripOneWww(ha) === hb || ha === stripOneWww(hb)) {
      if (www === "distinct") differsBy.push("www");
    } else {
      differsBy.push("host");
    }
  } else if (userinfoDiffers) {
    differsBy.push("host");
  }
  if (ua.port !== ub.port) differsBy.push("port");

  const pa = upperPercent(ua.pathname);
  const pb = upperPercent(ub.pathname);
  if (pa !== pb) {
    const slashDiffers =
      pa.endsWith("/") !== pb.endsWith("/") && (stripSlash(pa) !== pa) !== (stripSlash(pb) !== pb);
    const na = stripSlash(pa);
    const nb = stripSlash(pb);
    if (na === nb) {
      if (trailingSlash === "distinct") differsBy.push("trailing-slash");
    } else if (na.toLowerCase() === nb.toLowerCase()) {
      differsBy.push("path-case");
      if (slashDiffers && trailingSlash === "distinct") differsBy.push("trailing-slash");
    } else {
      differsBy.push("path");
    }
  }
  if (query === "distinct" && ua.search !== ub.search) differsBy.push("query");
  return differsBy.length === 0 ? { same: true } : { same: false, differsBy };
}

const SINGLE_QUOTES = /[\u2018\u2019‚\u201B\u2032\u02BC]/g;
const DOUBLE_QUOTES = /[\u201C\u201D„\u201F\u2033]/g;
const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
const ZERO_WIDTH = /(?:\u200B|\u200C|\u200D|\u2060|\uFEFF)/g;

/**
 * NFC; curly quotes to straight; dashes, minus and non-breaking hyphen to hyphen-minus; Unicode
 * spaces to a space; zero-width characters and BOM removed; whitespace collapsed; trimmed.
 * Case is kept.
 */
export function normaliseText(input: string): string {
  return input
    .normalize("NFC")
    .replace(ZERO_WIDTH, "")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .replace(SPACES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compares normaliseText of each; case-insensitive unless asked. */
export function sameText(a: string, b: string, opts: { caseSensitive?: boolean } = {}): boolean {
  const na = normaliseText(a);
  const nb = normaliseText(b);
  return opts.caseSensitive === true ? na === nb : na.toLowerCase() === nb.toLowerCase();
}
