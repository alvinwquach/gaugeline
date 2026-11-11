import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { getJson, isRecord } from "../connectors/get-json.js";
import type { Fetcher } from "../fetcher.js";
import { AdapterCouldNotCheck } from "./types.js";
import { kindOf } from "./git-content-parse.js";

/**
 * Where the files of a content folder are read from: a folder on this computer, or a repository on
 * GitHub. Both only read. Both give the same two things: the list of content files under a folder
 * (cheap: names and sizes) and the text of one of them.
 */

/** Bounds a run keeps to. There are no flags to raise them. */
export const GIT_CONTENT_LIMITS: Readonly<{
  files: number;
  fileBytes: number;
  githubFiles: number;
  depth: number;
}> = {
  /** Content files read from one folder. More is could-not-check, never a count of part of it. */
  files: 5000,
  /** One file, in bytes. A bigger one is not read and is listed as unread. */
  fileBytes: 1_048_576,
  /** Content files read from one folder of a GitHub repository (each is one request). */
  githubFiles: 300,
  /** Folders deep, under a content folder. */
  depth: 12,
};

export interface SourceFile {
  /** From the repository root, with "/" separators. */
  path: string;
  size: number;
  /** GitHub only: the blob's sha. */
  sha?: string;
}

export interface Unread {
  path: string;
  reason: string;
}

export interface Listing {
  files: SourceFile[];
  /** Files that were there and were not read, with why. */
  unread: Unread[];
}

/** A file that could not be read when it was opened: it grew past the bound, or is not a plain file any more. `message` is the reason. */
export class FileNotRead extends Error {}

export interface ContentSource {
  list(dir: string): Promise<Listing>;
  read(file: SourceFile): Promise<string>;
}

const SKIPPED_DIRS = new Set([".git", "node_modules", "_drafts"]);
const toPosix = (p: string): string => p.split(path.sep).join("/");
const byPath = (a: SourceFile, b: SourceFile): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
/** Files whose name starts with "_" are not content in these generators (Hugo's _index.md, Astro's ignored files). */
const isContentName = (name: string): boolean =>
  !name.startsWith("_") && kindOf(name) !== undefined;

const kib = (n: number): string => `${Math.round(n / 1024)} KiB`;
const tooBig = (n: number): string => `is larger than ${kib(n)}`;

/**
 * A folder on this computer, read from `root`. A content folder is a relative path under it with no
 * `..`; what is read is checked against the real path of the root, and a symbolic link is never followed
 * (neither a folder nor a file), so nothing outside the root is read.
 */
export function localSource(root: string, limits = GIT_CONTENT_LIMITS): ContentSource {
  let realRoot: string | undefined;
  const rootOrThrow = async (): Promise<string> => {
    if (realRoot !== undefined) return realRoot;
    try {
      realRoot = await realpath(path.resolve(root));
      return realRoot;
    } catch {
      throw new AdapterCouldNotCheck(
        `The folder given as "path" does not exist or cannot be read: ${root}`,
      );
    }
  };
  const inside = (base: string, target: string): boolean => {
    const rel = path.relative(base, target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };

  async function list(dir: string): Promise<Listing> {
    const base = await rootOrThrow();
    const segments = dir.split("/").filter((s) => s !== "" && s !== ".");
    if (segments.some((s) => s === "..") || path.isAbsolute(dir))
      throw new AdapterCouldNotCheck(`The folder "${dir}" is not inside the repository.`);
    const start = path.join(base, ...segments);
    let startReal: string;
    try {
      startReal = await realpath(start);
    } catch {
      throw new AdapterCouldNotCheck(`The folder "${dir}" does not exist under ${root}.`);
    }
    if (!inside(base, startReal))
      throw new AdapterCouldNotCheck(
        `The folder "${dir}" leads outside the repository (a link), so it was not read.`,
      );
    const files: SourceFile[] = [];
    const unread: Unread[] = [];
    const walk = async (abs: string, depth: number): Promise<void> => {
      if (depth > limits.depth) {
        unread.push({ path: toPosix(path.relative(base, abs)), reason: "is nested too deeply" });
        return;
      }
      const entries = await readdir(abs, { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const child = path.join(abs, entry.name);
        const rel = toPosix(path.relative(base, child));
        if (entry.isSymbolicLink()) {
          unread.push({ path: rel, reason: "is a link, which is never followed" });
        } else if (entry.isDirectory()) {
          if (!SKIPPED_DIRS.has(entry.name)) await walk(child, depth + 1);
        } else if (entry.isFile() && isContentName(entry.name)) {
          const size = (await lstat(child)).size;
          if (size > limits.fileBytes)
            unread.push({ path: rel, reason: `is larger than ${kib(limits.fileBytes)}` });
          else files.push({ path: rel, size });
          if (files.length + unread.length > limits.files)
            throw new AdapterCouldNotCheck(
              `The folder "${dir}" has more than ${limits.files} content files, which is as many as Gaugeline reads from one folder.`,
            );
        }
      }
    };
    try {
      await walk(startReal, 0);
    } catch (err) {
      if (err instanceof AdapterCouldNotCheck) throw err;
      throw new AdapterCouldNotCheck(`The folder "${dir}" could not be read.`);
    }
    files.sort(byPath);
    return { files, unread };
  }

  async function read(file: SourceFile): Promise<string> {
    const base = await rootOrThrow();
    const abs = path.join(base, ...file.path.split("/"));
    // Checked again at the moment of reading: the real path is inside the root, and the file is opened without following a link.
    const real = await realpath(abs).catch(() => undefined);
    if (real === undefined || !inside(base, real))
      throw new AdapterCouldNotCheck(
        `"${file.path}" leads outside the repository, so it was not read.`,
      );
    const handle = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
      () => undefined,
    );
    if (handle === undefined)
      throw new FileNotRead("could not be opened (it is gone or is a link)");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limits.fileBytes)
        throw new FileNotRead(tooBig(limits.fileBytes));
      const buffer = Buffer.alloc(Math.min(stat.size, limits.fileBytes) + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > limits.fileBytes) throw new FileNotRead(tooBig(limits.fileBytes));
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  }

  return { list, read };
}

