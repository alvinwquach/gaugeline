/**
 * A small reader for .gitignore files, enough for the walk in extract.ts: comments, `!` to take a
 * path back, a trailing `/` for folders only, a leading or inner `/` to anchor a pattern, `*`, `?`,
 * `[...]` and `**`. It does not read .git/info/exclude or a global ignore file.
 */

interface Rule {
  negate: boolean;
  dirOnly: boolean;
  test: RegExp;
}

/** One .gitignore: its rules, and the folder it sits in (relative to the folder being read). */
export interface IgnoreFile {
  base: string;
  rules: Rule[];
}

/** A glob over one path (`/` separated) as a regular expression. Used on file names, never on source. */
function compile(glob: string, anchored: boolean): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*" && glob[i + 1] === "*") {
      const before = i === 0 || glob[i - 1] === "/";
      if (before && glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else if (before && i + 2 === glob.length) {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end === -1) out += "\\[";
      else {
        const body = glob.slice(i + 1, end);
        out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        i = end;
      }
    } else if (c === "\\" && i + 1 < glob.length) {
      i += 1;
      out += (glob[i] ?? "").replace(/[.+^${}()|[\]\\*?]/g, "\\$&");
    } else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(anchored ? `^${out}$` : `^(?:.*/)?${out}$`);
}

/** The rules in the text of a .gitignore that sits in `base` ("" for the folder being read). */
export function parseIgnore(text: string, base: string): IgnoreFile {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, "");
    if (line === "" || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (line === "") continue;
    // A slash at the start or in the middle ties the pattern to the folder of the .gitignore.
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    rules.push({ negate, dirOnly, test: compile(line, anchored) });
  }
  return { base, rules };
}

/**
 * Whether `path` (relative to the folder being read, `/` separated) is ignored. The last rule that
 * matches wins, and a .gitignore deeper in the tree is read after the ones above it, as git does.
 * The caller never enters an ignored folder, so a file is never rescued by a rule for its parent.
 */
export function isIgnored(files: readonly IgnoreFile[], path: string, isDir: boolean): boolean {
  let ignored = false;
  for (const file of files) {
    const inside =
      file.base === ""
        ? path
        : path.startsWith(`${file.base}/`)
          ? path.slice(file.base.length + 1)
          : null;
    if (inside === null) continue;
    for (const rule of file.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.test.test(inside)) ignored = !rule.negate;
    }
  }
  return ignored;
}
