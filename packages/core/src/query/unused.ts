import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative } from "node:path";
import type * as TS from "typescript";
import { escapeInvisible } from "../checks/hidden-text/escape.js";
import type { Finding } from "../model.js";
import {
  GqlSyntaxError,
  parseGraphql,
  type GqlFragment,
  type GqlOperation,
} from "./graphql-parse.js";
import type { SourceRef } from "./shape.js";
import {
  importTypeScript,
  loadCompiler,
  sourceRoot,
  walk,
  withoutBom,
  type TypeScript,
} from "./source.js";
import { Flow } from "./unused-flow.js";
import { emptyQuery, gqlTree, groqTree, type QueryState, type TreeNode } from "./unused-trees.js";

/**
 * Fields a query asks for that the code never reads, in GROQ and in GraphQL. Reads the repository's
 * files with the TypeScript compiler and nothing else: no request, no key, no environment
 * variable. This module and the two it uses (unused-trees.ts, unused-flow.ts) must not import the
 * fetcher, a connector or an HTTP client, and a test fails the build if they ever do.
 */

export interface FetchedField {
  /** The aliases from the root of the result: "author.bio". */
  path: string;
  /** The name the code reads: the last alias in `path`. */
  alias: string;
  /** The query it was fetched by: its file (relative to the folder that was read, with `/`) and line. */
  source: SourceRef;
}

/** A query whose result the walk gave up on, and why. It reports none of the query's fields. */
export interface CouldNotFollow {
  language: "groq" | "graphql";
  source: SourceRef;
  /** A sentence that says where the result went that the walk could not open. */
  reason: string;
}

export interface UnusedAnalysis {
  /** One for each field, in the order of `fields`. */
  findings: Finding[];
  /** The fields that are fetched and never used. */
  fields: FetchedField[];
  couldNotFollow: CouldNotFollow[];
  /** Queries found, followed or not. */
  queries: number;
  /** Source files read. */
  files: number;
}

export interface UnusedOptions {
  /** Tests: how the TypeScript compiler is loaded. */
  loadTypeScript?: () => Promise<TypeScript>;
  /**
   * The folder as the person typed it (`./src`), put in front of every file the analysis names, so a
   * file reads as a path from where the command ran. Default: none, and files are relative to `dir`.
   */
  prefix?: string;
}

/** Never reported: the document's own bookkeeping, which every query may carry and no page needs to read. */
const RESERVED = new Set(["_id", "_type", "_key", "_rev"]);

const CODE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const GQL_FILES = new Set([".graphql", ".gql"]);
const WALKED = new Set([...CODE, ...GQL_FILES]);

/** A query found in the code, with the expression that holds it. */
interface Found {
  state: QueryState;
  anchor: TS.Node | null;
}

const posix = (p: string): string => p.replace(/\\/g, "/");

/** The options the program is built with: no libraries and no packages (they are not read), the project's own paths. */
function compilerOptions(ts: TypeScript, root: string): TS.CompilerOptions {
  const options: TS.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    noEmit: true,
    noLib: true,
    types: [],
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
  };
  // The nearest tsconfig.json, in the folder or one of the three above it: only its paths are used.
  let dir = root;
  for (let i = 0; i < 4; i++, dir = dirname(dir)) {
    const file = join(dir, "tsconfig.json");
    if (!ts.sys.fileExists(file)) continue;
    try {
      const read = ts.readConfigFile(file, ts.sys.readFile);
      if (read.error) break;
      const parsed = ts.parseJsonConfigFileContent(
        read.config,
        {
          useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
          readDirectory: () => [],
          fileExists: ts.sys.fileExists,
          readFile: ts.sys.readFile,
        },
        dirname(file),
      );
      const user = parsed.options as Record<string, unknown>;
      const into = options as Record<string, unknown>;
      for (const key of ["baseUrl", "paths", "pathsBasePath", "rootDirs"])
        if (user[key] !== undefined) into[key] = user[key];
    } catch {
      // A tsconfig that cannot be read leaves the defaults: relative imports still resolve.
    }
    break;
  }
  return options;
}

/** The TypeScript program over the folder's files. Reads source from disk and never anything under node_modules. */
function buildProgram(ts: TypeScript, root: string, files: readonly string[]): TS.Program {
  const options = compilerOptions(ts, root);
  const host = ts.createCompilerHost(options, true);
  const blocked = (f: string): boolean => /[\\/]node_modules[\\/]/.test(f);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (f, ...rest) => (blocked(f) ? undefined : getSourceFile(f, ...rest));
  host.fileExists = (f) => !blocked(f) && ts.sys.fileExists(f);
  host.readFile = (f) => (blocked(f) ? undefined : ts.sys.readFile(f));
  host.directoryExists = (d) => !blocked(d) && ts.sys.directoryExists(d);
  return ts.createProgram(
    files.map((f) => join(root, f)),
    options,
    host,
  );
}

