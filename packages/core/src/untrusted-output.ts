/**
 * Page text escaped for the place it is shown. Each escaper sanitises first (untrusted.ts: tag and
 * bidi characters removed, controls and zero-width shown, length capped), then escapes what the
 * format treats as markup. Each returns a SafeText branded with its format, so a sink typed for
 * Slack accepts only forSlack's output: a raw page string, sanitised-only text or text escaped for
 * another format is a compile error there.
 */
import { escapeMarkdown } from "./report/brief.js";
import { DEFAULT_UNTRUSTED_MAX_CHARS, sanitise } from "./untrusted.js";

declare const safeBrand: unique symbol;

export type OutputFormat = "markdown" | "slack" | "discord" | "terminal";

/** Page text escaped for one output format. Only the escaper for that format makes one. */
export type SafeText<F extends OutputFormat> = string & { readonly [safeBrand]: F };

/**
 * ECMA-48 sequences: OSC (title, hyperlink) to BEL or ST, DCS/SOS/PM/APC strings to ST, CSI
 * (colours, cursor, clear screen) in its 7-bit and C1 forms, and two-character escapes (ESC c).
 */
const ANSI = new RegExp(
  [
    "\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\\\)",
    "\\u009D[\\s\\S]*?(?:\\u0007|\\u009C|\\u001B\\\\)",
    "\\u001B[PX^_][\\s\\S]*?\\u001B\\\\",
    "(?:\\u001B\\[|\\u009B)[0-?]*[ -/]*[@-~]",
    "\\u001B[ -/]*[0-~]",
  ].join("|"),
  "gu",
);

/**
 * The most characters of one evidence line the terminal prints. Higher than the evidence cap
 * because some evidence Gaugeline writes itself is long (a library's advisory list); a 50 KB page
 * title is still cut here.
 */
export const TERMINAL_EVIDENCE_MAX = 2000;

/** Removes terminal escape sequences, so a page can't recolour, clear or retitle a terminal. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** For a terminal: escape sequences removed, then sanitised (any control left is shown as text). */
export function forTerminal(
  text: string,
  max: number = DEFAULT_UNTRUSTED_MAX_CHARS,
): SafeText<"terminal"> {
  return sanitise(stripAnsi(text), max).text as string as SafeText<"terminal">;
}

/** For Markdown (digest, work order, step summaries): CommonMark punctuation backslash-escaped. */
export function forMarkdown(
  text: string,
  max: number = DEFAULT_UNTRUSTED_MAX_CHARS,
): SafeText<"markdown"> {
  return escapeMarkdown(sanitise(stripAnsi(text), max).text) as SafeText<"markdown">;
}

/**
 * For Slack mrkdwn: &, < and > become entities, so <!channel>, <@U...> and <url|text> are plain
 * text; a backtick becomes an apostrophe, so page text can't close the code span it is shown in.
 */
export function forSlack(
  text: string,
  max: number = DEFAULT_UNTRUSTED_MAX_CHARS,
): SafeText<"slack"> {
  return sanitise(stripAnsi(text), max)
    .text.replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/`/gu, "'") as SafeText<"slack">;
}

/** Discord markdown: emphasis, code, spoilers, links, quotes and the < of a mention. */
const DISCORD_MARKUP = /(\\u\{[0-9A-F]+\})|[\\*_~`|<>[\]()]/gu;

/**
 * For Discord markdown: markup backslash-escaped, and @everyone and @here written \@ so they show
 * as text. discordPayload also sends allowed_mentions with no types, so nothing in it can ping.
 */
export function forDiscord(
  text: string,
  max: number = DEFAULT_UNTRUSTED_MAX_CHARS,
): SafeText<"discord"> {
  return sanitise(stripAnsi(text), max)
    .text.replace(DISCORD_MARKUP, (m, shown: string | undefined) => (shown ? m : `\\${m}`))
    .replace(/@(everyone|here)\b/gu, "\\@$1") as SafeText<"discord">;
}
