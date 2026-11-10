import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type * as TS from "typescript";
import { ConfigError } from "../errors.js";
import { isIgnored, parseIgnore, type IgnoreFile } from "./ignore.js";
import { readGroq, type QueryShape, type SourceRef, type Unreadable } from "./shape.js";

export type { FieldUse, QueryShape, SourceRef, Unreadable } from "./shape.js";

type TypeScript = typeof TS;

/** Every GROQ query found under a folder, read into shapes, and every one that could not be read. */
export interface GroqExtraction {
  queries: QueryShape[];
  unreadable: Unreadable[];
}

export interface ExtractOptions {
  /** Tests: how the TypeScript compiler is loaded. */
  loadTypeScript?: () => Promise<TypeScript>;
}

/** Never entered, whatever a .gitignore says. */
const SKIPPED = new Set(["node_modules", ".next", "dist", ".git"]);

/** What the walk reads. */
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

/**
 * TypeScript is an optional peer dependency of the gaugeline package: the compiler is about 9 MB,
 * more than the whole of Gaugeline, and a page check never needs it.
 */
async function importTypeScript(): Promise<TypeScript> {
  const mod = await import("typescript");
  return (mod.default ?? mod) as TypeScript;
}

/** The .ts, .tsx, .js, .jsx and .mjs files under `dir`, as paths relative to it, in order. */
async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (rel: string, ignores: readonly IgnoreFile[]): Promise<void> => {
    const here = rel === "" ? dir : join(dir, rel);
    let levels = ignores;
    try {
      const text = await readFile(join(here, ".gitignore"), "utf8");
      levels = [...ignores, parseIgnore(text, rel)];
    } catch {
      // No .gitignore in this folder.
    }
    const entries = await readdir(here, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      // A link is not followed: it can lead out of the folder, or back into it.
      if (entry.isSymbolicLink()) continue;
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIPPED.has(entry.name) || isIgnored(levels, path, true)) continue;
        await visit(path, levels);
      } else if (entry.isFile() && EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        if (!isIgnored(levels, path, false)) found.push(path);
      }
    }
  };
  await visit("", []);
  // By path, so the order does not depend on how the walk went down a folder.
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
  const root = resolve(dir);
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory())
    throw new ConfigError(
      info ? `${dir} is a file, not a folder.` : `The folder ${dir} does not exist.`,
      { hint: "Give the folder that holds your source, for example: gaugeline query ./src" },
    );
  const ts = await (options.loadTypeScript ?? importTypeScript)().catch((cause: unknown) => {
    throw new ConfigError(
      "gaugeline query reads your source files with the TypeScript compiler, and it is not installed next to Gaugeline.",
      {
        hint: "Run it with TypeScript beside it: npx -p gaugeline -p typescript gaugeline query ./src. Or add it to the project: npm install --save-dev typescript.",
        cause,
      },
    );
  });
  const result: GroqExtraction = { queries: [], unreadable: [] };

  for (const file of await walk(root)) {
    const found = readQueries(ts, file, await readFile(join(root, file), "utf8"));
    result.queries.push(...found.queries);
    result.unreadable.push(...found.unreadable);
  }
  return result;
}

const SCRIPT_KINDS = (ts: TypeScript): Record<string, TS.ScriptKind> => ({
  ".ts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
  ".mjs": ts.ScriptKind.JS,
});

/** The queries in one file. */
function readQueries(ts: TypeScript, file: string, source: string): GroqExtraction {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const kind = SCRIPT_KINDS(ts)[extname(file).toLowerCase()] ?? ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const out: GroqExtraction = { queries: [], unreadable: [] };
  const at = (node: TS.Node): SourceRef => ({
    file,
    line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
  });

  // The parser recovers from a syntax error and keeps going; what it recovers to is a guess, so a
  // file with one is reported once and none of its queries are read.
  const syntax = ts
    .transpileModule(text, {
      fileName: file,
      reportDiagnostics: true,
      compilerOptions: {
        allowJs: true,
        jsx: ts.JsxEmit.Preserve,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
      },
    })
    .diagnostics?.find(
      (d) =>
        d.category === ts.DiagnosticCategory.Error && d.file !== undefined && d.start !== undefined,
    );
  if (syntax?.file && syntax.start !== undefined) {
    out.unreadable.push({
      reason: "parse-error",
      source: {
        file,
        line: syntax.file.getLineAndCharacterOfPosition(syntax.start).line + 1,
      },
    });
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
