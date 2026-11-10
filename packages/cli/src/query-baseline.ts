import {
  ConfigError,
  diffBaseline,
  likelyRenames,
  parseBaseline,
  type BaselineGap,
  type Finding,
  type QueryBaseline,
} from "@gaugeline/core";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

/** A baseline is a few hundred short lines; a file much bigger than this is not one. */
const MAX_BYTES = 8 * 1024 * 1024;

const MARK = { high: "\u2717", medium: "!", low: "\u00B7" } as const;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * A file as `/` path from the folder the command ran in, however the folder was typed (`.`, `./src`,
 * `src/app/`): the baseline's keys hold this, so a run from the same place finds the same gaps. An
 * absolute folder is made relative too, so a baseline from one machine is read on another.
 */
export function fromCwd(cwd: string, file: string): string {
  if (file === "") return "";
  return relative(resolve(cwd), resolve(cwd, file)).split("\\").join("/");
}

/** The findings with each file as `fromCwd` writes it. The text of a finding is left as it was. */
export function withCwdFiles(cwd: string, findings: readonly Finding[]): Finding[] {
  return findings.map((f) =>
    f.source === undefined
      ? f
      : { ...f, source: { file: fromCwd(cwd, f.source.file), line: f.source.line } },
  );
}

/**
 * Read the baseline `--against` names. A file that is not there, is a folder or cannot be read is a
 * ConfigError that names the path as it was typed; one that is not a baseline, is of another schema
 * or was edited is refused by `parseBaseline`. Nothing is asked of any site before this has passed.
 */
export async function readBaselineFile(cwd: string, typed: string): Promise<QueryBaseline> {
  const path = resolve(cwd, typed);
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile())
      throw new ConfigError(`${typed} is a folder, not a baseline file.`, {
        hint: "Give the file --save wrote, for example --against before.json.",
      });
    if (info.size > MAX_BYTES)
      throw new ConfigError(`${typed} is not a Gaugeline baseline.`, {
        hint: "Save one first with gaugeline query <folder> --save before.json, then give that file to --against.",
      });
    text = await readFile(path, "utf8");
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    const code = (err as { code?: string }).code;
    throw new ConfigError(
      code === "ENOENT" || code === "ENOTDIR"
        ? `${typed} does not exist, so there is nothing to compare with.`
        : `${typed} could not be read (${code ?? "an error"}).`,
      {
        hint: "Run the first step on the code as it is now: gaugeline query <folder> --save before.json. Run both from the same folder.",
      },
    );
  }
  return parseBaseline(text, typed);
}

/** The text of a finding without the `file:line` its evidence starts with. */
function textOf(f: Finding): string {
  if (f.source === undefined) return f.evidence;
  const marker = `:${f.source.line}  `;
  const at = f.evidence.indexOf(marker);
  return at < 0 ? f.evidence : f.evidence.slice(at + marker.length);
}

/** Group by file, files in order, and say what is wrong in each with its line. */
function byFile<T>(items: readonly T[], file: (t: T) => string, line: (t: T) => string): string[] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(file(item), [...(groups.get(file(item)) ?? []), item]);
  const out: string[] = [];
  for (const name of [...groups.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    out.push(name === "" ? "(no file)" : name);
    for (const item of groups.get(name) ?? []) out.push(`  ${line(item)}`);
  }
  return out;
}

export interface Comparison {
  lines: string[];
  /** The findings this change created that are high: with --ci, these decide the exit code. */
  createdHigh: number;
}

/**
 * What `--against` prints: the gaps this change created, by file and with the line to edit; the gaps
 * it closed; and one line counting the gaps that were already there. A gap saved by a check this run
 * did not make (the baseline had --mutations and this run does not) is left out and counted, because
 * it cannot be said to be closed.
 */
export function compare(input: {
  name: string;
  before: QueryBaseline;
  findings: readonly Finding[];
  /** The ids of the checks this run made. */
  ran: ReadonlySet<string>;
}): Comparison {
  const { name, before, findings } = input;
  const comparable: QueryBaseline = {
    ...before,
    gaps: before.gaps.filter((g) => input.ran.has(g.checkId)),
  };
  const skipped = before.gaps.length - comparable.gaps.length;
  const { created, closed, carried } = diffBaseline(comparable, findings);
  const renames = likelyRenames(closed, created);

  const lines: string[] = [`Compared with ${name}, saved ${before.createdAt}.`, ""];
  if (created.length === 0) lines.push("Created by this change: none.");
  else {
    const files = new Set(created.map((f) => f.source?.file ?? "")).size;
    lines.push(
      `Created by this change: ${plural(created.length, "gap")} in ${plural(files, "file")}. These are the files to edit.`,
      "",
      ...byFile(
        created,
        (f) => f.source?.file ?? "",
        (f) =>
          `${f.source === undefined ? "" : `line ${f.source.line}  `}${MARK[f.severity]} ${textOf(f)}`,
      ),
    );
  }
  lines.push("");
  if (closed.length === 0) lines.push("Closed by this change: none.");
  else
    lines.push(
      `Closed by this change: ${plural(closed.length, "gap")}.`,
      "",
      ...byFile(
        closed,
        (g: BaselineGap) => g.file,
        (g) =>
          `${[g.type, g.field].filter((x) => x !== undefined && x !== "").join(" \u00B7 ")}  (${g.checkId})`,
      ),
    );
  lines.push("");
  for (const r of renames)
    lines.push(
      `Looks like a renamed file, so its gaps show as closed and created: ${r.from} is now ${r.to}.`,
    );
  lines.push(
    `${plural(carried, "gap was", "gaps were")} already there and ${carried === 1 ? "is" : "are"} not listed.`,
  );
  if (skipped > 0)
    lines.push(
      `${plural(skipped, "gap")} in ${name} come${skipped === 1 ? "s" : ""} from checks this run did not make (a flag the first run had, such as --mutations), so ${skipped === 1 ? "it was" : "they were"} left out.`,
    );
  return { lines, createdHigh: created.filter((f) => f.severity === "high").length };
}
