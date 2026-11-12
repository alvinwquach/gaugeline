import { Parser } from "htmlparser2";
import { findDirective } from "../../ai-directives.js";
import type { PageSnapshot } from "../../snapshot.js";
import { hiddenReason } from "./styles.js";

/** Text a visitor cannot see: where it is, how it is hidden, what it says. */
export interface HiddenSpan {
  /** For an element, its short path ("div#promo"); for a comment, the element it sits in. */
  where: string;
  /** "display:none", "HTML comment", "noscript" and so on. */
  how: string;
  /** The text, cut to MAX_KEPT characters. */
  text: string;
  /** The phrase from ai-directives.json that the full text contains, if any. */
  directive?: string;
}

/** Unicode tag characters in one text node or comment. */
export interface TagHit {
  where: string;
  count: number;
  /** What the tags say, as ASCII; tags with no printable meaning are written as \u{HEX}. */
  decoded: string;
}

/** Zero-width characters inside words in one visible text node. */
export interface ZeroWidthHit {
  where: string;
  count: number;
  /** A few characters either side of the first one. */
  sample: string;
}

export interface TextScan {
  hidden: HiddenSpan[];
  tags: TagHit[];
  zeroWidth: ZeroWidthHit[];
}

/** A hidden element's text is matched in full but only this much of it is kept. */
const MAX_KEPT = 2000;
/** The most text collected from one hidden element before the rest is ignored. */
const MAX_COLLECTED = 200_000;

const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;
/** Subdivision flags (England, Scotland, Wales) are a black flag, tag letters and a cancel tag. */
export const FLAG_SEQUENCE = /\u{1F3F4}[\u{E0061}-\u{E007A}]+\u{E007F}/gu;
const WORD = "\\p{Script=Latin}\\p{Script=Cyrillic}\\p{Script=Greek}\\p{Nd}";
/**
 * A zero-width character (or a run of them) between two letters or digits of the scripts that
 * write words with spaces. Joiners in emoji, non-joiners in Persian and zero-width spaces in Thai
 * have other characters beside them. Sanity's stega puts its run at the end of a text, not inside.
 */
export const ZERO_WIDTH_IN_WORD = new RegExp(
  `([${WORD}])([\\u200B-\\u200D\\u2060-\\u2064\\u180E\\uFEFF]+)(?=[${WORD}])`,
  "gu",
);

interface Frame {
  name: string;
  label: string;
  /** Set on the outermost hidden element only: how it is hidden. */
  owns?: string;
  text?: string;
  collected?: number;
}

function label(name: string, attribs: Record<string, string>): string {
  const id = attribs["id"]?.trim().split(/\s+/)[0];
  const cls = attribs["class"]?.trim().split(/\s+/)[0];
  const tail = id ? `#${id}` : cls ? `.${cls}` : "";
  return `${name}${tail}`.slice(0, 40);
}

const pathOf = (stack: Frame[]) =>
  stack
    .slice(-3)
    .map((f) => f.label)
    .join(" > ") || "page";

function describeTags(text: string): Omit<TagHit, "where"> | undefined {
  const tags = text.replace(FLAG_SEQUENCE, "").match(TAG_CHARS);
  if (!tags) return undefined;
  const decoded = tags
    .map((c) => {
      const cp = c.codePointAt(0) ?? 0;
      return cp >= 0xe0020 && cp <= 0xe007e
        ? String.fromCharCode(cp - 0xe0000)
        : `\\u{${cp.toString(16).toUpperCase()}}`;
    })
    .join("");
  return { count: tags.length, decoded };
}

function describeZeroWidth(text: string): Omit<ZeroWidthHit, "where"> | undefined {
  let first: RegExpExecArray | undefined;
  let count = 0;
  for (const m of text.matchAll(ZERO_WIDTH_IN_WORD)) {
    first ??= m;
    count += (m[2] ?? "").length;
  }
  if (!first) return undefined;
  // The whole word around the first one, so the report shows what the visitor would read.
  const at = first.index;
  const end = at + first[0].length;
  const before = /\S{0,30}$/.exec(text.slice(0, at))?.[0] ?? "";
  const after = /^\S{0,30}/.exec(text.slice(end))?.[0] ?? "";
  const sample = `${before}${first[0]}${after}`;
  return { count, sample };
}

const cache = new WeakMap<object, TextScan>();

/**
 * One pass over the page's HTML as received: the text a visitor cannot see (hidden elements,
 * comments, noscript), Unicode tag characters, and zero-width characters inside words. Nothing is
 * rendered and no script runs; the parser only reports tags, text and comments. Cached per page,
 * so the three checks that read it cost one scan.
 */
export function scanText(page: Pick<PageSnapshot, "hops">): TextScan {
  const hit = cache.get(page);
  if (hit) return hit;
  const html = page.hops.at(-1)?.body ?? "";
  const scan: TextScan = { hidden: [], tags: [], zeroWidth: [] };
  const stack: Frame[] = [];
  let owner: Frame | undefined;
  let pending = "";

  const closeOwner = () => {
    if (!owner) return;
    const full = (owner.text ?? "").trim();
    if (full.trim() !== "") {
      const directive = findDirective(full);
      scan.hidden.push({
        where: pathOf(stack),
        how: owner.owns ?? "hidden",
        text: full.slice(0, MAX_KEPT),
        ...(directive ? { directive: directive.text } : {}),
      });
    }
    owner = undefined;
  };

  const flush = () => {
    if (pending === "") return;
    const text = pending;
    pending = "";
    const top = stack.at(-1);
    if (top && (top.name === "script" || top.name === "style")) return;
    const where = pathOf(stack);
    const tags = describeTags(text);
    if (tags) scan.tags.push({ ...tags, where });
    if (owner) {
      const room = MAX_COLLECTED - (owner.collected ?? 0);
      if (room > 0) {
        owner.text = `${owner.text ?? ""}${text.slice(0, room)} `;
        owner.collected = (owner.collected ?? 0) + Math.min(room, text.length);
      }
      return;
    }
    const zw = describeZeroWidth(text);
    if (zw) scan.zeroWidth.push({ ...zw, where });
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        flush();
        const frame: Frame = { name, label: label(name, attribs) };
        if (!owner) {
          const how = name === "noscript" ? "noscript" : hiddenReason(attribs);
          if (how) {
            frame.owns = how;
            frame.text = "";
            owner = frame;
          }
        }
        stack.push(frame);
      },
      ontext(data) {
        pending += data;
      },
      oncomment(data) {
        flush();
        const where = pathOf(stack);
        const tags = describeTags(data);
        if (tags) scan.tags.push({ ...tags, where: `comment in ${where}` });
        if (data.trim() === "") return;
        const directive = findDirective(data);
        scan.hidden.push({
          where,
          how: "HTML comment",
          text: data.trim().slice(0, MAX_KEPT),
          ...(directive ? { directive: directive.text } : {}),
        });
      },
      onclosetag(name) {
        flush();
        // The parser closes implied elements itself, so the top frame is normally the one named.
        let i = stack.length - 1;
        while (i >= 0 && stack[i]?.name !== name) i--;
        if (i < 0) return;
        while (stack.length > i + 1) stack.pop();
        if (owner && stack[i] === owner) closeOwner();
        stack.pop();
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  flush();
  // Anything the parser left open at the end of the document.
  while (stack.length > 0) {
    if (owner && stack.at(-1) === owner) closeOwner();
    stack.pop();
  }
  cache.set(page, scan);
  return scan;
}
