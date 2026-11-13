import { readLocalSource, runStaticChecks, type Outcome } from "@gaugeline/core";
import { resolve } from "node:path";
import { formatTerminal } from "./reporter.js";

interface Out {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * gaugeline source <folder>: read a site's source folder and run the static checks on it. Reads
 * files and nothing else (CLAUDE.md rules 6 and 14): no request, no code run, no link followed out
 * of the folder, and .env and other secret-looking files are never opened (they are listed by name
 * only). The checks never print a value they find in a file. Exit 0; 1 with --ci and a "Fix this
 * first" finding; 2 (a ConfigError) when the folder is not a folder.
 */
export async function runSource(
  args: { folder: string; json: boolean; quiet: boolean },
  io: Out,
  deps: { cwd: string; now: Date; color: boolean },
): Promise<Outcome> {
  // As typed, without Windows separators or a trailing slash, so the report reads like the command.
  const label = args.folder.replace(/\\/g, "/").replace(/(?<=.)\/+$/, "");
  const tree = await readLocalSource(resolve(deps.cwd, args.folder), undefined, label);
  const result = await runStaticChecks({ tree, now: deps.now });
  const outcome: Outcome = {
    kind: "ran",
    highFindings: result.findings.filter((f) => f.severity === "high").length,
    drift: false,
  };
  if (args.json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return outcome;
  }
  const lines = [
    `Read ${plural(tree.files.size, "file")} in ${label}. No request was made and no code was run.`,
  ];
  const refused = [...tree.skipped].filter(([, reason]) => reason === "secret-looking");
  if (refused.length > 0)
    lines.push(
      `Not opened, because they look like they hold secrets: ${refused
        .slice(0, 5)
        .map(([path]) => path)
        .join(", ")}${refused.length > 5 ? ` and ${refused.length - 5} more` : ""}.`,
    );
  const other = tree.skipped.size - refused.length;
  if (other > 0)
    lines.push(`Not read: ${plural(other, "other file")} (a link, too large or not text).`);
  if (tree.truncated)
    lines.push(
      "The folder holds more than Gaugeline reads, so no check passes: a check that found nothing says it is not sure.",
    );
  lines.push(
    "",
    formatTerminal({
      result: {
        findings: result.findings,
        passed: result.passed,
        failed: [],
        warnings: [],
        couldNotCheck: result.couldNotCheck,
        sampled: {},
      },
      color: deps.color,
    }).trimEnd(),
  );
  io.stdout.write(`${lines.join("\n")}\n`);
  return outcome;
}
