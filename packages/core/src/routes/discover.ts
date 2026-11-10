import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  gateHint,
  matcherCovers,
  matcherProblems,
  readMatcher,
  type MatcherRead,
} from "./matcher.js";
import { findSessionHelper, scanSource } from "./scan.js";

/**
 * The routes of a Next.js app directory, read from the repository and not from the site. A crawler
 * follows links and so never finds the route nothing links to, which is the route this check is
 * for; the file tree lists them all. Only the app directory is understood.
 */

export interface RouteEntry {
  /** The address the route serves, route groups dropped: `/account/invoices`, `/shop/[slug]`. */
  path: string;
  /** The route file, relative to the folder given, with forward slashes. */
  file: string;
  /** A segment is in square brackets: the route needs a real id to be asked for. */
  dynamic: boolean;
  /** The code treats the route as signed-in only: a middleware matcher or a session helper covers it. */
  expectsSession: boolean;
  /** Which of those, in words, when expectsSession is true. */
  reason?: string;
}

export interface RouteDiscovery {
  routes: RouteEntry[];
  /** The app folder that was read, relative to the folder given ("app", "src/app", or "." for the folder itself). */
  appDir?: string;
  /** What the run could not read or chose not to rely on, one plain sentence each. */
  notes: string[];
}

const SKIPPED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "dist",
  "coverage",
]);
const CODE_EXT = "(?:[cm]?[jt]s|[jt]sx|mdx?)";
const PAGE_FILE = new RegExp(`^page\\.${CODE_EXT}$`);
const ROUTE_FILE = /^route\.(?:[cm]?[jt]s|[jt]sx)$/;
const LAYOUT_FILE = /^layout\.(?:[cm]?[jt]s|[jt]sx)$/;
const MIDDLEWARE_FILE = /^(?:middleware|proxy)\.(?:[cm]?[jt]s|[jt]sx)$/;
const MAX_ENTRIES = 20_000;
const MAX_FILE_BYTES = 1024 * 1024;

const posix = (p: string): string => p.split(sep).join("/");

/** The app folder inside `dir`: `dir` itself when it is called app, else `app` or `src/app`. */
export async function findAppDir(dir: string): Promise<string | undefined> {
  const root = resolve(dir);
  const candidates = [
    ...(basename(root) === "app" ? [root] : []),
    join(root, "app"),
    join(root, "src", "app"),
  ];
  for (const c of candidates) {
    const info = await stat(c).catch(() => undefined);
    if (info?.isDirectory()) return c;
  }
  return undefined;
}

interface Found {
  kind: "page" | "route" | "layout";
  /** Folder names from the app folder, route groups included. */
  dirs: string[];
  full: string;
}

