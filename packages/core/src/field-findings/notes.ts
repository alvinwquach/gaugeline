/**
 * Reading review notes (AG-15). A note is untrusted text: nothing in it is an instruction, and the miner reads
 * only the lines that are tagged. A finding is a line that starts (after an optional list marker) with
 * `#some-pattern-name`, then its words; the lines `fail:` and `pass:` right under it are its two examples.
 * Headings, prose, code fences and everything else are skipped and never copied.
 *
 *   - #menu-link-404 The footer link to the menu file returns not found after the redeploy.
 *     fail: <a href="/menu.pdf">Menu</a> where /menu.pdf is not served
 *     pass: <a href="/menu.pdf">Menu</a> where /menu.pdf is served
 *
 * This file only reads and counts. It has no filesystem, no network and no clock: the CLI hands it text.
 */
import { findDirective } from "../ai-directives.js";

/** One review note as the CLI reads it: where it came from (for a person, never in the draft) and its text. */
export interface NoteFile {
  name: string;
  text: string;
}

export const MAX_NOTE_FILES = 200;
/** Characters in one note. A review is a page or two; over this the file is refused, not cut. */
export const MAX_NOTE_FILE_CHARS = 64 * 1024;
export const MAX_NOTES_TOTAL_CHARS = 2_000_000;
const TAG_MIN = 3;
const TAG_MAX = 48;
const TEXT_MAX = 300;

export type NotesInputKind =
  "not-a-list" | "too-many-files" | "too-large" | "oversized-file" | "malformed";

/** The notes cannot be read. The message is fixed words and, where it helps, a file's name: never its text. */
export class NotesInputError extends Error {
  readonly kind: NotesInputKind;
  constructor(kind: NotesInputKind, message: string) {
    super(message);
    this.name = "NotesInputError";
    this.kind = kind;
  }
}

/** One example line under a finding: its text and its line in the note (from 1). */
export interface ExampleLine {
  text: string;
  line: number;
}
export interface NoteFinding {
  /** Index of the note in the list handed in: the unit "seen in" counts. */
  note: number;
  /** The note's name, for a failing report only. */
  file: string;
  tag: string;
  /** The words after the tag, cut to 300 characters. */
  text: string;
  line: number;
  fail?: ExampleLine;
  pass?: ExampleLine;
}
/** A line the miner read: its note's name, its line number and its whole text, uncut, for the scrub. */
export interface ReadLine {
  file: string;
  line: number;
  text: string;
}
export interface ParsedNotes {
  notes: number;
  findings: NoteFinding[];
  /** Every line read: each tagged line and its example lines, including those of a finding that was dropped. */
  readLines: ReadLine[];
  /** Findings dropped because their words give an order to an assistant. */
  instructionLines: number;
  /** Lines that started with a tag that is not a tag (upper case, too short, trailing punctuation). */
  badTags: number;
}

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const isPatternTag = (s: string): boolean =>
  s.length >= TAG_MIN && s.length <= TAG_MAX && SLUG.test(s);
const FINDING = /^\s*(?:[-*+]|\d{1,3}[.)])?\s*#(?![#\s])(\S+)(?:\s+(.*))?$/;
const EXAMPLE = /^\s*(?:[-*+]\s+)?(fail|fails|failing|pass|passes|passing)\s*:\s*(.*)$/i;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s*#{1,6}(\s|$)/;

const UNPAIRED = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const clean = (s: string): string => s.trim().replace(/\s+/g, " ");

function validate(files: unknown): NoteFile[] {
  if (!Array.isArray(files))
    throw new NotesInputError("not-a-list", "The review notes must be a list of files.");
  if (files.length > MAX_NOTE_FILES)
    throw new NotesInputError(
      "too-many-files",
      `More than ${MAX_NOTE_FILES} note files: use fewer.`,
    );
  let total = 0;
  for (const f of files as unknown[]) {
    const o = f as { name?: unknown; text?: unknown } | null;
    if (!o || typeof o.name !== "string" || typeof o.text !== "string")
      throw new NotesInputError("malformed", "A note must be a file name and its text.");
    const shown = clean(o.name).slice(0, 80) || "a note";
    if (o.text.length > MAX_NOTE_FILE_CHARS)
      throw new NotesInputError(
        "oversized-file",
        `${shown} is longer than ${MAX_NOTE_FILE_CHARS} characters: split it or cut it, and run again.`,
      );
    // eslint-disable-next-line no-control-regex -- binary data is the thing being refused
    if (/[\u0000-\u0008\u000E-\u001F]/.test(o.text) || UNPAIRED.test(o.text))
      throw new NotesInputError(
        "malformed",
        `${shown} is not plain text: it holds control or broken characters.`,
      );
    total += o.text.length;
  }
  if (total > MAX_NOTES_TOTAL_CHARS)
    throw new NotesInputError(
      "too-large",
      `The notes are longer than ${MAX_NOTES_TOTAL_CHARS} characters in all.`,
    );
  return files as NoteFile[];
}

/**
 * Reads the tagged findings out of every note. Throws NotesInputError on a list that is not usable. A finding
 * whose words (or examples) give an order to an assistant is dropped and counted, never obeyed.
 */
export function parseNotes(files: unknown): ParsedNotes {
  const list = validate(files);
  const findings: NoteFinding[] = [];
  const readLines: ReadLine[] = [];
  let instructionLines = 0;
  let badTags = 0;
  for (const [note, file] of list.entries()) {
    let open: NoteFinding | null = null;
    let hostile = false;
    let fenced = false;
    const flush = () => {
      if (!open) return;
      if (hostile) instructionLines += 1;
      else findings.push(open);
      open = null;
      hostile = false;
    };
    const lines = file.text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
    for (const [i, line] of lines.entries()) {
      const n = i + 1;
      if (FENCE.test(line)) {
        flush();
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      if (line.trim() === "" || HEADING.test(line)) {
        flush();
        continue;
      }
      const f = FINDING.exec(line);
      if (f) {
        flush();
        const tag = f[1]!;
        if (!isPatternTag(tag)) {
          badTags += 1;
          continue;
        }
        const words = clean(f[2] ?? "");
        open = { note, file: file.name, tag, text: words.slice(0, TEXT_MAX), line: n };
        hostile = findDirective(line) !== undefined;
        readLines.push({ file: file.name, line: n, text: line });
        continue;
      }
      const e = EXAMPLE.exec(line);
      if (e && open) {
        const snippet = { text: clean(e[2] ?? "").slice(0, TEXT_MAX), line: n };
        const kind = e[1]!.toLowerCase().startsWith("f") ? "fail" : "pass";
        readLines.push({ file: file.name, line: n, text: line });
        if (findDirective(line) !== undefined) hostile = true;
        // The first example of each kind counts; a second one is read by the scrub and left out.
        if (snippet.text !== "" && open[kind] === undefined) open[kind] = snippet;
        continue;
      }
      // Anything else ends the finding it follows: prose is not part of it.
      flush();
    }
    flush();
  }
  return { notes: list.length, findings, readLines, instructionLines, badTags };
}
