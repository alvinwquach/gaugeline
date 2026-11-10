import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type * as TS from "typescript";
import { readGroq, type QueryShape, type SourceRef, type Unreadable } from "./shape.js";

export type { FieldUse, QueryShape, SourceRef, Unreadable } from "./shape.js";
import {
  SCRIPT_KINDS,
  firstSyntaxError,
  importTypeScript,
  loadCompiler,
  sourceRoot,
  walk,
  withoutBom,
  type TypeScript,
} from "./source.js";

/** Every GROQ query found under a folder, read into shapes, and every one that could not be read. */
export interface GroqExtraction {
  queries: QueryShape[];
  unreadable: Unreadable[];
}

export interface ExtractOptions {
  /** Tests: how the TypeScript compiler is loaded. */
  loadTypeScript?: () => Promise<TypeScript>;
}

/**
 * Find the GROQ in the files under `dir` and read each query into the shapes it asks for: the
 * type, the fields it reads, whether it leaves drafts out and its parameters. Finds `groq` tagged
 * templates and `defineQuery("...")` calls with the TypeScript compiler, parses each string with
 * groq-js and sends nothing anywhere. A query built at run time, a file that does not parse and a
 * query with no `_type` filter come back in `unreadable`, with where they are.
 */
export async function extractGroq(
  dir: string,
  options: ExtractOptions = {},
): Promise<GroqExtraction> {
  const root = await sourceRoot(dir);
  const ts = await loadCompiler(options.loadTypeScript ?? importTypeScript);
  const result: GroqExtraction = { queries: [], unreadable: [] };

  for (const file of await walk(root)) {
    const found = readQueries(ts, file, await readFile(join(root, file), "utf8"));
    result.queries.push(...found.queries);
    result.unreadable.push(...found.unreadable);
  }
  return result;
}

/** The queries in one file. */
function readQueries(ts: TypeScript, file: string, source: string): GroqExtraction {
  const text = withoutBom(source);
  const kind = SCRIPT_KINDS(ts)[extname(file).toLowerCase()] ?? ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const out: GroqExtraction = { queries: [], unreadable: [] };
  const at = (node: TS.Node): SourceRef => ({
    file,
    line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
  });

  // A file with a syntax error is reported once and none of its queries are read.
  const bad = firstSyntaxError(ts, file, text);
  if (bad !== null) {
    out.unreadable.push({ reason: "parse-error", source: { file, line: bad } });
    return out;
  }

  const isGroqTag = (tag: TS.Expression): boolean =>
    (ts.isIdentifier(tag) && tag.text === "groq") ||
    (ts.isPropertyAccessExpression(tag) && tag.name.text === "groq");
  const isDefineQuery = (callee: TS.Expression): boolean =>
    (ts.isIdentifier(callee) && callee.text === "defineQuery") ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === "defineQuery");
  const unparenthesised = (e: TS.Expression): TS.Expression => {
    let cur = e;
    while (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur)
    )
      cur = cur.expression;
    return cur;
  };
  const add = (query: string, source: SourceRef): void => {
    const read = readGroq(query, source);
    out.queries.push(...read.shapes);
    out.unreadable.push(...read.unreadable);
  };

  const visit = (node: TS.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && isGroqTag(node.tag)) {
      // The line of the opening backtick, not of the tag.
      if (ts.isNoSubstitutionTemplateLiteral(node.template))
        add(node.template.text, at(node.template));
      else out.unreadable.push({ reason: "concatenated", source: at(node.template) });
    } else if (ts.isCallExpression(node) && isDefineQuery(node.expression) && node.arguments[0]) {
      const arg = unparenthesised(node.arguments[0]);
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
        add(arg.text, at(arg));
      // A groq`...` inside is found when the walk reaches it, as itself.
      else if (!(ts.isTaggedTemplateExpression(arg) && isGroqTag(arg.tag)))
        out.unreadable.push({ reason: "concatenated", source: at(arg) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
