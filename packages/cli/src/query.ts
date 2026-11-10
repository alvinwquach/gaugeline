import {
  compareQueries,
  ConfigError,
  createFetcher,
  extractGroq,
  freezeEnv,
  SANITY_DATASET,
  SANITY_PROJECT_ID,
  SANITY_TOKEN,
  type FetcherOptions,
  type Outcome,
  type QueryShape,
  type Unreadable,
} from "@gaugeline/core";
import { resolve } from "node:path";
import { formatTerminal } from "./reporter.js";

/** Why each kind of unreadable query was left alone, in a sentence a person can act on. */
const WHY: Record<Unreadable["reason"], string> = {
  concatenated:
    "built at run time (a template with an interpolation, strings joined with +, or a variable), so it cannot be read from the file",
  "parse-error":
    "could not be parsed: the file has a syntax error, or the string is not valid GROQ",
  "no-type-filter": "no _type filter, so there is no document type to attribute it to",
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A source file as the person would type it from where they ran the command: the folder they gave, then the path in it. */
function shown(prefix: string, file: string): string {
  return prefix === "" ? file : `${prefix}/${file}`;
}

function shapeLines(q: QueryShape): string[] {
  return [
    `${q.type}  ${q.source.file}:${q.source.line}`,
    `  fields: ${q.fields.length === 0 ? "none" : q.fields.map((f) => f.path).join(", ")}`,
    `  drafts: ${q.excludesDrafts ? "left out by the filter" : "not left out by the filter"}`,
    `  params: ${q.params.length === 0 ? "none" : q.params.map((p) => `$${p}`).join(", ")}`,
  ];
}

interface Out {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env?: Record<string, string | undefined>;
}

interface Deps {
  cwd: string;
  now?: Date;
  fetcher?: FetcherOptions;
  color?: boolean;
}

/**
 * gaugeline query <folder>: the GROQ in a repository, as shapes. One block for each shape (the
 * document type, the fields it reads, whether the filter leaves drafts out, the parameters, and
 * the file and line the query starts on), then the queries that could not be read and why, then the
 * findings. With SANITY_PROJECT_ID set the dataset is asked for counts, one GET for each type;
 * without it nothing is requested, nothing is compared, and a line on stderr says so.
 * Files are shown as they would be typed from where the command ran, in the findings too.
 * Exit 0, 1 with --ci and a fix-first finding, or 2 (a ConfigError) when the folder does not
 * exist, TypeScript is missing or the dataset cannot be read.
 */
export async function runQuery(
  args: { dir: string; json?: boolean; quiet?: boolean },
  io: Out,
  deps: Deps,
): Promise<Outcome> {
  const asks = (io.env?.[SANITY_PROJECT_ID] ?? "").trim() !== "";
  if (args.json && !asks)
    throw new ConfigError(
      "gaugeline query --json prints findings, and they need SANITY_PROJECT_ID.",
      {
        hint: "Set SANITY_PROJECT_ID (and SANITY_TOKEN, with the Viewer role, for a private dataset), or leave --json out to list the queries.",
      },
    );
  const found = await extractGroq(resolve(deps.cwd, args.dir));
  // Windows separators and a trailing slash go; "." prints as nothing, so lines read like paths from here.
  const typed = args.dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const prefix = typed === "." ? "" : typed;
  const at = <T extends { source: { file: string; line: number } }>(x: T): T => ({
    ...x,
    source: { file: shown(prefix, x.source.file), line: x.source.line },
  });
  const queries = found.queries.map(at);
  const unreadable = found.unreadable.map(at);
  const sites = new Set(queries.map((q) => `${q.source.file}:${q.source.line}`));
  const total = sites.size + unreadable.length;

  // Without a project id nothing is asked and nothing is compared: the output is the shapes alone.
  const run =
    total === 0 || !asks
      ? undefined
      : await compareQueries({
          shapes: queries,
          env: freezeEnv(io.env ?? {}, [SANITY_PROJECT_ID, SANITY_DATASET, SANITY_TOKEN]),
          fetcher: createFetcher(deps.fetcher),
          now: deps.now ?? new Date(),
        });
  if (args.quiet !== true) {
    if (run) for (const n of run.notices) io.stderr.write(`${n}\n`);
    else if (total > 0 && !asks)
      io.stderr.write(
        "SANITY_PROJECT_ID is not set, so the queries were not compared with your content. Set it (and SANITY_TOKEN, with the Viewer role, for a private dataset) to count the documents.\n",
      );
  }
  const outcome: Outcome = {
    kind: "ran",
    highFindings: run ? run.result.findings.filter((f) => f.severity === "high").length : 0,
    drift: false,
  };
  if (args.json && run) {
    io.stdout.write(`${JSON.stringify(run.result, null, 2)}\n`);
    return outcome;
  }

  const out: string[] = [];
  if (total === 0) {
    out.push(
      `No GROQ queries found under ${args.dir}.`,
      "It looks for groq`...` templates and defineQuery(...) calls in .ts, .tsx, .js, .jsx and .mjs files, and skips node_modules, .next, dist and what .gitignore names.",
    );
  } else {
    for (const q of queries) out.push(...shapeLines(q), "");
    if (unreadable.length > 0) {
      out.push(`Could not read ${plural(unreadable.length, "query", "queries")}:`);
      for (const u of unreadable)
        out.push(`  ${u.source.file}:${u.source.line}  ${u.reason}: ${WHY[u.reason]}`);
      out.push("");
    }
    out.push(
      `${plural(queries.length, "shape")} from ${plural(sites.size, "query", "queries")}` +
        (unreadable.length > 0 ? `; ${unreadable.length} could not be read.` : "."),
    );
    if (run) {
      const { result, counts } = run;
      out.push("");
      if (counts && counts.size > 0)
        out.push(
          `Counted the published documents of ${plural(counts.size, "type")} in the dataset: one request each, counts only.`,
          "",
        );
      out.push(
        formatTerminal({
          result: {
            findings: result.findings,
            passed: result.passed,
            failed: [],
            warnings: [],
            couldNotCheck: result.couldNotCheck,
            sampled: {},
          },
          color: deps.color ?? false,
        }).trimEnd(),
      );
    }
  }
  io.stdout.write(`${out.join("\n")}\n`);
  return outcome;
}
