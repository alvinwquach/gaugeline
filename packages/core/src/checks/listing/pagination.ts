import { createHash } from "node:crypto";
import { load } from "cheerio/slim";
import { isSameSite } from "../../sample.js";
import type { PageSnapshot } from "../../snapshot.js";

export interface Pagination {
  /** link rel="next" or a[rel="next"], resolved. */
  next?: string;
  /** Addresses of later pages (page 2 first), resolved and deduplicated. */
  pages: string[];
  /** The page shows page numbers or a next/load-more control. */
  controls: boolean;
}

const PAGE_PARAMS = ["page", "p", "pg", "paged"];

/** origin + path without a trailing slash + the remaining query, sorted: one list, any spelling. */
function listId(u: URL): string {
  const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const q = new URLSearchParams(params).toString();
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}${q ? `?${q}` : ""}`;
}

/** The page number an address carries (?page=2, /page/2/) and the list it belongs to. */
export function pageNumber(url: string): { list: string; n: number } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  for (const name of PAGE_PARAMS) {
    const v = u.searchParams.get(name);
    if (v !== null && /^\d{1,4}$/.test(v)) {
      u.searchParams.delete(name);
      return { list: listId(u), n: Number(v) };
    }
  }
  const m = /^(.*?)\/page\/(\d{1,4})\/?$/.exec(u.pathname);
  if (m?.[2]) {
    u.pathname = `${m[1] ?? ""}/`;
    return { list: listId(u), n: Number(m[2]) };
  }
  return undefined;
}

/** The list this address shows (page 1 when it carries no number). */
function listOf(url: string): string {
  return pageNumber(url)?.list ?? listId(new URL(url));
}

const NEXT_TEXT =
  /^(?:next(?: page)?|load more|show more|more posts|older posts|›|»|→|next ›|next »)$/i;

/**
 * How the page reaches the rest of its list: rel=next, and same-site links whose address differs
 * from this one only by a page number. Controls are page numbers or a next/load-more element.
 */
export function findPagination(page: PageSnapshot): Pagination {
  const $ = load(page.hops.at(-1)?.body ?? "");
  const base = page.finalUrl;
  const resolve = (href: string | undefined) => {
    try {
      return href ? new URL(href, base).href : undefined;
    } catch {
      return undefined;
    }
  };
  const next = resolve($('link[rel~="next"]').attr("href") ?? $('a[rel~="next"]').attr("href"));
  const here = listOf(base);
  const found = new Map<string, number>();
  if (next && isSameSite(next, base)) found.set(next, pageNumber(next)?.n ?? 2);
  for (const l of page.links) {
    if (!l.sameSite) continue;
    const pn = pageNumber(l.href);
    if (pn && pn.n >= 2 && pn.list === here && !found.has(l.href)) found.set(l.href, pn.n);
  }
  const pages = [...found.entries()].sort((a, b) => a[1] - b[1]).map(([u]) => u);
  const controlText = $("button, [role=button], a:not([href])")
    .toArray()
    .some((el) => NEXT_TEXT.test($(el).text().replace(/\s+/g, " ").trim()));
  const numbered = $('[class*="pagination" i], [class*="pager" i], nav[aria-label*="pag" i]')
    .toArray()
    .some((el) => /\b2\b/.test($(el).text()));
  return {
    ...(next ? { next } : {}),
    pages,
    controls: pages.length > 0 || controlText || numbered,
  };
}

/** The visible main text without header, nav, footer and code, whitespace collapsed, as SHA-256 hex. */
export function mainTextFingerprint(html: string): string {
  const $ = load(html);
  $("header, nav, footer, script, style, noscript, template").remove();
  const text = $.root().text().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(text).digest("hex");
}

/** The control's own words, for evidence. */
export function controlLabel(page: PageSnapshot): string | undefined {
  const $ = load(page.hops.at(-1)?.body ?? "");
  const el = $("button, [role=button], a:not([href])")
    .toArray()
    .find((e) => NEXT_TEXT.test($(e).text().replace(/\s+/g, " ").trim()));
  return el ? $(el).text().replace(/\s+/g, " ").trim() : undefined;
}
