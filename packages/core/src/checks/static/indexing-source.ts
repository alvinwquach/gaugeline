import type { SourceTree } from "../../local-source/read.js";
import { decidingRule, parseRobots, type RobotsFile } from "../../robots.js";

/**
 * What the indexing checks read from a Next.js app router folder (batch FF, FF-01, FF-02, FF-04):
 * which layouts and pages set `robots` in their metadata, and to what. Plain text rules, no compiler:
 * the same files give the same answer, and a value this cannot read with certainty is `dynamic`, which
 * every check treats as "not sure", never as a pass.
 */

/** What a `robots` metadata value says about indexing. `dynamic`: it depends on code Gaugeline does not run. */
export type RobotsValue = "noindex" | "index" | "unspecified" | "dynamic";

export interface Segment {
  /** The file, by its path under the folder. */
  file: string;
  /** The app folder it belongs to ("app", "src/app", "apps/web/app"). */
  appRoot: string;
  /** The route folder under the app folder, each segment followed by "/" ("" for the root). */
  rel: string;
  kind: "layout" | "page";
  /** Absent: the file sets no `robots`, so what a layout above it set carries through. */
  robots?: { value: RobotsValue; line: number };
}

/** The text with every comment turned into spaces, so offsets and line numbers still match the file. */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      for (; i < text.length && text[i] !== "\n"; i++) out += " ";
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) out += text[i] === "\n" ? "\n" : " ";
    } else if (c === '"' || c === "'" || c === "`") {
      // A string is copied whole, so a // inside a URL is not a comment.
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const lineOf = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;

/** The text from the opening brace at `start` to its closing one. */
function braceBody(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

/** A robots object's meaning: googleBot's own settings are a different crawler and are left out. */
function objectValue(body: string): RobotsValue {
  const own = body.replace(/\bgoogleBot\s*:\s*\{[^}]*\}/g, "");
  const index = /\bindex\s*:\s*([^,}\n]+)/.exec(own)?.[1]?.trim();
  if (index === undefined) return "unspecified";
  return index === "false" ? "noindex" : index === "true" ? "index" : "dynamic";
}

function stringValue(literal: string): RobotsValue {
  return /\bnoindex\b|\bnone\b/i.test(literal) ? "noindex" : "unspecified";
}

