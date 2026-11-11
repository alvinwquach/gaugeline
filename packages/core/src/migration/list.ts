import { load } from "cheerio/slim";
import { ConfigError } from "../errors.js";
import { normaliseHeader, parseCsv } from "../plan/columns.js";

/**
 * The old site's content list: what was published there, as paths. Whatever the source (the WordPress
 * REST API, a Wix or Webflow export, the old site's sitemap), each item is a path on the old site and,
 * when the source says so, the title it had. The list is data: it is read, never run, and a title
 * from it is only ever compared and printed as text.
 */
export interface OldItem {
  /** The address's path, never with a query or a fragment. "/" is the home page. */
  path: string;
  /** The title the source gives (a WordPress post's title, an export's title column). */
  title?: string;
  /** "post" or "page" for WordPress; absent elsewhere. */
  kind?: string;
}

export type ListSource = "wordpress" | "sitemap" | "links" | "file";

export interface OldList {
  source: ListSource;
  /** Deduplicated by path, in the order the source gave them, cut at the cap. */
  items: OldItem[];
  /** How many the source listed before the cap. */
  total: number;
  /** Addresses left out because their path alone does not name a page (a query string). */
  skipped: number;
  /** One short sentence per thing worth saying about how the list was read. */
  notes: string[];
}

/** The most items one run checks. Each one is up to two requests, so this is the run's size too. */
export const MIGRATION_ITEM_CAP = 500;

