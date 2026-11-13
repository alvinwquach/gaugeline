import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  ConfigError,
  HOUSE_CONFIG_FILE,
  HOUSE_DRAFT_FILE,
  HOUSE_DRAFT_SUFFIX,
  HouseRulesInputError,
  MAX_RULES_CHARS,
  compileHouseRules,
  renderHouseDraftJson,
  renderHouseRulesReview,
  type Outcome,
} from "@gaugeline/core";

interface Out {
  stdout: { write(s: string): unknown };
}

/** A character is at most four bytes in UTF-8: a file over this cannot be within the character cap. */
const MAX_RULES_BYTES = MAX_RULES_CHARS * 4;

function readRules(cwd: string, typed: string): string {
  const path = resolve(cwd, typed);
  let bytes: Buffer;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new ConfigError(`${typed} is not a file.`);
    if (st.size > MAX_RULES_BYTES)
      throw new ConfigError(`${typed} is larger than ${MAX_RULES_CHARS} characters.`, {
        hint: "A rules file is a page or two of sentences: split it, or keep only the rules.",
      });
    bytes = readFileSync(path);
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`Could not read ${typed}.`, {
      hint: "Give the file of written rules: gaugeline house-rules --rules style-guide.md",
      cause: e,
    });
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConfigError(`${typed} is not UTF-8 text.`, {
      hint: "A rules file is plain text or Markdown, saved as UTF-8.",
    });
  }
}

/**
 * gaugeline house-rules --rules <file>: compile a site's written rules (AG-17) into a DRAFT gaugeline.rules.json
 * with core's compiler. It reads the one file named and nothing else (no request, no model, no key), and writes
 * one new file whose name ends in .draft.json: never over a file that exists, and never the live
 * gaugeline.rules.json. A person reads the draft and renames it to adopt it. Exit 0 when it ran (also when no
 * line was understood: then nothing is written), 2 (a ConfigError) when it could not run. The text of a rules
 * file is data: a line that gives an order is listed and ignored.
 */
export function runHouseRules(
  args: { rules: string; out?: string; json: boolean },
  io: Out,
  deps: { cwd: string },
): Outcome {
  const typedOut = args.out ?? HOUSE_DRAFT_FILE;
  if (!basename(typedOut).endsWith(HOUSE_DRAFT_SUFFIX))
    throw new ConfigError(
      `--out ${typedOut}: a draft's name must end in ${HOUSE_DRAFT_SUFFIX}. ${HOUSE_CONFIG_FILE} is yours to make by renaming a draft; this command never writes it.`,
      { hint: `For example: --out ${HOUSE_DRAFT_FILE}` },
    );
  const text = readRules(deps.cwd, args.rules);
  let draft;
  try {
    draft = compileHouseRules(text);
  } catch (e) {
    if (e instanceof HouseRulesInputError)
      throw new ConfigError(`${args.rules}: ${e.message}`, {
        hint: "A rules file is plain text or Markdown of at most 50,000 characters and 1000 lines.",
        cause: e,
      });
    throw e;
  }

  let written: string | null = null;
  if (draft.totals.understood > 0) {
    try {
      // "wx": create, and fail if the name is taken (a file, a link, anything): nothing is overwritten.
      writeFileSync(resolve(deps.cwd, typedOut), renderHouseDraftJson(draft), { flag: "wx" });
      written = typedOut;
    } catch (e) {
      const taken = (e as NodeJS.ErrnoException).code === "EEXIST";
      throw new ConfigError(
        taken
          ? `${typedOut} already exists, and this command never overwrites a file.`
          : `Could not write ${typedOut}.`,
        {
          hint: taken
            ? "Read it, or choose another name with --out."
            : "Check that the folder exists and that you may write there.",
          cause: e,
        },
      );
    }
  }
  io.stdout.write(
    args.json
      ? `${JSON.stringify({ written, ...draft }, null, 2)}\n`
      : renderHouseRulesReview(draft, { draftFile: written }),
  );
  return { kind: "ran", highFindings: 0, drift: false };
}
