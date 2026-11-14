import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import {
  ConfigError,
  DenyListError,
  LEAK_LABEL,
  MAX_NOTE_FILES,
  MAX_NOTE_FILE_CHARS,
  NotesInputError,
  forTerminal,
  mineFieldFindings,
  type NoteFile,
  type Outcome,
} from "@gaugeline/core";

interface Out {
  stdout: { write(s: string): unknown };
}

export const DEFAULT_DRAFT = "field-findings.draft.md";
const NOTE_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const MAX_DEPTH = 3;
/** A character is at most 4 bytes in UTF-8: a file over this many bytes is over the character cap. */
const MAX_NOTE_BYTES = MAX_NOTE_FILE_CHARS * 4;
const MAX_DENY_BYTES = 256 * 1024;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function decode(bytes: Buffer, shown: string, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConfigError(`${shown} is not UTF-8 text.`, {
      hint: `${what} must be plain text in UTF-8: re-save it as UTF-8, or leave it out of the folder.`,
    });
  }
}

/** The notes in a folder: .md, .markdown and .txt files, three folders deep, no links, no hidden names, sorted. */
function readNotes(folder: string, typed: string): NoteFile[] {
  const names: string[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (depth < MAX_DEPTH) walk(full, depth + 1);
      } else if (st.isFile() && NOTE_EXTENSIONS.has(extname(entry).toLowerCase())) {
        names.push(full);
        if (names.length > MAX_NOTE_FILES)
          throw new ConfigError(`${typed} holds more than ${MAX_NOTE_FILES} notes.`, {
            hint: "Give a folder of one review round at a time.",
          });
      }
    }
  };
  walk(folder, 0);
  if (names.length === 0)
    throw new ConfigError(`${typed} holds no review notes: no .md, .markdown or .txt file.`, {
      hint: "Give the folder that holds your review notes as Markdown or text files.",
    });
  return names.map((full) => {
    const name = relative(folder, full).split(sep).join("/");
    const shown = forTerminal(name, 120);
    if (statSync(full).size > MAX_NOTE_BYTES)
      throw new ConfigError(
        `${shown} is longer than ${MAX_NOTE_FILE_CHARS} characters: split it or cut it, and run again.`,
      );
    return { name, text: decode(readFileSync(full), shown, "A review note") };
  });
}

function readDenyList(cwd: string, typed: string): string {
  const path = resolve(cwd, typed);
  try {
    if (statSync(path).size > MAX_DENY_BYTES)
      throw new ConfigError(`${typed} is larger than 256 KB.`);
    return decode(readFileSync(path), typed, "The deny-list");
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`Could not read ${typed}.`, {
      hint: "Give a text file with one client name on each line.",
      cause: e,
    });
  }
}

/**
 * gaugeline mine --review-notes <folder>: the field-findings miner (AG-15). Reads the notes and an optional
 * deny-list of names, and writes one Markdown DRAFT of check candidates for a person to review, or, when a line it
 * used holds a client name, a web address, an email address or a phone number, writes nothing, names the kind and
 * the line, and exits 1. Makes no request, calls no model, never writes a check or code (--out must be Markdown).
 * Exit 0 a draft, 1 the scrub failed it, 2 could not read.
 */
export function runMine(
  args: { reviewNotes: string; denyList?: string; out?: string },
  io: Out,
  deps: { cwd: string },
): Outcome {
  const folder = resolve(deps.cwd, args.reviewNotes);
  let isFolder = false;
  try {
    isFolder = statSync(folder).isDirectory();
  } catch (e) {
    throw new ConfigError(`Could not read ${args.reviewNotes}: there is no such folder.`, {
      hint: "Give the folder that holds your review notes.",
      cause: e,
    });
  }
  if (!isFolder)
    throw new ConfigError(`${args.reviewNotes} is a file: --review-notes takes a folder.`, {
      hint: "Give the folder that holds your review notes.",
    });
  const typedOut = args.out ?? DEFAULT_DRAFT;
  const out = resolve(deps.cwd, typedOut);
  const inside = (p: string, base: string) => p === base || p.startsWith(`${base}${sep}`);
  if (extname(out).toLowerCase() !== ".md" || inside(out, folder))
    throw new ConfigError(
      `--out ${typedOut} must be a Markdown file (.md) outside the notes folder.`,
      { hint: "The draft is one Markdown file for a person to read; it is never code." },
    );
  try {
    if (!statSync(out).isFile()) throw new ConfigError(`--out ${typedOut} is not a file.`);
  } catch (e) {
    if (e instanceof ConfigError) throw e;
  }
  const denyList = args.denyList === undefined ? undefined : readDenyList(deps.cwd, args.denyList);
  const notes = readNotes(folder, args.reviewNotes);

  let result;
  try {
    result = mineFieldFindings(notes, denyList === undefined ? {} : { denyList });
  } catch (e) {
    if (e instanceof NotesInputError || e instanceof DenyListError)
      throw new ConfigError(
        e instanceof DenyListError ? `${args.denyList}: ${e.message}` : e.message,
        { cause: e },
      );
    throw e;
  }

  if (!result.ok) {
    const kinds = [...new Set(result.leaks.map((l) => LEAK_LABEL[l.kind]))];
    const shown = result.leaks.map(
      (l) => `  ${forTerminal(l.file, 120)} line ${l.line}: ${LEAK_LABEL[l.kind]}`,
    );
    io.stdout.write(
      `${[
        `The draft failed the scrub: ${plural(result.leakCount, "line")} the miner read ${result.leakCount === 1 ? "holds" : "hold"} ${kinds.join(", ")}. No draft was written.`,
        ...shown,
        ...(result.leakCount > shown.length
          ? [`  and ${result.leakCount - shown.length} more`]
          : []),
        "",
        "Rewrite those lines so they are generic (no client name, address, email or phone number), then run it again.",
        "The text found is not printed.",
      ].join("\n")}\n`,
    );
    return { kind: "ran", highFindings: 1, drift: false };
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, result.markdown);
  const d = result.draft;
  io.stdout.write(
    `${[
      `Read ${plural(d.notesRead, "review note")} and ${plural(d.linesRead, "tagged line")}; the scrub checked ${plural(d.scrub.linesChecked, "line")} and found no client name, address, email or phone number.`,
      `Wrote ${plural(d.candidates.length, "candidate")} to ${typedOut}.`,
      "This is a draft for a person to review. No check, fixture or code was added anywhere.",
    ].join("\n")}\n`,
  );
  return { kind: "ran", highFindings: 0, drift: false };
}
