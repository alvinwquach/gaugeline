import { extractGroq, type Outcome, type QueryShape, type Unreadable } from "@gaugeline/core";
import { resolve } from "node:path";

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

function shapeLines(q: QueryShape, prefix: string): string[] {
  return [
    `${q.type}  ${shown(prefix, q.source.file)}:${q.source.line}`,
    `  fields: ${q.fields.length === 0 ? "none" : q.fields.map((f) => f.path).join(", ")}`,
    `  drafts: ${q.excludesDrafts ? "left out by the filter" : "not left out by the filter"}`,
    `  params: ${q.params.length === 0 ? "none" : q.params.map((p) => `$${p}`).join(", ")}`,
  ];
}

/**
 * gaugeline query <folder>: the GROQ in a repository, as shapes. One block for each shape (the
 * document type, the fields it reads, whether the filter leaves drafts out, the parameters, and
 * the file and line the query starts on), then the queries that could not be read and why.
 * Reads files only; nothing here can make a request. Exit 0, or 2 (a ConfigError) when the folder
 * does not exist.
 */
export async function runQuery(
  args: { dir: string },
  io: { stdout: { write(s: string): unknown } },
  deps: { cwd: string },
): Promise<Outcome> {
  const found = await extractGroq(resolve(deps.cwd, args.dir));
  // Windows separators and a trailing slash go; "." prints as nothing, so lines read like paths from here.
  const typed = args.dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const prefix = typed === "." ? "" : typed;
  const sites = new Set(found.queries.map((q) => `${q.source.file}:${q.source.line}`));
  const queries = sites.size + found.unreadable.length;
  const out: string[] = [];
  if (queries === 0) {
    out.push(
      `No GROQ queries found under ${args.dir}.`,
      "It looks for groq`...` templates and defineQuery(...) calls in .ts, .tsx, .js, .jsx and .mjs files, and skips node_modules, .next, dist and what .gitignore names.",
    );
  } else {
    for (const q of found.queries) out.push(...shapeLines(q, prefix), "");
    if (found.unreadable.length > 0) {
      out.push(`Could not read ${plural(found.unreadable.length, "query", "queries")}:`);
      for (const u of found.unreadable)
        out.push(
          `  ${shown(prefix, u.source.file)}:${u.source.line}  ${u.reason}: ${WHY[u.reason]}`,
        );
      out.push("");
    }
    out.push(
      `${plural(found.queries.length, "shape")} from ${plural(sites.size, "query", "queries")}` +
        (found.unreadable.length > 0 ? `; ${found.unreadable.length} could not be read.` : "."),
    );
  }
  io.stdout.write(`${out.join("\n")}\n`);
  return { kind: "ran", highFindings: 0, drift: false };
}
