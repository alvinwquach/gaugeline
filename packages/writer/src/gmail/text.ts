/**
 * The words of an email draft, made safe for where they land (ADR-0010 part 8, N17). The draft's body is
 * prose an agent wrote and a person approved; it may quote a checked page, and a page can say anything.
 * An email draft is plain text, so there is no markup to escape: each line goes through core's
 * `forTerminal` (escape sequences removed, tag characters and bidirectional controls removed, control and
 * zero-width characters inside a word shown as \u{HEX}, runs of whitespace collapsed), and the line's own
 * leading spaces, which the sanitiser would trim, are kept. Lines and blank lines stay as approved. The
 * subject is not touched here: it is one line the payload shape already limits, and the message builder
 * refuses a break or a control in it rather than rewriting it.
 */
import { forTerminal } from "@gaugeline/core";

/** forTerminal cuts a line at this many characters; the payload allows 20 000 for the whole body. */
const LINE_MAX = 20_000;

/** The body with each line cleaned; line ends are "\n". */
export function mailBody(body: string): string {
  return body
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((raw) => {
      const indent = /^ */u.exec(raw)![0];
      const text = raw.slice(indent.length);
      return text === "" ? "" : indent + (forTerminal(text, LINE_MAX) as string);
    })
    .join("\n");
}
