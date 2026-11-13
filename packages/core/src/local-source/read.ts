import type { Dirent } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { ConfigError } from "../errors.js";

/**
 * The local source reader (batch FF): reads the files of a repository that the static checks need
 * (source code, package.json, a lockfile, tsconfig, CI workflow files) from a folder the person
 * named, and hands them to a check as text.
 *
 * It is deliberately not the content adapter. That adapter reads a content folder and refuses
 * package.json, lockfiles and tsconfig on purpose (git-content-source-read.ts); this reader reads
 * exactly those, as another input kind (`local-source`, see run.ts), so one cannot stand in for the
 * other. What it keeps from the adapter: it only reads, it never follows a link, and it stays inside
 * the folder.
 *
 * Rules, all enforced here and tested in __tests__/read.test.ts:
 * - Read only. Nothing is written, run, installed or requested; this file imports no network code.
 * - A symbolic link is never followed (not a file, not a folder), so nothing outside the root is read.
 * - `.env*` files, key files and other secret-looking files are never opened. They are listed by path
 *   and reason, so the report can say "not read", and their text is not kept anywhere. A file whose
 *   text holds a private key is dropped the same way.
 * - node_modules, .git, build output and dot folders are not entered, except .github/workflows.
 * - Size and count limits, so a huge folder cannot exhaust memory. When a limit stops the walk the
 *   tree says `truncated`, and a check must not turn "found nothing" into a pass from it (run.ts
 *   makes sure of that).
 */

/** Why a file the reader met is not in the tree. Reasons are Gaugeline's words, never the file's text. */
export type SkipReason = "secret-looking" | "symlink" | "too-large" | "binary" | "unreadable";

/**
 * A folder's files as text. `files` is a Map from the path under the root (always `/`, never a
 * leading `./`) to its text, so a check looks a file up in constant time and iterates it in path
 * order; `skipped` is a Map from the path to why it was not read, so "absent" and "not read" are
 * told apart.
 */
export interface SourceTree {
  /** The input kind. The content adapter's sources have no such field, so a check cannot be handed one by mistake. */
  kind: "local-source";
  /** The folder as the person typed it, for messages. The reader never reads from it again. */
  label: string;
  files: ReadonlyMap<string, string>;
  skipped: ReadonlyMap<string, SkipReason>;
  /** A limit (file count, total size or depth) stopped the walk: files exist that are not in `files`. */
  truncated: boolean;
}

export interface SourceLimits {
  /** Most files kept. */
  maxFiles: number;
  /** Largest source or config file read, in bytes. */
  maxFileBytes: number;
  /** Largest lockfile read, in bytes: they are big, and the versions of every dependency are in them. */
  maxLockfileBytes: number;
  /** Most bytes kept in all. */
  maxTotalBytes: number;
  /** Deepest folder entered, counting the root as 0. */
  maxDepth: number;
}

export const SOURCE_LIMITS: Readonly<SourceLimits> = Object.freeze({
  maxFiles: 2000,
  maxFileBytes: 512 * 1024,
  maxLockfileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 24 * 1024 * 1024,
  maxDepth: 12,
});

/** Never entered, whatever the folder is called. */
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "bower_components",
]);

/** The one dot folder that is read, and the one folder in it. */
const GITHUB = ".github";
const WORKFLOWS = "workflows";

/** Code and text the static checks read. Anything else (images, fonts, archives) is not opened. */
const READ_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
  ".jsonc",
  ".yml",
  ".yaml",
  ".md",
  ".mdx",
  ".txt",
  ".html",
]);

/** Lockfiles by name; `yarn.lock` has no extension in the list above. */
const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "npm-shrinkwrap.json",
]);

/** Code files: a name with "secret" in it (lib/secrets.ts) is code about secrets, not a secret. */
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

/** Extensions that are a key or a certificate store, whatever the name. */
const KEY_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".ppk"]);

/** Names that are a credential file with no further hint. */
const CREDENTIAL_NAMES = new Set([".npmrc", ".netrc", ".pgpass", ".htpasswd", ".git-credentials"]);

/** For a data file (.json, .yml, .txt, ...): a name that says it holds secrets or credentials. */
const SECRET_WORDS =
  /(^|[._-])(secrets?|credentials?|service[-_]?account|private[-_]?key)([._-]|$)/i;

/** A private key block inside a file's text. Built in pieces so this file holds no key-shaped literal. */
const PRIVATE_KEY_BLOCK = new RegExp(`-----BEGIN ${"[A-Z ]*"}PRIVATE KEY-----`);

/**
 * True when the file name says it holds a secret: `.env` and `.env.*` (so `.env.example` too: it is
 * easy to fill in the real value there), key and certificate-store files, ssh keys, `.npmrc` and
 * its kin, and data files called secrets or credentials. Source code is never refused by its name.
 */