/** Every `robots` this file's metadata sets, as one value (two that differ are `dynamic`) and the first line. */
export function robotsOf(source: string): { value: RobotsValue; line: number } | undefined {
  const text = stripComments(source);
  if (!/\bmetadata\b|\bgenerateMetadata\b|<meta\b/.test(text)) return undefined;
  const found: { value: RobotsValue; offset: number }[] = [];
  for (const m of text.matchAll(/\brobots\s*:\s*/g)) {
    const at = m.index + m[0].length;
    const first = text[at] ?? "";
    if (first === "{") found.push({ value: objectValue(braceBody(text, at)), offset: m.index });
    else if (first === '"' || first === "'" || first === "`") {
      const end = text.indexOf(first, at + 1);
      found.push({
        value: stringValue(text.slice(at, end < 0 ? undefined : end)),
        offset: m.index,
      });
    } else found.push({ value: "dynamic", offset: m.index });
  }
  for (const m of text.matchAll(/<meta\s[^>]*name=["']robots["'][^>]*content=["']([^"']*)["']/gi))
    found.push({ value: stringValue(m[1] ?? ""), offset: m.index });
  const first = found.sort((a, b) => a.offset - b.offset)[0];
  if (first === undefined) return undefined;
  const same = found.every((f) => f.value === first.value);
  return { value: same ? first.value : "dynamic", line: lineOf(text, first.offset) };
}

const LAYOUT = /^((?:.*\/)?app)\/layout\.(?:tsx|ts|jsx|js|mjs)$/;
const SEGMENT = /^\/((?:[^/]+\/)*)(layout|page)\.(?:tsx|ts|jsx|js|mjs)$/;

/** The app router's layouts and pages in the folder, in path order, with what each sets as `robots`. */
export function appSegments(tree: SourceTree): Segment[] {
  const roots = [...tree.files.keys()]
    .map((p) => LAYOUT.exec(p)?.[1])
    .filter((r): r is string => r !== undefined)
    .sort((a, b) => a.length - b.length);
  const out: Segment[] = [];
  for (const [file, text] of tree.files) {
    const appRoot = roots.find((r) => file.startsWith(`${r}/`));
    const m = appRoot === undefined ? null : SEGMENT.exec(file.slice(appRoot.length));
    if (appRoot === undefined || m === null) continue;
    const robots = robotsOf(text);
    out.push({
      file,
      appRoot,
      rel: m[1] ?? "",
      kind: m[2] === "layout" ? "layout" : "page",
      ...(robots ? { robots } : {}),
    });
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** The layout that sets `robots` closest above `s`: the one whose setting `s`, if it sets its own, replaces. */
export function parentSetting(all: readonly Segment[], s: Segment): Segment | undefined {
  return all
    .filter(
      (p) =>
        p.kind === "layout" &&
        p.robots !== undefined &&
        p.appRoot === s.appRoot &&
        s.rel.startsWith(p.rel) &&
        (p.rel.length < s.rel.length || (p.rel === s.rel && s.kind === "page")),
    )
    .sort((a, b) => b.rel.length - a.rel.length)[0];
}

/**
 * The address a page serves, as far as the folder names it, for matching a robots.txt rule: route groups
 * "(x)" and slots "@x" are not part of it, and a dynamic segment ends it (a rule has to cover what comes
 * before it). "(shop)/menu/[slug]/" is "/menu/"; "menu/" is "/menu".
 */
export function routePath(rel: string): string {
  const parts = rel.split("/").filter((p) => p !== "" && !/^[(@]/.test(p));
  const dynamic = parts.findIndex((p) => p.startsWith("["));
  if (dynamic >= 0) return `/${parts.slice(0, dynamic).join("/")}${dynamic > 0 ? "/" : ""}`;
  return `/${parts.join("/")}`;
}

/** What a robots file the folder holds says. `dynamic`: it is code (or reads a setting) that Gaugeline does not run. */
export interface RobotsSource {
  file: string;
  /** Absent when `dynamic`. */
  robots?: RobotsFile;
  dynamic: boolean;
}

/** `public/robots.txt`, `app/robots.txt` or `app/robots.ts`, wherever the app folder is; the first found. */
export function robotsSource(tree: SourceTree): RobotsSource | undefined {
  const paths = [...tree.files.keys()];
  const txt = paths.find((p) => /(^|\/)(public|app)\/robots\.txt$/.test(p));
  if (txt !== undefined)
    return { file: txt, robots: parseRobots(tree.files.get(txt) ?? ""), dynamic: false };
  const code = paths.find((p) => /(^|\/)app\/robots\.(ts|js|mjs)$/.test(p));
  if (code === undefined) return undefined;
  const text = stripComments(tree.files.get(code) ?? "");
  // Only literal disallow paths can be read; a rule built from a setting or a function cannot.
  const rules = [...text.matchAll(/\bdisallow\s*:\s*(\[[^\]]*\]|["'][^"']*["'])/g)].flatMap((m) =>
    [...(m[1] ?? "").matchAll(/["']([^"']*)["']/g)].map((q) => q[1] ?? ""),
  );
  const dynamic = /process\.env|\bdisallow\s*:\s*(?!\[|["'])/.test(text);
  const body = ["User-agent: *", ...rules.map((r) => `Disallow: ${r}`)].join("\n");
  return { file: code, robots: parseRobots(body), dynamic };
}

/** True when `*` crawlers are told not to fetch `path`. */
export const disallowed = (r: RobotsFile, path: string): boolean =>
  decidingRule(r, "*", path)?.allow === false;

/** The line of the first `Disallow:` for `path` in a robots file's text, or 1. */
export function disallowLine(tree: SourceTree, file: string, path: string): number {
  const lines = (tree.files.get(file) ?? "").split("\n");
  const at = lines.findIndex((l) => /^\s*disallow\s*:/i.test(l) && l.includes(path));
  return at < 0 ? 1 : at + 1;
}

/** Is the site set to stay out of search? `depends`: a setting decides it, so Gaugeline cannot tell. */
export function indexingOff(
  tree: SourceTree,
  segments: readonly Segment[],
): {
  state: "off" | "on" | "depends";
  why: string;
} {
  const root = segments.find((s) => s.kind === "layout" && s.rel === "" && s.robots !== undefined);
  const src = robotsSource(tree);
  if (root?.robots?.value === "noindex") return { state: "off", why: `${root.file} says noindex` };
  if (src?.robots !== undefined && disallowed(src.robots, "/"))
    return { state: "off", why: `${src.file} disallows /` };
  if (root?.robots?.value === "dynamic")
    return { state: "depends", why: `${root.file} sets robots from a setting` };
  if (src?.dynamic === true) return { state: "depends", why: `${src.file} is built from code` };
  return { state: "on", why: "nothing in the folder keeps the whole site out of search" };
}