/** The path of an address written as a URL or as a path, or why it names no page. */
export function itemPath(address: string): { path: string } | { skip: string } {
  const text = address.trim();
  if (text === "") return { skip: "empty" };
  let url: URL;
  try {
    url = new URL(text, "https://old.invalid");
  } catch {
    return { skip: "not an address" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { skip: "not a web address" };
  if (url.search !== "") return { skip: "a query string" };
  return { path: url.pathname === "" ? "/" : url.pathname };
}

/** Add items one by one: a path once, up to the cap, counting what the source listed. */
export class ListBuilder {
  readonly items: OldItem[] = [];
  readonly #seen = new Set<string>();
  total = 0;
  skipped = 0;
  readonly #skips = new Map<string, number>();
  add(address: string, title?: string, kind?: string): void {
    const got = itemPath(address);
    if ("skip" in got) {
      this.skip(got.skip);
      return;
    }
    if (this.#seen.has(got.path)) return;
    this.#seen.add(got.path);
    this.total += 1;
    if (this.items.length < MIGRATION_ITEM_CAP)
      this.items.push({
        path: got.path,
        ...(title !== undefined && title !== "" ? { title } : {}),
        ...(kind !== undefined ? { kind } : {}),
      });
  }
  /** Count an address that was left out, and why. */
  skip(why: string): void {
    this.skipped += 1;
    this.#skips.set(why, (this.#skips.get(why) ?? 0) + 1);
  }
  /** The list, with a note for the cap and for what was left out. */
  done(source: ListSource, notes: string[] = []): OldList {
    const out = [...notes];
    if (this.total > this.items.length)
      out.push(
        `The list has ${this.total} items; the first ${this.items.length} were checked. Run again on the rest with a shorter list.`,
      );
    if (this.skipped > 0)
      out.push(
        `${this.skipped} ${this.skipped === 1 ? "address was" : "addresses were"} left out: ${[
          ...this.#skips,
        ]
          .map(([why, n]) => `${n} with ${why === "empty" ? "no address" : why}`)
          .join(", ")}.`,
      );
    return {
      source,
      items: this.items,
      total: this.total,
      skipped: this.skipped,
      notes: out,
    };
  }
}

/** A WordPress title is HTML (title.rendered): its text, entities decoded, never its markup. */
export function plainText(html: string): string {
  return load(`<i>${html}</i>`, null, false)("i").text().replace(/\s+/g, " ").trim();
}

/**
 * One page of the WordPress REST API's list of posts or pages: an array of objects with a link and a
 * title. Undefined when the body is not that (a theme's 404 page, an error object). An item that is not
 * published is left out, though the API only lists published ones to a visitor with no key.
 */
export function parseWordPress(
  body: string,
): { link: string; title: string; type?: string }[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!Array.isArray(data)) return undefined;
  const out: { link: string; title: string; type?: string }[] = [];
  for (const row of data) {
    if (row === null || typeof row !== "object") return undefined;
    const r = row as Record<string, unknown>;
    if (typeof r.link !== "string") return undefined;
    if (typeof r.status === "string" && r.status !== "publish") continue;
    const rendered =
      typeof r.title === "string"
        ? r.title
        : r.title !== null && typeof r.title === "object"
          ? (r.title as Record<string, unknown>).rendered
          : undefined;
    out.push({
      link: r.link,
      title: typeof rendered === "string" ? plainText(rendered) : "",
      ...(typeof r.type === "string" ? { type: r.type } : {}),
    });
  }
  return out;
}

const URL_COLUMNS = new Set([
  "url",
  "link",
  "permalink",
  "path",
  "address",
  "page url",
  "full url",
  "old url",
  "live url",
]);
const TITLE_COLUMNS = new Set(["title", "name", "post title", "page title", "title tag"]);

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim();
  if (value !== null && typeof value === "object") {
    const r = (value as Record<string, unknown>).rendered;
    if (typeof r === "string") return plainText(r);
  }
  return undefined;
}

/** The first value under a key whose normalised name is in `names`, looking one level into fieldData. */
function pick(row: Record<string, unknown>, names: ReadonlySet<string>): string | undefined {
  for (const scope of [row, row.fieldData]) {
    if (scope === null || typeof scope !== "object") continue;
    for (const [key, value] of Object.entries(scope as Record<string, unknown>)) {
      if (!names.has(normaliseHeader(key))) continue;
      const text = textOf(value);
      if (text !== undefined && text !== "") return text;
    }
  }
  return undefined;
}

/**
 * A Wix, Webflow or other export, read from a file: JSON (an array, or an object holding one under
 * items, posts, pages, data or results) or CSV with a header row. A row needs an address or a path in a
 * column named url, link, permalink, path or address; a title column (title, name, post title, page
 * title) is used when there is one. Nothing is requested.
 */
export function readExportFile(text: string): OldList {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  const rows: { url?: string; title?: string }[] = [];
  let sawColumn = false;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch (err) {
      throw new ConfigError(`The export is not valid JSON: ${(err as Error).message}`, {
        hint: "Export the list again from Wix or Webflow as CSV or JSON.",
      });
    }
    let list: unknown = data;
    if (!Array.isArray(data) && data !== null && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      list = ["items", "posts", "pages", "data", "results"].map((k) => obj[k]).find(Array.isArray);
    }
    if (!Array.isArray(list))
      throw new ConfigError("The export has no list of items in it.", {
        hint: "It should be an array of items, or an object with the array under items, posts or pages.",
      });
    for (const row of list) {
      if (row === null || typeof row !== "object") continue;
      const url = pick(row as Record<string, unknown>, URL_COLUMNS);
      const title = pick(row as Record<string, unknown>, TITLE_COLUMNS);
      if (url !== undefined) sawColumn = true;
      rows.push({
        ...(url !== undefined ? { url } : {}),
        ...(title !== undefined ? { title } : {}),
      });
    }
  } else {
    const records = parseCsv(trimmed);
    const header = (records[0]?.cells ?? []).map(normaliseHeader);
    const urlAt = header.findIndex((h) => URL_COLUMNS.has(h));
    const titleAt = header.findIndex((h) => TITLE_COLUMNS.has(h));
    if (urlAt < 0)
      throw new ConfigError("The export has no column with each page's address or path.", {
        hint: "Add a column named url or path (for Webflow, the collection's folder plus the Slug), then run again.",
      });
    sawColumn = true;
    for (const rec of records.slice(1)) {
      const url = (rec.cells[urlAt] ?? "").trim();
      const title = titleAt >= 0 ? (rec.cells[titleAt] ?? "").trim() : "";
      rows.push({ ...(url !== "" ? { url } : {}), ...(title !== "" ? { title } : {}) });
    }
  }
  if (!sawColumn)
    throw new ConfigError("No item in the export has an address or a path.", {
      hint: "Each item needs a url, link, permalink or path; a slug alone does not say which folder the page is in.",
    });
  const list = new ListBuilder();
  for (const row of rows) {
    if (row.url === undefined) list.skip("empty");
    else list.add(row.url, row.title);
  }
  return list.done("file");
}