const isGroqTag = (ts: TypeScript, tag: TS.Expression): boolean =>
  (ts.isIdentifier(tag) && tag.text === "groq") ||
  (ts.isPropertyAccessExpression(tag) && tag.name.text === "groq");
const isGqlTag = (ts: TypeScript, tag: TS.Expression): boolean =>
  (ts.isIdentifier(tag) && (tag.text === "gql" || tag.text === "graphql")) ||
  (ts.isPropertyAccessExpression(tag) && (tag.name.text === "gql" || tag.name.text === "graphql"));
const isDefineQuery = (ts: TypeScript, callee: TS.Expression): boolean =>
  (ts.isIdentifier(callee) && callee.text === "defineQuery") ||
  (ts.isPropertyAccessExpression(callee) && callee.name.text === "defineQuery");

/**
 * Follow each query's result through the code and report the fields nothing reads. A field counts
 * as read when a property access or a destructuring reads its alias on a value that came from the
 * query, however far the value travelled (variables, `await`, props to components, `map` callbacks,
 * returns). A query whose result escapes the walk (JSON.stringify, a function from a package, a field
 * read by a name only known at run time) is listed in `couldNotFollow` and none of its fields is
 * reported: a false "never used" sends someone to delete a field the page needs.
 */
export async function analyseUnused(
  dir: string,
  options: UnusedOptions = {},
): Promise<UnusedAnalysis> {
  const root = await sourceRoot(dir);
  const ts = await loadCompiler(options.loadTypeScript ?? importTypeScript);
  const all = await walk(root, WALKED);
  const code = all.filter((f) => CODE.has(extname(f).toLowerCase()));
  const gqlFiles = all.filter((f) => GQL_FILES.has(extname(f).toLowerCase()));

  const program = buildProgram(ts, root, code);
  const typed = posix(options.prefix ?? "").replace(/\/+$/, "");
  const shown = (file: string): string => (typed === "" ? file : `${typed}/${file}`);
  const rel = (fileName: string): string => shown(posix(relative(root, fileName)));
  const own = new Map<string, TS.SourceFile>();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const r = relative(root, sf.fileName);
    if (r.startsWith("..") || isAbsolute(r)) continue;
    own.set(posix(r), sf);
  }
  const names = [...own.keys()].sort();

  // A file that does not parse may be the one that reads a result, so no query can be trusted.
  let unparsed: string | null = null;
  for (const name of names) {
    const bad = program.getSyntacticDiagnostics(own.get(name) as TS.SourceFile)[0];
    if (bad?.file && bad.start !== undefined) {
      unparsed = `${shown(name)}:${bad.file.getLineAndCharacterOfPosition(bad.start).line + 1}`;
      break;
    }
  }

  const found: Found[] = [];
  const fragments = new Map<string, GqlFragment & { file: string }>();
  const operations: Array<{ op: GqlOperation; file: string; anchor: TS.Node | null }> = [];
  const failed = (language: "groq" | "graphql", source: SourceRef, reason: string): void => {
    found.push({ state: emptyQuery(language, source, reason), anchor: null });
  };

  const addGraphql = (text: string, line: number, file: string, anchor: TS.Node | null): void => {
    try {
      const defs = parseGraphql(text, line);
      const ops = defs.filter(
        (d): d is GqlOperation => d.kind === "operation" && d.operation === "query",
      );
      for (const d of defs)
        if (d.kind === "fragment" && !fragments.has(d.name)) fragments.set(d.name, { ...d, file });
      if (anchor !== null && ops.length > 1)
        for (const op of ops)
          failed(
            "graphql",
            { file, line: op.line },
            "it shares a template with other operations, so the code that reads it cannot be told apart",
          );
      else for (const op of ops) operations.push({ op, file, anchor });
    } catch (err) {
      if (!(err instanceof GqlSyntaxError)) throw err;
      failed("graphql", { file, line: err.line }, "it is not valid GraphQL");
    }
  };

  for (const name of names) {
    const sf = own.get(name) as TS.SourceFile;
    const lineOf = (node: TS.Node): number =>
      sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const addGroq = (text: string, node: TS.Node, anchor: TS.Node): void => {
      const source = { file: shown(name), line: lineOf(node) };
      const state = groqTree(text, source);
      if (state === null) failed("groq", source, "it is not valid GROQ");
      else found.push({ state, anchor });
    };
    const visit = (node: TS.Node): void => {
      if (ts.isTaggedTemplateExpression(node) && isGroqTag(ts, node.tag)) {
        if (ts.isNoSubstitutionTemplateLiteral(node.template))
          addGroq(node.template.text, node.template, node);
        else
          failed(
            "groq",
            { file: shown(name), line: lineOf(node.template) },
            "it is built at run time, so its fields cannot be read from the file",
          );
      } else if (
        ts.isCallExpression(node) &&
        isDefineQuery(ts, node.expression) &&
        node.arguments[0]
      ) {
        const arg = node.arguments[0];
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
          addGroq(arg.text, arg, node);
        else if (!(ts.isTaggedTemplateExpression(arg) && isGroqTag(ts, arg.tag)))
          failed(
            "groq",
            { file: shown(name), line: lineOf(arg) },
            "it is built at run time, so its fields cannot be read from the file",
          );
      } else if (ts.isTaggedTemplateExpression(node) && isGqlTag(ts, node.tag)) {
        const tpl = node.template;
        if (ts.isNoSubstitutionTemplateLiteral(tpl))
          addGraphql(tpl.text, lineOf(tpl), shown(name), node);
        else {
          // An interpolated name is a fragment defined elsewhere: its text is left out, its lines kept.
          let joined = tpl.head.text;
          let loose = false;
          for (const span of tpl.templateSpans) {
            if (
              !ts.isIdentifier(span.expression) &&
              !ts.isPropertyAccessExpression(span.expression)
            )
              loose = true;
            joined +=
              "\n".repeat(
                sf.text.slice(span.expression.getFullStart(), span.literal.getStart(sf)).split("\n")
                  .length - 1,
              ) + span.literal.text;
          }
          if (loose)
            failed(
              "graphql",
              { file: shown(name), line: lineOf(tpl) },
              "it is built at run time, so its fields cannot be read from the file",
            );
          else addGraphql(joined, lineOf(tpl), shown(name), node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // .graphql and .gql files: their fragments are shared with the code, their operations cannot be tied to it.
  for (const file of gqlFiles) {
    const text = withoutBom(await readFile(join(root, file), "utf8"));
    addGraphql(text, 1, shown(posix(file)), null);
  }

  for (const { op, file, anchor } of operations) {
    if (anchor === null) {
      failed(
        "graphql",
        { file, line: op.line },
        "it is in a .graphql file, which a bundler loads: Gaugeline cannot tell which code reads it",
      );
      continue;
    }
    const { query, unknown } = gqlTree(op, file, fragments);
    if (unknown.length > 0)
      query.couldNot = `it spreads ${unknown.length === 1 ? "a fragment" : "fragments"} no file defines (${unknown.join(", ")})`;
    found.push({ state: query, anchor });
  }

  // The order the code is written in, the same on every run.
  found.sort((a, b) =>
    a.state.source.file < b.state.source.file
      ? -1
      : a.state.source.file > b.state.source.file
        ? 1
        : a.state.source.line - b.state.source.line,
  );

  if (unparsed !== null)
    for (const f of found)
      f.state.couldNot ??= `${unparsed} does not parse, and the code that reads the result may be in it`;

  const flow = new Flow(ts, program.getTypeChecker(), program, rel);
  for (const f of found) {
    if (f.state.couldNot !== null || f.anchor === null) continue;
    if (f.state.root.children.size === 0) continue; // nothing to read: a count, a list of strings
    try {
      flow.follow(f.state, f.anchor);
    } catch (err) {
      // Code the compiler's API does not expect must not stop the other queries from being read.
      f.state.couldNot = `Gaugeline stopped following it (${err instanceof Error ? err.message : "an unexpected error"})`;
    }
  }

  const findings: Finding[] = [];
  const fields: FetchedField[] = [];
  const couldNotFollow: CouldNotFollow[] = [];
  for (const { state } of found) {
    if (state.couldNot !== null) {
      couldNotFollow.push({
        language: state.language,
        source: { ...state.source },
        reason: state.couldNot,
      });
      continue;
    }
    for (const field of unusedIn(state.root)) {
      findings.push(finding(state, field));
      fields.push({ path: field.path, alias: field.alias, source: { ...state.source } });
    }
  }
  return { findings, fields, couldNotFollow, queries: found.length, files: names.length };
}

/** The nodes nothing read, outermost first: an object nobody read is one field, not each field inside it. */
function unusedIn(node: TreeNode): TreeNode[] {
  const out: TreeNode[] = [];
  for (const child of node.children.values()) {
    if (RESERVED.has(child.alias)) continue;
    if (!child.used) out.push(child);
    else out.push(...unusedIn(child));
  }
  return out;
}

function finding(query: QueryState, field: TreeNode): Finding {
  const path = escapeInvisible(field.path, 80);
  const where = `${escapeInvisible(query.source.file, 200)}:${query.source.line}`;
  const via = field.via
    ? ` \u00B7 in fragment ${escapeInvisible(field.via.name, 60)} (${escapeInvisible(field.via.source.file, 200)}:${field.via.source.line})`
    : "";
  return {
    checkId: "query-field-unused",
    severity: "medium",
    title: `${path} is fetched and never used`,
    evidence: `${path} \u00B7 ${where}${via}`,
    url: `query:${query.source.file}:${query.source.line}`,
    source: { file: query.source.file, line: query.source.line },
  };
}

/** The fields the queries in `dir` fetch and no code reads: one finding for each. */
export async function findUnusedFields(
  dir: string,
  options: UnusedOptions = {},
): Promise<Finding[]> {
  return (await analyseUnused(dir, options)).findings;
}
