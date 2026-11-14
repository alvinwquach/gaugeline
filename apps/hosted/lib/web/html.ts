/**
 * Markup that escapes by default. A value interpolated into `markup` is text and is escaped; only a SafeHtml
 * (another `markup` result, or `raw` for markup this repository wrote) goes in as markup. So a finding's
 * title or evidence, which the checked site chose, cannot become markup by accident: it reaches a page
 * only through pageText (core's sanitise: tag characters and bidi controls removed, control characters
 * shown, capped) and is then escaped here as well.
 */
import { UNTRUSTED_CAPS, sanitise } from "@gaugeline/core";

export class SafeHtml {
  constructor(private readonly markup: string) {}
  toString(): string {
    return this.markup;
  }
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeText = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/** Markup written in this repository. Never pass anything a person, a site or the database supplied. */
export const raw = (markup: string): SafeHtml => new SafeHtml(markup);

type Part = SafeHtml | string | number | null | undefined | false | readonly Part[];

function render(part: Part): string {
  if (part === null || part === undefined || part === false) return "";
  if (part instanceof SafeHtml) return part.toString();
  if (Array.isArray(part)) return (part as readonly Part[]).map(render).join("");
  return escapeText(String(part));
}

export function markup(strings: TemplateStringsArray, ...parts: Part[]): SafeHtml {
  let out = strings[0] ?? "";
  parts.forEach((p, i) => {
    out += render(p) + (strings[i + 1] ?? "");
  });
  return new SafeHtml(out);
}

/** Page-derived text (a finding's title or evidence line) made safe to show: cleaned, then capped. */
export function pageText(text: string, field: keyof typeof UNTRUSTED_CAPS): string {
  return sanitise(text, UNTRUSTED_CAPS[field]).text;
}
