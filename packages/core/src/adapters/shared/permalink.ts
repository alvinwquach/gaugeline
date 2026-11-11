/**
 * Where an item of a content folder lives on the site: a pattern per folder, filled in from the file's
 * path, its front matter and its date. One pattern language covers the static site generators Gaugeline
 * reads. A token is written `{slug}` or, as Hugo and Jekyll write it, `:slug`. Nothing is made up: an
 * item that lacks a value its pattern needs gets no address.
 */

/** Every token, with where its value comes from. docs/integrations/git-content.md lists them; a test keeps the two in step. */
export const PERMALINK_TOKENS = {
  slug: "the `slug` field, or the file name without its extension and any `YYYY-MM-DD-` prefix",
  slugorfilename: "the same as `slug` (Hugo's name for it)",
  id: "the file's path from the repository root, with its extension",
  path: "the file's path inside its folder without the extension (Astro's entry id, Nuxt Content's route); `index` files give their folder",
  nuxt_path: "`path` with Nuxt Content's ordering prefixes (`1.`) dropped from each part",
  filename: "the file name without its extension (Hugo's `:filename`)",
  title: "the file name without its extension and `YYYY-MM-DD-` prefix (Jekyll's `:title`)",
  section: "the last part of the folder's `dir` (Hugo's section)",
  year: "four digits, from the file name's date (Jekyll) or else the publish date",
  month: "two digits, as `year`",
  day: "two digits, as `year`",
  categories:
    "the `categories` or `category` field, joined with `/` (Jekyll); empty when there are none",
  output_ext: "`.html` (Jekyll's `date` style)",
} as const;

export type PermalinkToken = keyof typeof PERMALINK_TOKENS;

const TOKEN_NAMES = new Set<string>(Object.keys(PERMALINK_TOKENS));
const TOKEN = /\{([a-z_]+)\}|:([a-z_]+)/g;
/** Tokens whose value may be empty without the address being unknown. */
const MAY_BE_EMPTY = new Set<string>(["categories", "output_ext"]);

/** Jekyll's built-in permalink styles, which a folder may name instead of a pattern. */
export const JEKYLL_STYLES: Readonly<Record<string, string>> = {
  date: "/:categories/:year/:month/:day/:title:output_ext",
  pretty: "/:categories/:year/:month/:day/:title/",
  none: "/:categories/:title:output_ext",
};

/** The pattern a folder's setting means: a Jekyll style name becomes its pattern. */
export function patternOf(setting: string): string {
  return JEKYLL_STYLES[setting] ?? setting;
}

/**
 * Is this a pattern a settings file may hold: a path starting with "/" or an https address, made of
 * letters, digits and `/ _ . ~ % -`, with only known tokens. Why: the value is placed in a report as the
 * item's address, and nothing in it may be anything but an address.
 */
export function isPermalinkPattern(setting: string): boolean {
  const text = patternOf(setting);
  if (!(text.startsWith("/") || text.startsWith("https://")) || text.startsWith("//")) return false;
  let unknown = false;
  const rest = text.replace(TOKEN, (_m, a: string | undefined, b: string | undefined) => {
    if (!TOKEN_NAMES.has(a ?? b ?? "")) unknown = true;
    return "";
  });
  return !unknown && /^[A-Za-z0-9/_.~%:-]*$/.test(rest.replace(/^https:\/\//, ""));
}

/** What a pattern is filled from. A token with no value is left undefined. */
export type PermalinkValues = Partial<Record<PermalinkToken, string>>;

/** Percent-encodes a value part by part. Throws a URIError for a lone surrogate: a caller that reads files catches it per item. */
const encodeParts = (value: string): string => value.split("/").map(encodeURIComponent).join("/");

/** A `slug` field: 1 to 128 URL-safe characters, as the other adapters take it. */
export const SLUG = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

/**
 * The address for a pattern, or "" when a token it needs has no value or the result has a `.` or `..`
 * part. Values are percent-encoded part by part, and empty parts are folded away ("/a//b" is "/a/b").
 */
export function expandPermalink(setting: string, values: PermalinkValues): string {
  const pattern = patternOf(setting);
  let missing = false;
  const filled = pattern.replace(TOKEN, (_m, a: string | undefined, b: string | undefined) => {
    const name = (a ?? b ?? "") as PermalinkToken;
    const value = values[name];
    if (value === undefined || (value === "" && !MAY_BE_EMPTY.has(name))) {
      missing = true;
      return "";
    }
    return encodeParts(value);
  });
  if (missing) return "";
  const scheme = filled.startsWith("https://") ? "https://" : "";
  const body = filled.slice(scheme.length);
  const trailing = body.endsWith("/") && body.length > 1;
  const parts = body.split("/").filter((p) => p !== "");
  if (parts.some((p) => p === "." || p === "..")) return "";
  return (
    scheme +
    (scheme === "" ? "/" : "") +
    parts.join("/") +
    (trailing && parts.length > 0 ? "/" : "")
  );
}

/**
 * An address the front matter itself gives (Hugo's `url`, Jekyll's and Eleventy's `permalink`): used
 * only when it is a path on this site, starting with a single "/" (never "//", a backslash, a scheme or
 * a host: front matter is data, and it must not send a report to another site). A template (double
 * curly braces) cannot be run without the generator, so it is not used and the folder's pattern applies.
 */
export function addressFromFrontMatter(
  value: unknown,
  values: PermalinkValues,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text === "" || text.includes("{{") || text.includes("{%")) return undefined;
  const pattern = patternOf(text);
  if (!pattern.startsWith("/") || pattern.startsWith("//") || pattern.includes("\\"))
    return undefined;
  if (!isPermalinkPattern(pattern)) return undefined;
  const out = expandPermalink(pattern, values);
  return out === "" ? undefined : out;
}

const EXT = /\.(?:mdx?|markdown|json|ya?ml)$/i;
const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})-(.+)$/;

export interface FileNames {
  /** The path inside the folder without extension; an `index` file gives its folder. */
  path: string;
  filename: string;
  /** The file name without a date prefix. */
  title: string;
  date?: { year: string; month: string; day: string };
}

/** The parts of a file's path inside its folder that the tokens use. */
export function namesOf(pathInFolder: string): FileNames {
  const segments = pathInFolder.replace(EXT, "").split("/");
  const last = segments.at(-1) ?? "";
  const bundle = last === "index" && segments.length > 1;
  const path = (bundle ? segments.slice(0, -1) : segments).join("/");
  const filename = bundle ? (segments.at(-2) ?? last) : last;
  const dated = DATE_PREFIX.exec(filename);
  return {
    path,
    filename,
    title: dated ? (dated[4] ?? filename) : filename,
    ...(dated
      ? { date: { year: dated[1] ?? "", month: dated[2] ?? "", day: dated[3] ?? "" } }
      : {}),
  };
}

/** Nuxt Content's ordering prefix: `1.` or `01.` before a name. */
export const nuxtPath = (path: string): string =>
  path
    .split("/")
    .map((p) => p.replace(/^\d+\.(?=\D)/, ""))
    .join("/");