export function isSecretLookingName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) return true;
  if (CREDENTIAL_NAMES.has(lower)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(lower)) return true;
  const ext = extname(lower);
  if (KEY_EXTENSIONS.has(ext)) return true;
  if (CODE_EXTENSIONS.has(ext)) return false;
  return SECRET_WORDS.test(lower);
}

const byName = <T extends { name: string }>(a: T, b: T): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** The paths in `tree` that `accept` takes (all of them with no test), in path order. */
export function sourcePaths(tree: SourceTree, accept?: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const path of tree.files.keys()) if (accept === undefined || accept(path)) out.push(path);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The real path of the folder, or the ConfigError that says it is not one. */
async function folderRoot(dir: string, label: string): Promise<string> {
  const abs = resolve(dir);
  const info = await stat(abs).catch(() => null);
  if (info === null || !info.isDirectory())
    throw new ConfigError(
      info === null ? `The folder ${label} does not exist.` : `${label} is a file, not a folder.`,
      { hint: "Give the folder that holds your site's source, for example: ./my-site" },
    );
  // A link given as the folder itself is followed once: the person named it. Nothing below it is.
  return realpath(abs);
}

/**
 * Reads the folder `dir` into a SourceTree. `label` is the folder as typed (default: `dir`), kept for
 * messages. Throws a ConfigError only when the folder is not one; everything inside it that cannot
 * be read becomes a `skipped` entry, so one odd file never stops a run.
 */
export async function readLocalSource(
  dir: string,
  limits: SourceLimits = SOURCE_LIMITS,
  label: string = dir,
): Promise<SourceTree> {
  const base = await folderRoot(dir, label);
  const files = new Map<string, string>();
  const skipped = new Map<string, SkipReason>();
  let total = 0;
  let truncated = false;

  /** Reads one regular file; false when a limit has stopped the walk. */
  const take = async (path: string, abs: string, isLock: boolean): Promise<boolean> => {
    if (files.size >= limits.maxFiles) return false;
    const info = await lstat(abs).catch(() => null);
    if (info === null) {
      skipped.set(path, "unreadable");
      return true;
    }
    // Between listing the folder and now the entry may have become a link.
    if (info.isSymbolicLink() || !info.isFile()) {
      skipped.set(path, info.isSymbolicLink() ? "symlink" : "unreadable");
      return true;
    }
    if (info.size > (isLock ? limits.maxLockfileBytes : limits.maxFileBytes)) {
      skipped.set(path, "too-large");
      return true;
    }
    if (total + info.size > limits.maxTotalBytes) return false;
    let bytes: Buffer;
    try {
      bytes = await readFile(abs);
      // The path must still resolve to itself under the root: no link anywhere on it.
      if (
        relative(base, await realpath(abs))
          .split(sep)
          .join("/") !== path
      ) {
        skipped.set(path, "symlink");
        return true;
      }
    } catch {
      skipped.set(path, "unreadable");
      return true;
    }
    if (bytes.includes(0)) {
      skipped.set(path, "binary");
      return true;
    }
    const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
    if (PRIVATE_KEY_BLOCK.test(text)) {
      skipped.set(path, "secret-looking");
      return true;
    }
    total += bytes.length;
    files.set(path, text);
    return true;
  };

  /** Walks one folder; false when a limit has stopped the walk, so no sibling is read after it. */
  const visit = async (rel: string, depth: number): Promise<boolean> => {
    if (depth > limits.maxDepth) {
      // Only this folder is left out; its siblings are still read.
      truncated = true;
      return true;
    }
    const entries = await readdir(rel === "" ? base : join(base, ...rel.split("/")), {
      withFileTypes: true,
    }).catch(() => [] as Dirent[]);
    entries.sort(byName);
    for (const entry of entries) {
      const name = entry.name;
      const path = rel === "" ? name : `${rel}/${name}`;
      if (entry.isSymbolicLink()) {
        skipped.set(path, "symlink");
        continue;
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(name)) continue;
        // Only .github/workflows among the dot folders; the rest (.git, .next, .vercel, ...) are not source.
        if (rel === GITHUB) {
          if (name !== WORKFLOWS) continue;
        } else if (name.startsWith(".") && !(rel === "" && name === GITHUB)) {
          continue;
        }
        if (!(await visit(path, depth + 1))) return false;
        continue;
      }
      if (!entry.isFile()) continue;
      // A secret-looking name is refused before its extension is looked at: a .pem is not source.
      if (isSecretLookingName(name)) {
        skipped.set(path, "secret-looking");
        continue;
      }
      const isLock = LOCKFILES.has(name);
      if (!isLock && !READ_EXTENSIONS.has(extname(name).toLowerCase())) continue;
      // Other dot files (.gitignore, .editorconfig) are not what the checks read.
      if (name.startsWith(".")) continue;
      if (rel === GITHUB) continue;
      if (!(await take(path, join(base, ...path.split("/")), isLock))) {
        truncated = true;
        return false;
      }
    }
    return true;
  };

  await visit("", 0);
  return { kind: "local-source", label, files, skipped, truncated };
}
