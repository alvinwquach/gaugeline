/**
 * Source maps, read from the outside. Pure functions over text, linear in its length, and none of
 * them keeps a character of a map's content: a source map holds the original source, so only
 * counts and a size class ever leave this file.
 */

/** What a file says about its map: an address, an inline data: map (counted, never decoded), or nothing usable. */
export type MapReference = { kind: "url"; ref: string } | { kind: "inline"; bytes: number };

/** Longest address read from a comment; anything longer is not a map address. */
const MAX_REF = 2048;
const COMMENT_STARTS = ["//# ", "//@ ", "/*# ", "/*@ "];
const NAME = "sourceMappingURL=";

/**
 * The file's own `sourceMappingURL` comment (`//# ...` in JavaScript, `/*# ... *\/` in CSS), the
 * last one, since that is the one a browser follows. Text that only mentions the name is not one.
 */
export function mapReference(text: string): MapReference | undefined {
  const at = text.lastIndexOf(NAME);
  if (at < 4 || !COMMENT_STARTS.includes(text.slice(at - 4, at))) return undefined;
  const start = at + NAME.length;
  const newline = text.indexOf("\n", start);
  let ref = text.slice(start, newline < 0 ? text.length : newline);
  const close = ref.indexOf("*/");
  if (close >= 0) ref = ref.slice(0, close);
  ref = ref.trim();
  if (/^data:/i.test(ref))
    return { kind: "inline", bytes: Math.floor(((ref.length - ref.indexOf(",") - 1) * 3) / 4) };
  return { kind: "url", ref: ref.slice(0, MAX_REF + 1) };
}

/** A lone surrogate or a control character: a value no real build writes. */
function unreadable(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/**
 * The address to ask for a reference found in `fileUrl`, resolved against it. Only http(s) on the
 * file's own origin is asked: another origin is `cross-origin`, and an empty, over-long or
 * unreadable value, or any other scheme (javascript:, file:, data:), is `unsupported`.
 */
export function resolveMapAddress(
  ref: string,
  fileUrl: string,
): { url: string } | { skip: "cross-origin" | "unsupported" } {
  if (ref === "" || ref.length > MAX_REF || unreadable(ref)) return { skip: "unsupported" };
  let url: URL;
  try {
    url = new URL(ref, fileUrl);
  } catch {
    return { skip: "unsupported" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { skip: "unsupported" };
  if (url.origin !== new URL(fileUrl).origin) return { skip: "cross-origin" };
  url.hash = "";
  return { url: url.href };
}

export type SizeClass = "none" | "small" | "medium" | "large";

export interface MapSummary {
  version: number;
  /** Entries in `sources` (an index map has none of its own: 0). */
  sources: number;
  /** `sourcesContent` is present with at least one string: the original code is in the map. */
  withContent: boolean;
  /** Characters of original code in the map. Only its class is shown. */
  contentBytes: number;
  sizeClass: SizeClass;
}

/** Original code under 100 KB is small, under 1 MB medium, anything more large. Integers. */
function classOf(bytes: number): SizeClass {
  if (bytes === 0) return "none";
  if (bytes < 100_000) return "small";
  return bytes < 1_000_000 ? "medium" : "large";
}

/**
 * Whether `text` parses as a version 3 source map (ECMA-426: a `version` of 3 and either `sources`
 * or, for an index map, `sections`), and the counts about it. The XSSI guard `)]}'` the spec allows
 * is skipped. A page that answers 200 for every address, a truncated map or any other text is
 * `undefined`. Only own properties are read, so a `__proto__` key changes nothing.
 */
export function readSourceMap(text: string): MapSummary | undefined {
  const body = text.startsWith(")]}'") ? text.slice(text.indexOf("\n") + 1) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const own = (key: string): unknown =>
    Object.hasOwn(parsed as object, key) ? (parsed as Record<string, unknown>)[key] : undefined;
  if (own("version") !== 3) return undefined;
  const sources = own("sources");
  if (!Array.isArray(sources) && !Array.isArray(own("sections"))) return undefined;
  const contents = own("sourcesContent");
  let contentBytes = 0;
  let withContent = false;
  if (Array.isArray(contents))
    for (const c of contents)
      if (typeof c === "string") {
        withContent = true;
        contentBytes += c.length;
      }
  return {
    version: 3,
    sources: Array.isArray(sources) ? sources.length : 0,
    withContent,
    contentBytes,
    sizeClass: withContent ? classOf(Math.max(contentBytes, 1)) : "none",
  };
}