async function walk(appDir: string): Promise<{ found: Found[]; truncated: boolean }> {
  const found: Found[] = [];
  let seen = 0;
  let truncated = false;
  const visit = async (dirs: string[]): Promise<void> => {
    const entries = await readdir(join(appDir, ...dirs), { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (seen >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      seen += 1;
      if (e.isDirectory()) {
        const name = e.name;
        // Private folders, parallel-route slots and intercepting routes are not addresses of their own.
        if (
          SKIPPED_DIRS.has(name) ||
          name.startsWith("_") ||
          name.startsWith("@") ||
          name.startsWith(".") ||
          /^\(\.{1,3}\)/.test(name)
        )
          continue;
        await visit([...dirs, name]);
      } else if (e.isFile()) {
        const kind = PAGE_FILE.test(e.name)
          ? "page"
          : ROUTE_FILE.test(e.name)
            ? "route"
            : LAYOUT_FILE.test(e.name)
              ? "layout"
              : undefined;
        if (kind) found.push({ kind, dirs, full: join(appDir, ...dirs, e.name) });
      }
    }
  };
  await visit([]);
  return { found, truncated };
}

async function read(file: string): Promise<string | undefined> {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_FILE_BYTES) return undefined;
  return readFile(file, "utf8").catch(() => undefined);
}

/**
 * Read the routes of the Next.js app directory in `dir`: every `page` and `route` file becomes a
 * path, route groups `(name)` are not part of it and a segment in square brackets marks it dynamic.
 * A route expects a session when a middleware that looks like a gate has a matcher covering it, or
 * its own file or a layout above it (the root layout aside, which wraps every page) calls a session
 * helper. The route and layout files and the middleware are read as text and never run.
 */
export async function readRoutes(dir: string): Promise<RouteDiscovery> {
  const root = resolve(dir);
  const appDir = await findAppDir(root);
  if (!appDir) return { routes: [], notes: [] };
  const notes: string[] = [];
  const { found, truncated } = await walk(appDir);
  if (truncated)
    notes.push(`The app folder is large: only the first ${MAX_ENTRIES} entries were read.`);

  // The middleware sits beside the app folder: the project root, or src/ when the app is in src/.
  const project = dirname(appDir);
  let middleware: { file: string; matcher: MatcherRead; gate: string } | undefined;
  const beside = await readdir(project).catch(() => [] as string[]);
  for (const name of beside.filter((n) => MIDDLEWARE_FILE.test(n)).sort()) {
    const source = await read(join(project, name));
    if (source === undefined) continue;
    const file = posix(relative(root, join(project, name)));
    const gate = gateHint(source);
    const matcher = readMatcher(source);
    if (!gate) {
      notes.push(
        `${file} never touches a session or a sign-in address, so it is not read as a gate.`,
      );
      continue;
    }
    middleware = { file, matcher, gate };
    if (matcher.kind === "unreadable")
      notes.push(`${file}: ${matcher.why}, so the routes it guards were not read from it.`);
    else if (matcher.kind === "all")
      notes.push(
        `${file} has no matcher, so it decides in code which paths it guards and no route was read from it.`,
      );
    else {
      const p = matcherProblems(matcher);
      for (const s of p.broad)
        notes.push(
          `${file}: the matcher ${JSON.stringify(s)} covers the home page, so it is too broad to be read as a list of signed-in routes.`,
        );
      for (const s of p.unreadable)
        notes.push(`${file}: the matcher ${JSON.stringify(s)} could not be read.`);
    }
    break;
  }

  const cache = new Map<string, string | undefined>();
  const helperIn = async (full: string): Promise<string | undefined> => {
    if (!cache.has(full)) {
      const text = await read(full);
      cache.set(full, text === undefined ? undefined : findSessionHelper(scanSource(text).code));
    }
    return cache.get(full);
  };
  const layouts = new Map<string, string>();
  for (const f of found) if (f.kind === "layout") layouts.set(f.dirs.join("/"), f.full);

  const routes = new Map<string, RouteEntry>();
  for (const f of found) {
    if (f.kind === "layout") continue;
    const segments = f.dirs.filter((d) => !/^\(.*\)$/.test(d));
    const path = `/${segments.join("/")}`;
    if (routes.has(path)) continue;
    const file = posix(relative(root, f.full));
    const reasons: string[] = [];
    const own = await helperIn(f.full);
    if (own) reasons.push(`${f.kind === "page" ? "the page" : "the route handler"} calls ${own}()`);
    // A layout wraps pages, not route handlers. The root layout wraps the whole site, so it says nothing about one route.
    if (f.kind === "page") {
      for (let depth = f.dirs.length; depth >= 1; depth--) {
        const layout = layouts.get(f.dirs.slice(0, depth).join("/"));
        if (!layout) continue;
        const helper = await helperIn(layout);
        if (helper) {
          reasons.push(`a layout (${posix(relative(root, layout))}) calls ${helper}()`);
          break;
        }
      }
    }
    if (middleware) {
      const covers = matcherCovers(middleware.matcher, path);
      if (covers.covered)
        reasons.push(
          `${middleware.file} ${middleware.gate} and its matcher ${JSON.stringify(covers.by)} covers it`,
        );
    }
    routes.set(path, {
      path,
      file,
      dynamic: path.includes("["),
      expectsSession: reasons.length > 0,
      ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
    });
  }
  const sorted = [...routes.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.file < b.file ? -1 : 1,
  );
  const appRel = posix(relative(root, appDir));
  return { routes: sorted, appDir: appRel === "" ? "." : appRel, notes };
}

/** The routes in `dir`, sorted by path. See readRoutes for what is read. */
export async function discoverRoutes(dir: string): Promise<RouteEntry[]> {
  return (await readRoutes(dir)).routes;
}
