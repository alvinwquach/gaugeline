import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The route files --routes names: a glob over the site's repository, matched against file names
 * only. No file is opened. node_modules, .git and .next are never entered, and the walk stops at a
 * fixed number of files, so a glob over a whole disk cannot run away.
 */

const SKIPPED = new Set(["node_modules", ".git", ".next", ".turbo", ".vercel", "dist", "coverage"]);
const MAX_FILES = 20_000;

/** A glob as a regular expression: `**` crosses folders, `*` and `?` stay inside one. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" is any number of folders, including none; a trailing "**" is anything.
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** The folder a glob starts in: its leading segments with no `*` or `?` in them. */
function baseOf(glob: string): string {
  const segments = glob.split("/");
  const fixed: string[] = [];
  for (const s of segments.slice(0, -1)) {
    if (/[*?]/.test(s)) break;
    fixed.push(s);
  }
  return fixed.join("/");
}

/**
 * The files in `cwd` that any of the globs match, as paths with forward slashes relative to `cwd`,
 * sorted. Globs use forward slashes whatever the system.
 */
export function listRouteFiles(globs: readonly string[], cwd: string): string[] {
  const found = new Set<string>();
  let seen = 0;
  for (const raw of globs) {
    const glob = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    const re = globToRegExp(glob);
    const base = baseOf(glob);
    const walk = (rel: string): void => {
      let entries;
      try {
        entries = readdirSync(join(cwd, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (seen >= MAX_FILES) return;
        const path = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (!SKIPPED.has(e.name)) walk(path);
        } else {
          seen += 1;
          if (re.test(path)) found.add(path);
        }
      }
    };
    walk(base);
  }
  return [...found].sort();
}
