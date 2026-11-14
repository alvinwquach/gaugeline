import { ConfigError } from "@gaugeline/core";
import { lstat, mkdir, readFile, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The file system calls `gaugeline query --page` and `--save` make, so a test can watch every one and
 * make one fail. This file is the only place the command writes: three files into one folder (--page)
 * or one baseline file (--save), and the folders they need.
 */
export interface ScaffoldFs {
  /** What is at the path without following a link, or null when nothing is. */
  lstat(path: string): Promise<{
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  } | null>;
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
  /** Creates the folder and the ones above it; gives the first folder it had to make, if any. */
  mkdir(path: string): Promise<string | undefined>;
  /** `wx` fails when the file exists; `w` replaces it. */
  writeFile(path: string, text: string, flag: "wx" | "w"): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
}

/** A file to write: its name inside the folder and its text. The scaffold's three files and the handoff report's three both fit. */
export interface WritableFile {
  name: string;
  text: string;
}

const codeOf = (err: unknown): string => (err as { code?: string }).code ?? "an error";

export const nodeFs: ScaffoldFs = {
  lstat: (path) =>
    lstat(path).catch((err: unknown) => {
      if (codeOf(err) === "ENOENT" || codeOf(err) === "ENOTDIR") return null;
      throw err;
    }),
  realpath: (path) => realpath(path),
  readFile: (path) => readFile(path, "utf8"),
  mkdir: (path) => mkdir(path, { recursive: true }),
  writeFile: (path, text, flag) => writeFile(path, text, { flag }),
  unlink: (path) => unlink(path),
  rmdir: (path) => rmdir(path),
};

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** What --out names, resolved against the folder the command ran in, or the ConfigError that says why not. */
export function resolveOut(cwd: string, out: string): string {
  const target = resolve(cwd, out);
  if (out.includes("\0") || !inside(resolve(cwd), target))
    throw new ConfigError(
      `--out ${JSON.stringify(out)} is outside the folder you ran the command in, so nothing was written.`,
      {
        hint: "--out must be this folder or one inside it, for example --out ./src/app/resource/[slug]. Run the command from the root of your project.",
      },
    );
  return target;
}

/** The nearest folder at or above `path` that exists, as its real path. A link on the way is followed here. */
async function realAncestor(fs: ScaffoldFs, path: string): Promise<string> {
  let current = path;
  for (;;) {
    if ((await fs.lstat(current)) !== null) return fs.realpath(current);
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/** What is already at a target, as `inspectScaffold` found it. */
export interface Inspected {
  /** The folder, as an absolute path. */
  folder: string;
  /** The files that exist and will be replaced (only with force), with the text they have now. */
  replacing: Map<string, string>;
}

/**
 * Everything that can be known without writing: --out is inside the working folder (also after
 * links are followed), it is not a file, and none of the files exists unless `force` is set. A
 * folder, a link or anything else that is not a plain file at a target is refused even with
 * `force`. Reads and writes nothing. One refusal covers all three files, so a half scaffold is
 * never started.
 */
export async function inspectScaffold(
  files: readonly Pick<WritableFile, "name">[],
  out: string,
  opts: { force: boolean; cwd: string; fs?: ScaffoldFs },
): Promise<Inspected> {
  const fs = opts.fs ?? nodeFs;
  const folder = resolveOut(opts.cwd, out);
  const real = await realAncestor(fs, folder);
  if (!inside(await realAncestor(fs, resolve(opts.cwd)), real))
    throw new ConfigError(
      `--out ${JSON.stringify(out)} reaches outside the folder you ran the command in through a link, so nothing was written.`,
      { hint: "Name a real folder inside your project." },
    );
  const info = await fs.lstat(folder);
  if (info !== null && !info.isDirectory())
    throw new ConfigError(`--out ${JSON.stringify(out)} is a file, not a folder.`, {
      hint: `Name the folder ${files.length === 2 ? "the two files" : "the three files"} should go in.`,
    });
  const replacing = new Map<string, string>();
  const existing: string[] = [];
  for (const file of files) {
    const path = join(folder, file.name);
    const found = await fs.lstat(path);
    if (found === null) continue;
    if (!found.isFile())
      throw new ConfigError(
        `${file.name} in ${JSON.stringify(out)} is a ${found.isSymbolicLink() ? "link" : "folder"}, not a file, so nothing was written.`,
        { hint: "Move it or choose another --out. --force never replaces a folder or a link." },
      );
    if (opts.force) replacing.set(path, await fs.readFile(path));
    else existing.push(file.name);
  }
  if (existing.length > 0)
    throw new ConfigError(
      `${existing.join(", ")} already ${existing.length === 1 ? "exists" : "exist"} in ${JSON.stringify(out)}, so nothing was written.`,
      {
        hint: `Choose another --out, or add --force to replace ${files.length === 2 ? "the two files" : "the three files"}.`,
      },
    );
  return { folder, replacing };
}

/**
 * The folders `mkdir` will have to make for `folder`, deepest first: `folder` and each parent that is
 * not there yet. Worked out here, from the same path strings the rest of this file uses, rather than
 * read from what `mkdir` returns, so cleaning up does not depend on how the platform spells a path.
 */
async function missingFolders(fs: ScaffoldFs, folder: string): Promise<string[]> {
  const missing: string[] = [];
  for (let dir = folder; (await fs.lstat(dir)) === null; dir = dirname(dir)) {
    missing.push(dir);
    if (dirname(dir) === dir) break;
  }
  return missing;
}

/**
 * Write the files into `out`: all of them or none. Every target is checked first (`inspectScaffold`),
 * the folder is created if it is missing, and each file is written with `wx`, which fails if the
 * file appeared meanwhile. If any write fails, the files this run wrote are removed, a file that
 * `force` replaced is put back as it was, and the folders this run created are removed again, so a
 * failure leaves the folder as it was found. Returns the absolute paths it wrote, in order.
 */
export async function writeScaffold(
  files: readonly WritableFile[],
  out: string,
  opts: { force: boolean; cwd?: string; fs?: ScaffoldFs },
): Promise<string[]> {
  const fs = opts.fs ?? nodeFs;
  const cwd = opts.cwd ?? process.cwd();
  const { folder, replacing } = await inspectScaffold(files, out, { ...opts, cwd, fs });
  const wrote: string[] = [];
  const made = await missingFolders(fs, folder);
  try {
    await fs.mkdir(folder);
    for (const file of files) {
      const path = join(folder, file.name);
      await fs.writeFile(path, file.text, replacing.has(path) ? "w" : "wx");
      wrote.push(path);
    }
    return wrote;
  } catch (err) {
    // Put the folder back as it was found. A step that fails here is left: the message says so.
    const left: string[] = [];
    for (const path of wrote.reverse()) {
      const before = replacing.get(path);
      try {
        if (before === undefined) await fs.unlink(path);
        else await fs.writeFile(path, before, "w");
      } catch {
        left.push(path);
      }
    }
    // Deepest first. One that is already gone (mkdir stopped before it) is skipped; any other
    // failure stops here and leaves the rest.
    for (const dir of made) {
      try {
        await fs.rmdir(dir);
      } catch (e) {
        if (codeOf(e) !== "ENOENT") break;
      }
    }
    const code = codeOf(err);
    throw new ConfigError(
      left.length === 0
        ? `Could not write to ${JSON.stringify(out)} (${code}). Nothing was written.`
        : `Could not write to ${JSON.stringify(out)} (${code}), and could not remove ${left.length} of the files it had started: ${left.join(", ")}.`,
      {
        hint:
          code === "EEXIST"
            ? "A file appeared while it was writing. Run the command again."
            : "Choose a folder you can write to, and check its permissions.",
        cause: err,
      },
    );
  }
}

/** What `--save` found at its target, before anything is written. */
export interface InspectedFile {
  /** The file, as an absolute path. */
  path: string;
  /** The text it has now, when it exists and `force` will replace it. */
  before: string | undefined;
}

/**
 * Everything that can be known about `gaugeline query --save <file>` without writing: the file is the
 * working folder or inside it (also after links are followed), it is not a folder or a link, and it
 * does not exist unless `force` is set. Reads and writes nothing.
 */
export async function inspectBaselineFile(
  typed: string,
  opts: { force: boolean; cwd: string; fs?: ScaffoldFs; flag?: string; example?: string },
): Promise<InspectedFile> {
  const fs = opts.fs ?? nodeFs;
  // Which flag named the file, for the messages: --save for a query baseline, --out for a work order.
  const flag = opts.flag ?? "--save";
  const example = opts.example ?? "before.json";
  const path = resolve(opts.cwd, typed);
  if (typed.includes("\0") || !inside(resolve(opts.cwd), path) || path === resolve(opts.cwd))
    throw new ConfigError(
      `${flag} ${JSON.stringify(typed)} is not a file inside the folder you ran the command in, so nothing was written.`,
      {
        hint: `${flag} names a file in this folder or one inside it, for example ${flag} ${example}. Run the command from the root of your project.`,
      },
    );
  const real = await realAncestor(fs, dirname(path));
  if (!inside(await realAncestor(fs, resolve(opts.cwd)), real))
    throw new ConfigError(
      `${flag} ${JSON.stringify(typed)} reaches outside the folder you ran the command in through a link, so nothing was written.`,
      { hint: "Name a real file inside your project." },
    );
  const parent = await fs.lstat(dirname(path));
  if (parent !== null && !parent.isDirectory())
    throw new ConfigError(
      `${JSON.stringify(dirname(typed))} is not a folder, so ${JSON.stringify(typed)} was not written.`,
      { hint: "Name a file in a folder that exists, or one that can be made." },
    );
  const found = await fs.lstat(path);
  if (found === null) return { path, before: undefined };
  if (!found.isFile())
    throw new ConfigError(
      `${JSON.stringify(typed)} is a ${found.isSymbolicLink() ? "link" : "folder"}, not a file, so nothing was written.`,
      { hint: "Choose another name. --force never replaces a folder or a link." },
    );
  if (!opts.force)
    throw new ConfigError(`${JSON.stringify(typed)} already exists, so nothing was written.`, {
      hint: "Choose another name, or add --force to replace the file.",
    });
  return { path, before: await fs.readFile(path) };
}

/**
 * Write the baseline: one file, or nothing. The target is checked first (`inspectBaselineFile`), its
 * folders are made if they are missing, and the file is written with `wx` (`w` when `force` replaces
 * one), which fails if a file appeared meanwhile. If the write fails, the file is removed or put back
 * as it was and the folders this run made are removed again. Returns the absolute path it wrote.
 */
export async function writeBaselineFile(
  typed: string,
  text: string,
  opts: { force: boolean; cwd?: string; fs?: ScaffoldFs; flag?: string; example?: string },
): Promise<string> {
  const fs = opts.fs ?? nodeFs;
  const cwd = opts.cwd ?? process.cwd();
  const { path, before } = await inspectBaselineFile(typed, { ...opts, cwd, fs });
  const made = await missingFolders(fs, dirname(path));
  try {
    await fs.mkdir(dirname(path));
    await fs.writeFile(path, text, before === undefined ? "wx" : "w");
    return path;
  } catch (err) {
    let left = false;
    try {
      if (before === undefined) await fs.unlink(path);
      else await fs.writeFile(path, before, "w");
    } catch (e) {
      if (codeOf(e) !== "ENOENT") left = true;
    }
    for (const dir of made) {
      try {
        await fs.rmdir(dir);
      } catch (e) {
        if (codeOf(e) !== "ENOENT") break;
      }
    }
    const code = codeOf(err);
    throw new ConfigError(
      left
        ? `Could not write ${JSON.stringify(typed)} (${code}), and could not take back what it had started: check the file.`
        : `Could not write ${JSON.stringify(typed)} (${code}). Nothing was written.`,
      {
        hint:
          code === "EEXIST"
            ? "A file appeared while it was writing. Run the command again."
            : "Choose a folder you can write to, and check its permissions.",
        cause: err,
      },
    );
  }
}
