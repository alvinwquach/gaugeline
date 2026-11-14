import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type * as TS from "typescript";
import { ConfigError } from "../errors.js";
import { isIgnored, parseIgnore, type IgnoreFile } from "./ignore.js";

/**
 * Reading source files for `gaugeline query`: the folder walk, the optional TypeScript compiler and
 * the syntax check. Shared by the GROQ extractor and the mutation extractor. Nothing here reaches
 * the network, and mutations.ts imports this file, so it must stay that way.
 */
export type TypeScript = typeof TS;

/** Never entered, whatever a .gitignore says. */
const SKIPPED = new Set(["node_modules", ".next", "dist", ".git"]);

/** What the walk reads. */
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

/**
 * TypeScript is an optional peer dependency of the gaugeline package: the compiler is about 9 MB,
 * more than the whole of Gaugeline, and a page check never needs it.
 */
export async function importTypeScript(): Promise<TypeScript> {
  const mod = await import("typescript");
  return (mod.default ?? mod) as TypeScript;
}

/** The compiler, or the ConfigError that says how to bring it. */
export async function loadCompiler(load: () => Promise<TypeScript>): Promise<TypeScript> {
  return load().catch((cause: unknown) => {
    throw new ConfigError(
      "gaugeline query reads your source files with the TypeScript compiler, and it is not installed next to Gaugeline.",
      {
        hint: "Run it with TypeScript beside it: npx -p gaugeline -p typescript gaugeline query ./src. Or add it to the project: npm install --save-dev typescript.",
        cause,
      },
    );
  });
}

/** The folder to read as an absolute path, or the ConfigError that says it is not one. */
export async function sourceRoot(dir: string): Promise<string> {
  const root = resolve(dir);
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory())
    throw new ConfigError(
      info ? `${dir} is a file, not a folder.` : `The folder ${dir} does not exist.`,
      { hint: "Give the folder that holds your source, for example: gaugeline query ./src" },
    );
  return root;
}

/** The .ts, .tsx, .js, .jsx and .mjs files under `dir` (or the files with `extensions`), as paths relative to it, in order. */
export async function walk(
  dir: string,
  extensions: ReadonlySet<string> = EXTENSIONS,
): Promise<string[]> {
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
      } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
        if (!isIgnored(levels, path, false)) found.push(path);
      }
    }
  };
  await visit("", []);
  // By path, so the order does not depend on how the walk went down a folder.
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export const SCRIPT_KINDS = (ts: TypeScript): Record<string, TS.ScriptKind> => ({
  ".ts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
  ".mjs": ts.ScriptKind.JS,
});

/** The 1-based line of the first syntax error in `text`, or null when it parses. */
export function firstSyntaxError(ts: TypeScript, file: string, text: string): number | null {
  // The parser recovers from a syntax error and keeps going; what it recovers to is a guess.
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
  if (syntax?.file && syntax.start !== undefined)
    return syntax.file.getLineAndCharacterOfPosition(syntax.start).line + 1;
  return null;
}

/** Source text without a byte order mark. */
export const withoutBom = (source: string): string =>
  source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
