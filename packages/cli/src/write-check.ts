import { lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import {
  AdvisoryInputError,
  ConfigError,
  DenyListError,
  MAX_ADVISORY_CHARS,
  NOT_UNDERSTOOD_WORDS,
  PROBLEM_LABEL,
  forTerminal,
  writeCheckDraft,
  type Outcome,
} from "@gaugeline/core";

interface Out {
  stdout: { write(s: string): unknown };
}

export const DEFAULT_CHECK_DRAFT = "check-writer.draft.md";
/** A character is at most 4 bytes in UTF-8: a file over this many bytes is over the character cap. */
const MAX_ADVISORY_BYTES = MAX_ADVISORY_CHARS * 4;
const MAX_DENY_BYTES = 256 * 1024;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function decode(bytes: Buffer, shown: string, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConfigError(`${shown} is not UTF-8 text.`, {
      hint: `${what} must be plain text in UTF-8: re-save it as UTF-8.`,
    });
  }
}

/** One local regular file: not a folder, not a link, not over the cap. */
function readLocalFile(path: string, typed: string, maxBytes: number, what: string): string {
  const shown = forTerminal(typed, 120);
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    throw new ConfigError(`Could not read ${shown}: there is no such file.`, {
      hint: `Give the ${what} as a path to a file on this computer.`,
      cause: e,
    });
  }
  if (st.isSymbolicLink() || !st.isFile())
    throw new ConfigError(`${shown} is not a plain file (a folder or a link).`, {
      hint: `Give the ${what} as a path to a file, not a link or a folder.`,
    });
  if (st.size > maxBytes)
    throw new ConfigError(`${shown} is longer than the cap of ${MAX_ADVISORY_CHARS} characters.`, {
      hint: "Save only the advisory or the page, and run again.",
    });
  return decode(readFileSync(path), shown, what);
}

/**
 * gaugeline write-check --from-file <file>: the check writer (AG-16). Reads one advisory or docs page that the
 * owner saved as a local file and an optional deny-list of names, and writes one Markdown DRAFT (a check outline,
 * fixtures and proposed registry entries, every claim with the line of the file that states it), or, when a
 * cited line holds a client name, a private web address, an email address or a phone number, or a claim has no
 * cited line, writes nothing, names the kind and the line, and exits 1. Makes no request (the file is read,
 * never fetched), calls no model, runs nothing from the file, and edits no registry, lock, check or source file
 * (--out must be Markdown). Exit 0 a draft, 1 refused or nothing understood, 2 could not read.
 */
export function runWriteCheck(
  args: { fromFile: string; denyList?: string; out?: string },
  io: Out,
  deps: { cwd: string },
): Outcome {
  const input = resolve(deps.cwd, args.fromFile);
  const typedOut = args.out ?? DEFAULT_CHECK_DRAFT;
  const out = resolve(deps.cwd, typedOut);
  if (extname(out).toLowerCase() !== ".md" || out === input)
    throw new ConfigError(
      `--out ${typedOut} must be a Markdown file (.md), not the advisory itself.`,
      {
        hint: "The draft is one Markdown file for a person to read; it is never code and never the registry.",
      },
    );
  try {
    if (!statSync(out).isFile()) throw new ConfigError(`--out ${typedOut} is not a file.`);
  } catch (e) {
    if (e instanceof ConfigError) throw e;
  }
  let denyList: string | undefined;
  if (args.denyList !== undefined) {
    try {
      denyList = readLocalFile(
        resolve(deps.cwd, args.denyList),
        args.denyList,
        MAX_DENY_BYTES,
        "deny-list",
      );
    } catch (e) {
      if (e instanceof ConfigError)
        throw new ConfigError(e.message, {
          hint: "Give a text file with one client name on each line.",
          cause: e,
        });
      throw e;
    }
  }
  const text = readLocalFile(input, args.fromFile, MAX_ADVISORY_BYTES, "advisory or docs page");

  let result;
  try {
    result = writeCheckDraft(
      { name: args.fromFile, text },
      denyList === undefined ? {} : { denyList },
    );
  } catch (e) {
    if (e instanceof AdvisoryInputError || e instanceof DenyListError)
      throw new ConfigError(
        e instanceof DenyListError ? `${args.denyList}: ${e.message}` : e.message,
        {
          cause: e,
        },
      );
    throw e;
  }

  if (!result.ok && result.reason === "not-understood") {
    const shown = result.notUnderstood.map(
      (u) => `  ${u.line === null ? "" : `line ${u.line}: `}${NOT_UNDERSTOOD_WORDS[u.reason]}`,
    );
    io.stdout.write(
      `${[
        "Nothing in the file is in a shape the writer reads, so no draft was written.",
        ...shown,
        ...(result.notUnderstoodCount > shown.length
          ? [`  and ${result.notUnderstoodCount - shown.length} more`]
          : []),
        ...(result.instructionLines > 0
          ? [
              `${plural(result.instructionLines, "line")} that gave an order to an assistant, ignored.`,
            ]
          : []),
        "",
        "The writer reads an OSV or GitHub JSON advisory, an advisory page saved as Markdown (a table of package, affected and patched versions), or a docs page that says `package` 1.2.3 or later.",
        "It never guesses a floor. Nothing was fetched and nothing was changed.",
      ].join("\n")}\n`,
    );
    return { kind: "ran", highFindings: 1, drift: false };
  }

  if (!result.ok) {
    const kinds = [...new Set(result.problems.map((p) => PROBLEM_LABEL[p.kind]))];
    const shown = result.problems.map(
      (p) => `  ${p.line === null ? "the draft" : `line ${p.line}`}: ${PROBLEM_LABEL[p.kind]}`,
    );
    io.stdout.write(
      `${[
        `The draft failed the scrub: ${plural(result.problemCount, "problem")} in the lines it cited (${kinds.join(", ")}). No draft was written.`,
        ...shown,
        ...(result.problemCount > shown.length
          ? [`  and ${result.problemCount - shown.length} more`]
          : []),
        "",
        "Fix the file (or leave out the line), then run it again. The text found is not printed.",
      ].join("\n")}\n`,
    );
    return { kind: "ran", highFindings: 1, drift: false };
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, result.markdown);
  const d = result.draft;
  io.stdout.write(
    `${[
      `Read ${d.shape === "docs-markdown" ? "a docs page" : "an advisory"}; the scrub checked ${plural(d.scrub.claimsChecked, "cited line")} and found no client name, private address, email or phone number.`,
      `Wrote ${plural(d.floors.length, "floor")} with a failing and a passing fixture to ${forTerminal(typedOut, 120)}${d.notProposed.notUnderstood > 0 ? `; ${plural(d.notProposed.notUnderstood, "entry", "entries")} not understood, listed in it` : ""}.`,
      "This is a draft for a person to review. No registry, lock, check or source file was changed.",
    ].join("\n")}\n`,
  );
  return { kind: "ran", highFindings: 0, drift: false };
}
