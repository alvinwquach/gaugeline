import { INVISIBLE } from "../../ai-directives.js";

/** Control characters other than tab and line breaks, and the C1 range. */
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/**
 * Text from a page, made safe to print: control characters, zero-width, directional and Unicode
 * tag characters become \u{HEX}, line breaks and tabs become spaces, and the result stops after
 * `max` characters with an ellipsis. Text from a page is data; it must never reach a terminal or
 * a report in a form that does anything.
 */
export function escapeInvisible(text: string, max: number): string {
  const flat = text.replace(/[\t\r\n]+/g, " ").replace(/ {2,}/g, " ");
  const chars = [...flat];
  const cut = chars.length > max;
  const shown = (cut ? chars.slice(0, max) : chars).join("");
  const escaped = shown.replace(new RegExp(`${CONTROL.source}|${INVISIBLE.source}`, "gu"), (c) => {
    return `\\u{${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`;
  });
  return cut ? `${escaped}\u2026` : escaped;
}
