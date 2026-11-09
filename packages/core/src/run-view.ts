import { redact } from "./redact.js";
import type { PageSnapshot } from "./snapshot.js";

/**
 * What the app's Search data view shows: what the page declares, as read without JavaScript.
 * Built from the page snapshot the checks already read, so showing it asks the site for nothing.
 */

/** One structured data script tag: its value, or for one that did not parse its text and the parser's message. */
export type StructuredBlock =
  { ok: true; value: unknown } | { ok: false; raw: string; error: string };

export interface PageData {
  /** The address the page ended at, after any redirects. */
  url: string;
  /** Absent when the page has no title element; "" when the element is empty. */
  title?: string;
  /** Absent when the page has no canonical link; "" when the link has no address. */
  canonical?: string;
  /** Words a visitor can read without JavaScript. */
  words: number;
  /** The first 200 of them, joined by single spaces. */
  firstWords: string;
  blocks: StructuredBlock[];
}

/** Blocks beyond this many are left out; the page's own checks still read them. */
export const MAX_BLOCKS = 20;
/** A block whose JSON is longer than this is shown as raw text, cut. */
export const MAX_BLOCK_CHARS = 50_000;
/** How much of a block's raw text the result keeps. */
export const RAW_CHARS = 2000;

/** Key-shaped text removed from a value without changing its shape. */
function redactValue(value: unknown, text: string): unknown {
  const clean = redact(text);
  return clean === text ? value : (JSON.parse(clean) as unknown);
}

function block(b: NonNullable<PageSnapshot["jsonLdBlocks"]>[number]): StructuredBlock {
  if (!b.ok) return { ok: false, raw: redact(b.raw).slice(0, RAW_CHARS), error: redact(b.error) };
  const text = JSON.stringify(b.value);
  if (text.length > MAX_BLOCK_CHARS)
    return {
      ok: false,
      raw: redact(text).slice(0, RAW_CHARS),
      error: `This block is too large to show (${text.length.toLocaleString("en-US")} characters).`,
    };
  return { ok: true, value: redactValue(b.value, text) };
}

export function pageData(page: PageSnapshot): PageData {
  const canonical =
    page.canonicalAttr === undefined
      ? undefined
      : page.canonicalAttr === ""
        ? ""
        : (page.canonical ?? page.canonicalAttr);
  return {
    url: redact(page.finalUrl),
    ...(page.title === undefined ? {} : { title: page.title }),
    ...(canonical === undefined ? {} : { canonical: redact(canonical) }),
    words: page.wordCount,
    firstWords: redact(page.firstWords ?? ""),
    blocks: (page.jsonLdBlocks ?? []).slice(0, MAX_BLOCKS).map(block),
  };
}
