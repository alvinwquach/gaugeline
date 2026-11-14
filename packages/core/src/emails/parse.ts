import { Parser } from "htmlparser2";
import type { TrackingRule } from "./config.js";
import { unwrapTracking } from "./tracking.js";

/** One a[href] as the email writes it. */
export interface EmailLink {
  /** As written, trimmed. */
  raw: string;
  /** The destination when the link is a tracking wrapper whose pattern is known, else as written. */
  href: string;
  /** The wrapper's host, when one was unwrapped. */
  via?: string;
  /** 1-based line in the file. */
  line: number;
}

/** One img[src] as the email writes it. */
export interface EmailImage {
  src: string;
  line: number;
}

export interface ParsedEmail {
  links: EmailLink[];
  images: EmailImage[];
  /** The html element's line, for what is about the whole email (its language). */
  htmlLine?: number;
  /**
   * The source with the bodies of style and script elements and the comments blanked out, line
   * breaks kept, so a character offset in it is a line in the file. Placeholders are looked for here.
   */
  masked: string;
  /** The 1-based line of a character offset in the source. */
  lineAt(index: number): number;
}

/**
 * An unsubscribe, opt-out or preferences link. A GET to one of these can unsubscribe the person whose
 * address is in it, so Gaugeline never asks for one, whatever site it is on.
 */
export function isUnsubscribeLink(href: string, text = ""): boolean {
  const words =
    /unsubscri|opt[-_ ]?out|(?:manage|update|email|mail)[-_ ]?(?:your[-_ ]?)?(?:preferences|subscriptions?)|\/preferences\b/i;
  return words.test(href) || words.test(text);
}

/** The offsets of every line break, so a line number is a binary search and not a scan. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return starts;
}

/** Characters that are not a line break become spaces, so offsets and lines stay where they were. */
const blank = (s: string): string => s.replace(/[^\n]/g, " ");

/**
 * Blank the parts of the source that are not what a recipient reads: styles, scripts (but not
 * JSON-LD, where a placeholder is a real fault) and comments.
 */
export function maskSource(source: string): string {
  return source
    .replace(/<(style|script)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi, (m, _tag: string, attrs: string) =>
      /ld\+json/i.test(attrs) ? m : blank(m),
    )
    .replace(/<!--[\s\S]*?-->/g, blank);
}

/**
 * Read the links, images and positions of a rendered email. The parser is htmlparser2's streaming
 * one, which reports where each tag starts, so a finding can name its line. The HTML is read as
 * text and never run.
 */
export function parseEmail(source: string, tracking: readonly TrackingRule[] = []): ParsedEmail {
  const starts = lineStarts(source);
  const lineAt = (index: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const links: EmailLink[] = [];
  const images: EmailImage[] = [];
  let htmlLine: number | undefined;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const line = lineAt(parser.startIndex);
        if (name === "html" && htmlLine === undefined) htmlLine = line;
        if (name === "a" && attribs.href !== undefined) {
          const raw = attribs.href.trim();
          if (raw === "") return;
          const unwrapped = unwrapTracking(raw, tracking);
          links.push({
            raw,
            href: unwrapped.href,
            ...(unwrapped.via ? { via: unwrapped.via } : {}),
            line,
          });
        }
        if (name === "img" && attribs.src !== undefined && attribs.src.trim() !== "")
          images.push({ src: attribs.src.trim(), line });
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(source);
  parser.end();
  return {
    links,
    images,
    ...(htmlLine !== undefined ? { htmlLine } : {}),
    masked: maskSource(source),
    lineAt,
  };
}
