/**
 * Unified-diff TEXT for the few findings whose fix is a line in a file, when the run holds what is
 * needed to write it exactly. Nothing is applied and nothing is written: this builds a string.
 *
 * Three cases, each a pure function of the finding and the page the run read:
 *   viewport         add the viewport meta tag after the opening <head> of the page as served
 *   canonical-missing add the canonical link after it
 *   sitemap-missing  (no robots.txt at all) a new robots.txt that names the sitemap
 *   perf-lcp-image   the one img tag of the first large image, on one line: loading="lazy" removed and
 *                    fetchpriority="high" added (PERF-04); the oversized width and the other speed causes
 *                    have no certain patch and are given in words
 * Any other finding, or a page whose lines cannot be quoted safely, has no patch: draft_fix then
 * says the change in words. Every string taken from the page (the context lines, the address) goes
 * through markUntrusted first, and the patch is built only if that left it unchanged, so no hidden
 * or control character, and no text longer than the cap, can reach a patch.
 */
import {
  fixImageTag,
  imageTags,
  isRefusal,
  markUntrusted,
  readLcpEvidence,
  type Finding,
} from "@gaugeline/core";
import type { StoredRun } from "./state.js";

export interface BuiltPatch {
  /** The file as a person finds it on the site: the path the page is served at. */
  file: string;
  patch: string;
  note: string;
}

/** The most leading spaces a quoted line may have, and what closes a Markdown code fence. */
const MAX_INDENT = 40;
const FENCE = /`{3,}|~{3,}/;

/** A line of page text that survives markUntrusted unchanged (leading spaces are layout, kept as they are). */
function quotable(line: string): string | undefined {
  const indent = /^ */.exec(line)?.[0] ?? "";
  // Layout, not a payload: a line indented by thousands of spaces is not quoted.
  if (indent.length > MAX_INDENT) return undefined;
  const rest = line.slice(indent.length);
  if (rest === "") return line === "" ? "" : undefined;
  const field = markUntrusted(rest, { source: "patch context", maxChars: 200 });
  // A run of three backticks or tildes would close the code fence the diff is shown in, and what
  // follows it would read as the assistant's own text.
  if (FENCE.test(rest)) return undefined;
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
  let path: string;
  try {
    path = decodeURIComponent(u.pathname).replace(/^\/+/, "");
  } catch {
    return undefined;
  }
  // After decoding, no segment may climb or stay: "/a%2F..%2F..%2Fx" would otherwise leave the site folder.
  const segments = path.split("/");
  if (
    segments.some(
      (seg, i) => seg === ".." || seg === "." || (seg === "" && i < segments.length - 1),
    )
  )
    return undefined;
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

/** The one line of the page that holds the first large image's tag, changed (PERF-04). */
function fixFirstImage(run: StoredRun, finding: Finding): BuiltPatch | undefined {
  const page = run.page;
  if (!page || finding.url !== page.url) return undefined;
  const read = readLcpEvidence(finding.evidence);
  if (!read || (!read.lazy && !read.late)) return undefined;
  const file = fileFor(page.url);
  if (!file) return undefined;
  const tags = imageTags(page.html, read.path);
  if (tags.length !== 1) return undefined;
  const tag = tags[0]?.text ?? "";
  // Only a tag that sits on one line: the diff is the one line before and after.
  if (/[\r\n]/.test(tag)) return undefined;
  const fixed = fixImageTag(tag, { lazy: read.lazy, late: read.late }, false);
  if (isRefusal(fixed) || fixed === tag) return undefined;
  const lines = page.html.split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes(tag));
  if (at < 0 || lines.filter((l) => l.includes(tag)).length !== 1) return undefined;
  const old = lines[at] ?? "";
  const changed = old.replace(tag, fixed);
  const from = Math.max(0, at - 2);
  const before = lines.slice(from, at);
  const after = lines.slice(at + 1, at + 3);
  const quotedBefore = before.map(quotable);
  const quotedAfter = after.map(quotable);
  const quotedOld = quotable(old);
  const quotedNew = quotable(changed);
  if (
    quotedBefore.some((q) => q === undefined) ||
    quotedAfter.some((q) => q === undefined) ||
    quotedOld === undefined ||
    quotedNew === undefined
  )
    return undefined;
  const context = before.length + after.length;
  const patch = [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${from + 1},${context + 1} +${from + 1},${context + 1} @@`,
    ...quotedBefore.map((l) => ` ${l}`),
    `-${quotedOld}`,
    `+${quotedNew}`,
    ...quotedAfter.map((l) => ` ${l}`),
    "",
  ].join("\n");
  return {
    file,
    patch,
    note: "Written against the page as served, so it applies where the site's source is that HTML file. A site built from templates or components has the same tag in its source instead.",
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
  "perf-lcp-image": fixFirstImage,
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
