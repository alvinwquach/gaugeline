import { parse as parseYaml } from "yaml";

/**
 * Reading one content file in a repository: the front matter of a Markdown or MDX file, or the records of
 * a JSON or YAML file. Pure functions over text. A reason given for a file that cannot be read never
 * quotes the file: it names the problem and, for YAML, the line.
 */

export type FileKind = "markdown" | "json" | "yaml";

const EXTENSIONS: Readonly<Record<string, FileKind>> = {
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
};

/** The extensions a content folder is read for. */
export const CONTENT_EXTENSIONS: readonly string[] = Object.keys(EXTENSIONS);

/** The kind of a file from its name, or undefined when it is not a content file. */
export function kindOf(path: string): FileKind | undefined {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : EXTENSIONS[path.slice(dot).toLowerCase()];
}

export type Parsed =
  { ok: true; records: Record<string, unknown>[]; list: boolean } | { ok: false; reason: string };

/** Aliases are how a YAML bomb grows; a front matter block has no use for more than a few. */
const MAX_ALIASES = 20;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** YAML to a value, or a reason that names the error code and line and nothing from the text. */
function yamlOf(
  text: string,
  lineOffset: number,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    const value: unknown = parseYaml(text, { maxAliasCount: MAX_ALIASES, logLevel: "error" });
    return { ok: true, value };
  } catch (err) {
    const e = err as { code?: unknown; linePos?: Array<{ line?: unknown }> };
    const line = e.linePos?.[0]?.line;
    const where = typeof line === "number" ? ` at line ${line + lineOffset}` : "";
    const code = typeof e.code === "string" ? ` (${e.code})` : "";
    return { ok: false, reason: `not valid YAML${code}${where}` };
  }
}

/** The front matter block of a Markdown file as text, with the number of lines before it. */
function frontMatterOf(text: string): { block: string } | { none: true } | { unread: string } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = src.split(/\r?\n/, 4096);
  const first = (lines[0] ?? "").trimEnd();
  if (first === "+++") return { unread: "has TOML front matter (+++), which is not read yet" };
  if (first !== "---") return { none: true };
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").trimEnd();
    if (line === "---" || line === "...") return { block: lines.slice(1, i).join("\n") };
  }
  return { unread: "has front matter that is never closed with ---" };
}

/** A Markdown or MDX file: its front matter as one record. The body is never kept. A file with none is one record with no fields. */
function parseMarkdown(text: string): Parsed {
  const found = frontMatterOf(text);
  if ("unread" in found) return { ok: false, reason: found.unread };
  if ("none" in found) return { ok: true, records: [{}], list: false };
  const yaml = yamlOf(found.block, 1);
  if (!yaml.ok) return { ok: false, reason: `front matter is ${yaml.reason}` };
  if (yaml.value === null || yaml.value === undefined)
    return { ok: true, records: [{}], list: false };
  if (!isRecord(yaml.value)) return { ok: false, reason: "front matter is not a set of fields" };
  return { ok: true, records: [yaml.value], list: false };
}

/** A JSON or YAML file: one record, or a list of records (a collection kept in one file). */
function parseData(text: string, kind: "json" | "yaml"): Parsed {
  let value: unknown;
  if (kind === "json") {
    try {
      value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      return { ok: false, reason: "is not valid JSON" };
    }
  } else {
    const yaml = yamlOf(text, 0);
    if (!yaml.ok) return { ok: false, reason: `is ${yaml.reason}` };
    value = yaml.value;
  }
  if (isRecord(value)) return { ok: true, records: [value], list: false };
  if (Array.isArray(value) && value.every(isRecord))
    return { ok: true, records: value, list: true };
  return { ok: false, reason: "is not a record or a list of records" };
}

export function parseContent(text: string, kind: FileKind): Parsed {
  return kind === "markdown" ? parseMarkdown(text) : parseData(text, kind);
}

/** A field's value by name; a dotted name goes into objects. Only own properties are followed. */
export function valueAt(data: Record<string, unknown>, path: string): unknown {
  if (Object.hasOwn(data, path)) return data[path];
  let at: unknown = data;
  for (const part of path.split(".")) {
    if (!isRecord(at) || !Object.hasOwn(at, part)) return undefined;
    at = at[part];
  }
  return at;
}

/** A field counts as present when it has a value: not missing, null, an empty string, an empty list or an empty object. */
export function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (isRecord(v)) return Object.keys(v).length > 0;
  return true;
}

/** An ISO 8601 UTC time from a value front matter holds, or undefined. A time with no zone is UTC, as a site's build sees it. */
export function isoOf(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text === "") return undefined;
  const bare = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text);
  const ms = Date.parse(bare ? `${text.replace(" ", "T")}Z` : text);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

const firstTime = (data: Record<string, unknown>, names: readonly string[]): string | undefined => {
  for (const name of names) {
    const t = isoOf(data[name]);
    if (t !== undefined) return t;
  }
  return undefined;
};

/** The front matter names that say when an item was published, in the order they are tried. */
export const PUBLISHED_FIELDS = [
  "publishDate",
  "publishedAt",
  "pubDate",
  "datePublished",
  "date",
] as const;
/** The names that say when an item was last changed. */
export const UPDATED_FIELDS = [
  "lastmod",
  "updatedDate",
  "updatedAt",
  "updated",
  "dateModified",
  "modified",
  "lastUpdated",
] as const;
/** The names that say when an item stops being published (Hugo's expiryDate and its aliases). */
export const EXPIRY_FIELDS = ["expiryDate", "expirydate", "unpublishDate"] as const;

const isTrue = (v: unknown): boolean =>
  v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");
const isFalse = (v: unknown): boolean =>
  v === false || (typeof v === "string" && v.trim().toLowerCase() === "false");

export interface ItemState {
  published: boolean;
  publishedAt?: string;
  /** From the updated fields; with none, the published time. Never a file's modification time. */
  updatedAt?: string;
}

/**
 * Whether the front matter says an item is live at `now` (ms):
 * - `draft: true` is not published (Hugo, Astro, Eleventy, Nuxt Content, Decap, Keystatic);
 * - `published: false` is not published (Jekyll);
 * - `permalink: false` is not written to the site at all (Eleventy);
 * - a publish date after `now` is scheduled, not live (Hugo and Jekyll both leave it out of the build);
 * - an expiry date at or before `now` has expired (Hugo).
 */
export function stateOf(data: Record<string, unknown>, now: number): ItemState {
  const publishedAt = firstTime(data, PUBLISHED_FIELDS);
  const updatedAt = firstTime(data, UPDATED_FIELDS) ?? publishedAt;
  const expires = firstTime(data, EXPIRY_FIELDS);
  const live =
    !isTrue(data.draft) &&
    !isFalse(data.published) &&
    data.permalink !== false &&
    (publishedAt === undefined || Date.parse(publishedAt) <= now) &&
    (expires === undefined || Date.parse(expires) > now);
  return {
    published: live,
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}
