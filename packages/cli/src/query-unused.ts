import { analyseUnused, checkUnusedOnly, type Outcome } from "@gaugeline/core";
import { resolve } from "node:path";
import { formatTerminal } from "./reporter.js";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

interface Out {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}

interface Deps {
  cwd: string;
  now?: Date;
  color?: boolean;
}

/**
 * gaugeline query <folder> --unused: the fields the queries in a repository fetch that no code
 * reads, for GROQ and for GraphQL. It reads the source files with the TypeScript compiler and
 * nothing else: no request, no key, and no environment variable (this function is not given the
 * environment). Each result is followed through the code; a query whose result goes somewhere that
 * cannot be followed is listed under "Could not follow" with the file, the line and where it went,
 * and none of its fields are reported. Files are shown as they would be typed from where the
 * command ran. Exit 0, or 1 with --ci and a fix-first finding (this check has none, so 0), or 2
 * when the folder does not exist or TypeScript is missing.
 */
export async function runUnused(
  args: { dir: string; json?: boolean },
  io: Out,
  deps: Deps,
): Promise<Outcome> {
  // Windows separators and a trailing slash go; "." prints as nothing, so lines read like paths from here.
  const typed = args.dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const analysis = await analyseUnused(resolve(deps.cwd, args.dir), {
    prefix: typed === "." ? "" : typed,
  });
  const run = await checkUnusedOnly({ analysis, now: deps.now ?? new Date() });
  const outcome: Outcome = {
    kind: "ran",
    highFindings: run.result.findings.filter((f) => f.severity === "high").length,
    drift: false,
  };
  if (args.json) {
    io.stdout.write(`${JSON.stringify(run.result, null, 2)}\n`);
    return outcome;
  }

  const out: string[] = [];
  if (analysis.queries === 0) {
    out.push(
      `No GROQ or GraphQL queries found under ${args.dir}.`,
      "It looks for groq`...` templates, defineQuery(...) calls and gql and graphql tagged templates in .ts, .tsx, .js, .jsx and .mjs files (and .graphql and .gql files), and skips node_modules, .next, dist and what .gitignore names.",
    );
  } else {
    const followed = analysis.queries - analysis.couldNotFollow.length;
    out.push(
      `Read ${plural(analysis.queries, "query", "queries")} in ${plural(analysis.files, "file")} and followed ${followed === analysis.queries ? "each result" : `${plural(followed, "result")}`} through the code. Nothing was sent, and no key or environment variable was read.`,
    );
    if (analysis.couldNotFollow.length > 0) {
      out.push(
        "",
        `Could not follow ${plural(analysis.couldNotFollow.length, "query", "queries")} (none of their fields are reported):`,
      );
      for (const c of analysis.couldNotFollow)
        out.push(`  ${c.source.file}:${c.source.line}  ${c.reason}`);
    }
    out.push(
      "",
      formatTerminal({
        result: {
          findings: run.result.findings,
          passed: run.result.passed,
          failed: [],
          warnings: [],
          // They are listed above, with where each result went.
          couldNotCheck: [],
          sampled: {},
        },
        color: deps.color ?? false,
      }).trimEnd(),
    );
  }
  io.stdout.write(`${out.join("\n")}\n`);
  return outcome;
}
