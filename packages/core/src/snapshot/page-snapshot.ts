import { jsonLdNodes, type PageSnapshot } from "../snapshot.js";
import { mainContent } from "./main-content.js";

/**
 * What a page holds, saved with a run (--since last) so the next run can say what it lost or gained:
 * main-content words, headings in order, link and image counts, repeated lists, structured-data
 * types, title and canonical. Counts and names only: no body text is kept.
 */
export interface ContentSnapshot {
  url: string;
  words: number;
  headings: string[];
  sections: { heading: string; words: number }[];
  links: number;
  images: number;
  lists: { key: string; items: number; links: string[]; paginated: boolean }[];
  types: string[];
  title?: string;
  canonical?: string;
}

export function buildContentSnapshot(page: PageSnapshot): ContentSnapshot {
  const main = mainContent(page.hops.at(-1)?.body ?? "", page.finalUrl);
  const types = new Set<string>();
  for (const n of jsonLdNodes(page)) {
    const t = n["@type"];
    for (const x of Array.isArray(t) ? t : [t]) if (typeof x === "string") types.add(x);
  }
  for (const t of page.itemTypes ?? []) types.add(t.replace(/^https?:\/\/schema\.org\//, ""));
  return {
    url: page.finalUrl,
    words: main.words,
    headings: page.headings.map((h) => h.text),
    sections: main.sections,
    links: page.links.length,
    images: page.images.length,
    lists: main.lists,
    types: [...types].sort(),
    ...(page.title ? { title: page.title } : {}),
    ...(page.canonical ? { canonical: page.canonical } : {}),
  };
}

/** The key a page is saved under: its path, lower case, no trailing slash. */
export function contentKey(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase().replace(/\/+$/, "");
    return p === "" ? "/" : p;
  } catch {
    return url;
  }
}