/** Where the GitHub API lives. The token is sent here and nowhere else. */
export const GITHUB_API = "https://api.github.com";

const OWNER_OR_REPO = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const REF = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/;
const SHA = /^[0-9a-f]{40,64}$/;

export interface GitHubSourceOptions {
  fetcher: Fetcher;
  /** "owner/name". */
  repo: string;
  /** A branch, tag or commit. Default "HEAD", the repository's default branch. */
  ref?: string | undefined;
  /** A token with Contents: read, or undefined to read a public repository. Sent in a header to api.github.com only. */
  token?: string | undefined;
  sleep: (ms: number) => Promise<void>;
  limits?: typeof GIT_CONTENT_LIMITS;
}

/**
 * A repository on GitHub, read with GET: the git tree once (`GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1`)
 * and each content file as a blob (`GET /repos/{owner}/{repo}/git/blobs/{sha}`). Every address is built
 * here from api.github.com and validated parts, so the token cannot be sent anywhere else; the fetcher
 * drops it on a redirect to another origin.
 */
export function githubSource(options: GitHubSourceOptions): ContentSource {
  const { fetcher, sleep } = options;
  const limits = options.limits ?? GIT_CONTENT_LIMITS;
  const [owner = "", name = "", extra] = options.repo.split("/");
  const ref = options.ref ?? "HEAD";
  if (
    extra !== undefined ||
    !OWNER_OR_REPO.test(owner) ||
    !OWNER_OR_REPO.test(name) ||
    !REF.test(ref) ||
    ref.includes("..")
  )
    throw new AdapterCouldNotCheck(
      '"github.repo" must be "owner/name", and "ref" a branch, tag or commit name.',
    );
  const token = (options.token ?? "").trim();
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  const get = async (apiPath: string): Promise<Record<string, unknown>> => {
    const { body } = await getJson(
      {
        fetcher,
        request: {
          ...(token !== "" ? { authorization: `Bearer ${token}` } : {}),
          headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        },
        sleep,
        system: "GitHub",
      },
      `${GITHUB_API}${apiPath}`,
    );
    if (!isRecord(body))
      throw new AdapterCouldNotCheck("GitHub answered with something that is not an object.");
    return body;
  };

  let tree: Promise<Array<{ path: string; size: number; sha: string }>> | undefined;
  const loadTree = (): Promise<Array<{ path: string; size: number; sha: string }>> => {
    tree ??= (async () => {
      const body = await get(`${repoPath}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
      if (!Array.isArray(body.tree))
        throw new AdapterCouldNotCheck("GitHub answered with something that is not a file tree.");
      if (body.truncated === true)
        throw new AdapterCouldNotCheck(
          'The repository is too large for GitHub to list in one answer, so its files were not read. Read it from a local clone with "path" instead.',
        );
      const out: Array<{ path: string; size: number; sha: string }> = [];
      for (const raw of body.tree) {
        if (!isRecord(raw) || raw.type !== "blob" || raw.mode === "120000") continue;
        const { path: p, sha, size } = raw;
        if (typeof p !== "string" || typeof sha !== "string" || !SHA.test(sha)) continue;
        out.push({ path: p, sha, size: typeof size === "number" ? size : 0 });
      }
      return out;
    })();
    // A failed read is not kept: the next call asks again.
    tree.catch(() => {
      tree = undefined;
    });
    return tree;
  };

  async function list(dir: string): Promise<Listing> {
    const segments = dir.split("/").filter((s) => s !== "" && s !== ".");
    const prefix = segments.length === 0 ? "" : `${segments.join("/")}/`;
    const files: SourceFile[] = [];
    const unread: Unread[] = [];
    for (const entry of await loadTree()) {
      if (!entry.path.startsWith(prefix)) continue;
      const parts = entry.path.slice(prefix.length).split("/");
      const name = parts.at(-1) ?? "";
      if (parts.slice(0, -1).some((p) => SKIPPED_DIRS.has(p)) || !isContentName(name)) continue;
      if (entry.size > limits.fileBytes)
        unread.push({ path: entry.path, reason: `is larger than ${kib(limits.fileBytes)}` });
      else files.push({ path: entry.path, size: entry.size, sha: entry.sha });
    }
    if (files.length > limits.githubFiles)
      throw new AdapterCouldNotCheck(
        `The folder "${dir}" has ${files.length} content files, more than the ${limits.githubFiles} Gaugeline reads from GitHub (one request each). Read a local clone with "path" instead.`,
      );
    files.sort(byPath);
    return { files, unread };
  }

  async function read(file: SourceFile): Promise<string> {
    if (file.sha === undefined) throw new FileNotRead("has no blob to read");
    const body = await get(`${repoPath}/git/blobs/${file.sha}`);
    if (body.encoding !== "base64" || typeof body.content !== "string")
      throw new AdapterCouldNotCheck(
        "GitHub answered with a file in a form Gaugeline does not read.",
      );
    const bytes = Buffer.from(body.content, "base64");
    if (bytes.length > limits.fileBytes) throw new FileNotRead(tooBig(limits.fileBytes));
    return bytes.toString("utf8");
  }

  return { list, read };
}
