/**
 * Unified-diff TEXT for the few findings whose fix is a line in a file, when the run holds what is
 * needed to write it exactly. Nothing is applied and nothing is written: this builds a string.
 *
 * Three cases, each a pure function of the finding and the page the run read:
 *   viewport         add the viewport meta tag after the opening <head> of the page as served
 *   canonical-missing add the canonical link after it
 *   sitemap-missing  (no robots.txt at all) a new robots.txt that names the sitemap
 * Any other finding, or a page whose lines cannot be quoted safely, has no patch: draft_fix then
 * says the change in words. Every string taken from the page (the context lines, the address) goes
 * through markUntrusted first, and the patch is built only if that left it unchanged, so no hidden
 * or control character, and no text longer than the cap, can reach a patch.
 */
import { markUntrusted, type Finding } from "@gaugeline/core";
import type { StoredRun } from "./state.js";

export interface BuiltPatch {
  /** The file as a person finds it on the site: the path the page is served at. */
  file: string;
  patch: string;
  note: string;
}

/** A line of page text that survives markUntrusted unchanged (leading spaces are layout, kept as they are). */
function quotable(line: string): string | undefined {
  const indent = /^ */.exec(line)?.[0] ?? "";
  const rest = line.slice(indent.length);
  if (rest === "") return line === "" ? "" : undefined;
  const field = markUntrusted(rest, { source: "patch context", maxChars: 200 });
  return field.text === rest && !field.truncated ? line : undefined;
}

/** The path a page is served at, as a file name: / is index.html, /menu is menu.html. */
function fileFor(pageUrl: string): string | undefined {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return undefined;
  }
  const path = decodeURIComponent(u.pathname).replace(/^\/+/, "");
  if (/[^A-Za-z0-9._\-/]/.test(path)) return undefined;
  if (path === "" || path.endsWith("/")) return `${path}index.html`;
  return /\.[A-Za-z0-9]+$/.test(path) ? path : `${path}.html`;
}

function insertAfterHead(run: StoredRun, finding: Finding, line: string): BuiltPatch | undefined {
  const page = run.page;
  if (!page || finding.url !== page.url) return undefined;
  const file = fileFor(page.url);
  if (!file) return undefined;
  const lines = page.html.split(/\r?\n/);
  // The first line that holds a whole opening <head> tag and nothing after it.
  const at = lines.findIndex((l) =>
    /^\s*(?:<!doctype[^>]*>\s*)?(?:<html[^>]*>\s*)?<head(?:\s[^>]*)?>\s*$/i.test(l),
  );
  if (at < 0) return undefined;
  const from = Math.max(0, at - 2);
  const before = lines.slice(from, at + 1);
  const after = lines.slice(at + 1, at + 4);
  const quoted = [...before, ...after].map(quotable);
  if (quoted.some((q) => q === undefined)) return undefined;
  const indent = /^ */.exec(lines[at + 1] ?? "")?.[0] || "  ";
  const body = [
    ...quoted.slice(0, before.length).map((l) => ` ${l}`),
    `+${indent}${line}`,
    ...quoted.slice(before.length).map((l) => ` ${l}`),
  ];
  const old = before.length + after.length;
  const patch = [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${from + 1},${old} +${from + 1},${old + 1} @@`,
    ...body,
    "",
  ].join("\n");
  return {
    file,
    patch,
    note: "Written against the page as served, so it applies where the site's source is that HTML file. A site built from templates has the same line in its layout instead.",
  };
}

const BUILDERS: Record<string, (run: StoredRun, finding: Finding) => BuiltPatch | undefined> = {
  viewport: (run, f) =>
    insertAfterHead(run, f, '<meta name="viewport" content="width=device-width, initial-scale=1">'),
  "canonical-missing": (run, f) => {
    let u: URL;
    try {
      u = new URL(f.url);
    } catch {
      return undefined;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    u.hash = "";
    u.search = "";
    const href = markUntrusted(u.href, { source: "patch address", maxChars: 300 });
    if (href.text !== u.href || /["<>\s]/.test(u.href)) return undefined;
    return insertAfterHead(run, f, `<link rel="canonical" href="${u.href}">`);
  },
  "sitemap-missing": (_run, f) => {
    // Only when there is no robots.txt at all: a new file is exact; an edit to an unseen file is not.
    if (!f.evidence.includes("there is no robots.txt")) return undefined;
    let origin: string;
    try {
      origin = new URL(f.url).origin;
    } catch {
      return undefined;
    }
    if (!/^https?:\/\/[A-Za-z0-9.\-:[\]]+$/.test(origin)) return undefined;
    return {
      file: "robots.txt",
      patch: [
        "--- /dev/null",
        "+++ b/robots.txt",
        "@@ -0,0 +1,3 @@",
        "+User-agent: *",
        "+Allow: /",
        `+Sitemap: ${origin}/sitemap.xml`,
        "",
      ].join("\n"),
      note: "A new file served at /robots.txt (often public/robots.txt or static/robots.txt in the repository). It assumes the sitemap is at /sitemap.xml: change the address if it is elsewhere.",
    };
  },
};

/** The patch for this finding, or undefined when it has none (the caller then writes the change in words). */
export function buildPatch(run: StoredRun, finding: Finding): BuiltPatch | undefined {
  return BUILDERS[finding.checkId]?.(run, finding);
}
