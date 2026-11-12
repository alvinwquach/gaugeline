import { createHash } from "node:crypto";
import { load } from "cheerio/slim";
import { jsonLdNodes, type PageSnapshot } from "../snapshot.js";
import { LINKS_MAX, type FieldChange, type PageRecord } from "./types.js";

const CHROME = "header, footer, nav, aside, [role=banner], [role=contentinfo], [role=navigation]";
const SKIP = "script, style, noscript, template, svg";
const SHORT = 120;

const clip = (s: string): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > SHORT ? `${t.slice(0, SHORT - 1)}...` : t;
};

const sortedUnique = (list: Iterable<string>): string[] => [...new Set(list)].sort();

/** The main content's text and links: the same region page-lost-content measures, so a menu edit is not "the page". */
function readMain(html: string, base: string): { text: string; links: string[] } {
  const $ = load(html);
  $(SKIP).remove();
  const main = $("main").first();
  const root = main.length > 0 ? main : $("body").first();
  root.find(CHROME).remove();
  const links: string[] = [];
  root.find("a[href]").each((_, a) => {
    try {
      const u = new URL($(a).attr("href") ?? "", base);
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      // Where it goes, never who it names or what it carries: no userinfo, query or fragment.
      const sameSite = u.origin === new URL(base).origin;
      links.push(sameSite ? u.pathname : `${u.origin}${u.pathname}`);
    } catch {
      /* not an address: not a link */
    }
  });
  return { text: root.text().replace(/\s+/g, " ").trim(), links };
}

/** An address without userinfo, query or fragment; what it was when it cannot be read. */
function bare(href: string, base: string): string {
  try {
    const u = new URL(href, base);
    return `${u.origin}${u.pathname}`;
  } catch {
    return clip(href);
  }
}

/** The compact snapshot of one page: fields and hashes, never the HTML. */
export function buildPageRecord(page: PageSnapshot): PageRecord {
  const html = page.hops.at(-1)?.body ?? "";
  const main = readMain(html, page.finalUrl);
  const h1 = page.headings.find((h) => h.level === 1)?.text;
  const types = jsonLdNodes(page).flatMap((n) => {
    const t = n["@type"];
    return typeof t === "string"
      ? [t]
      : Array.isArray(t)
        ? t.filter((x) => typeof x === "string")
        : [];
  });
  const scripts = page.scripts.map((s) => {
    try {
      const u = new URL(s, page.finalUrl);
      return `${u.host}${u.pathname}`;
    } catch {
      return s;
    }
  });
  return {
    ...(page.title !== undefined ? { title: clip(page.title) } : {}),
    ...(page.canonical !== undefined ? { canonical: bare(page.canonical, page.finalUrl) } : {}),
    ...(h1 !== undefined ? { h1: clip(h1) } : {}),
    mainHash: createHash("sha256").update(main.text).digest("hex").slice(0, 16),
    links: sortedUnique(main.links).slice(0, LINKS_MAX),
    types: sortedUnique(types),
    scripts: sortedUnique(scripts),
  };
}

const shown = (v: string | undefined): string => (v === undefined ? "(none)" : `"${v}"`);
const list = (items: string[]): string =>
  items.length > 3
    ? `${items.slice(0, 3).join(", ")} and ${items.length - 3} more`
    : items.join(", ");

/** Which fields of one page changed between two runs. Pure; reordering is not change. */
export function diffRecords(prev: PageRecord, next: PageRecord): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of ["title", "canonical", "h1"] as const)
    if (prev[field] !== next[field])
      out.push({
        field,
        detail: `${field} changed from ${shown(prev[field])} to ${shown(next[field])}`,
      });
  if (prev.mainHash !== next.mainHash)
    out.push({ field: "content", detail: "the main content's text changed" });
  const sets = [
    ["links", "link", prev.links, next.links],
    ["structured data", "structured data type", prev.types, next.types],
    ["scripts", "script", prev.scripts, next.scripts],
  ] as const;
  for (const [field, noun, before, after] of sets) {
    const gone = before.filter((x) => !after.includes(x));
    const added = after.filter((x) => !before.includes(x));
    if (gone.length > 0)
      out.push({ field, detail: `${noun}${gone.length > 1 ? "s" : ""} removed: ${list(gone)}` });
    if (added.length > 0)
      out.push({ field, detail: `${noun}${added.length > 1 ? "s" : ""} added: ${list(added)}` });
  }
  return out;
}
