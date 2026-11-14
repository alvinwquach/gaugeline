import { load } from "cheerio/slim";
import { escapeInvisible } from "../checks/hidden-text/escape.js";
import type { PageSnapshot } from "../snapshot.js";

/** What a raw reference looks like on a page. */
export type RawRefKind =
  /** The text "[object Object]" where a value should be (visible, or in an address). */
  | "object-object"
  /** A `_ref` key and its id written out in the visible text. */
  | "ref-text"
  /** A `_type` key and a type name written out in the visible text. */
  | "type-text"
  /** A reference in the page's embedded data that was not followed (`_type: "reference"` and a `_ref`). */
  | "data-ref";

export interface RawRef {
  kind: RawRefKind;
  /** A short piece of the page around it, safe to print. */
  snippet: string;
  /** The reference id or type name, when there is one. */
  id?: string;
  /** For embedded data: where in the data it is, like `props.pageProps.author`. */
  where?: string;
}

/** Most places one page reports: a broken template repeats itself, and one example is the point. */
export const MAX_RAW_REFS = 5;

const SNIPPET = 90;
const ID = "[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,118}[A-Za-z0-9])?";
const OBJECT_OBJECT = /\[object(?:\s|%20)Object\]|%5Bobject(?:\s|%20)Object%5D/i;
const REF_TEXT = new RegExp(`["']?_ref["']?\\s*[:=]\\s*["']?(${ID})`);
const TYPE_TEXT = /["']?_type["']?\s*[:=]\s*["']([A-Za-z][A-Za-z0-9_.-]{0,63})["']/;
/** An asset reference (`image-<id>-800x600-jpg`, `file-<id>-pdf`) is how Sanity stores a picture or a file: it is meant to be turned into an address. */
const ASSET_REF = /^(?:image|file)-/;

function around(text: string, index: number, length: number): string {
  if (text.length <= SNIPPET) return escapeInvisible(text, SNIPPET);
  let start = Math.max(0, index - 30);
  // Begin at a word, not in the middle of one.
  if (start > 0) {
    const space = text.indexOf(" ", start);
    start = space >= 0 && space < index ? space + 1 : start;
  }
  return escapeInvisible(text.slice(start, index + length + 40).trim(), SNIPPET);
}

function walk(value: unknown, trail: string, depth: number, out: RawRef[]): void {
  if (out.length >= MAX_RAW_REFS || depth > 12) return;
  if (Array.isArray(value)) {
    value.slice(0, 200).forEach((v, i) => walk(v, `${trail}[${i}]`, depth + 1, out));
    return;
  }
  if (value === null || typeof value !== "object") return;
  const o = value as Record<string, unknown>;
  if (o._type === "reference" && typeof o._ref === "string" && !ASSET_REF.test(o._ref)) {
    out.push({
      kind: "data-ref",
      snippet: escapeInvisible(`{"_type":"reference","_ref":${JSON.stringify(o._ref)}}`, SNIPPET),
      id: escapeInvisible(o._ref, 120),
      where: escapeInvisible(trail === "" ? "(top)" : trail, 100),
    });
    return;
  }
  for (const [k, v] of Object.entries(o))
    walk(v, trail === "" ? k : `${trail}.${k}`, depth + 1, out);
}

/**
 * Raw references on a page, read from the HTML as sent: the text a visitor would read, the
 * addresses it links to, and the JSON the page embeds (`__NEXT_DATA__` and other
 * `application/json` scripts). Only what is on the public page: nothing is asked of Sanity.
 *
 * Not reported: an asset reference in the data (it is meant to be turned into an address), a
 * reference whose `_ref` is only a key in prose, and anything in a script that is not JSON.
 */
export function findRawRefs(page: PageSnapshot): RawRef[] {
  const out: RawRef[] = [];
  const $ = load(page.hops.at(-1)?.body ?? "");
  const embedded: unknown[] = [];
  $('script[type="application/json"], script#__NEXT_DATA__').each((_, el) => {
    try {
      embedded.push(JSON.parse($(el).text()));
    } catch {
      // not JSON: nothing to read
    }
  });
  $("script, style, noscript, template").remove();
  // Each element's own text, so a snippet is the sentence it is in and not a window of the page.
  const blocks: string[] = [];
  $("body, body *").each((_, el) => {
    const own = $(el)
      .contents()
      .toArray()
      .filter((n) => n.type === "text")
      .map((n) => $(n).text())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (own !== "") blocks.push(own);
  });
  const seen = new Set<string>();
  const push = (ref: RawRef) => {
    const key = `${ref.kind}|${ref.id ?? ref.snippet}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };
  for (const text of blocks) {
    const object = OBJECT_OBJECT.exec(text);
    if (object) {
      push({ kind: "object-object", snippet: around(text, object.index, object[0].length) });
      continue;
    }
    const ref = REF_TEXT.exec(text);
    if (ref?.[1] && !ASSET_REF.test(ref[1])) {
      push({
        kind: "ref-text",
        snippet: around(text, ref.index, ref[0].length),
        id: escapeInvisible(ref[1], 120),
      });
      continue;
    }
    const type = TYPE_TEXT.exec(text);
    if (type?.[1])
      push({
        kind: "type-text",
        snippet: around(text, type.index, type[0].length),
        id: escapeInvisible(type[1], 64),
      });
  }
  if (!out.some((r) => r.kind === "object-object")) {
    const link = $("[href], [src]")
      .toArray()
      .map((el) => `${$(el).attr("href") ?? ""} ${$(el).attr("src") ?? ""}`)
      .find((v) => OBJECT_OBJECT.test(v));
    if (link)
      push({
        kind: "object-object",
        snippet: `in an address: ${escapeInvisible(link.trim(), SNIPPET)}`,
      });
  }
  for (const data of embedded) walk(data, "", 0, out);
  return out.slice(0, MAX_RAW_REFS);
}
