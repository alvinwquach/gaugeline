import { load, type CheerioAPI } from "cheerio/slim";

/**
 * A page's main content, measured: the header, the footer, the navigation and asides are left out,
 * so a menu or footer change doesn't register as every page changing. Read from the HTML sent.
 */
export interface MainContent {
  words: number;
  /** Each h2 or h3 in the main content, with the words under it up to the next heading. */
  sections: { heading: string; words: number }[];
  /** Repeated lists (ul or ol with 3 or more items, or [data-list]): their items and item links. */
  lists: { key: string; items: number; links: string[]; paginated: boolean }[];
}

const CHROME = "header, footer, nav, aside, [role=banner], [role=contentinfo], [role=navigation]";
const SKIP = "script, style, noscript, template, svg";

const count = (text: string) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export function mainContent(html: string, base: string): MainContent {
  const $: CheerioAPI = load(html);
  $(SKIP).remove();
  const main = $("main").first();
  const root = main.length > 0 ? main : $("body").first();
  root.find(CHROME).remove();
  // Text nodes in document order, each attributed to the heading above it.
  const sections: MainContent["sections"] = [];
  let current: MainContent["sections"][number] | undefined;
  let words = 0;
  const walk = (node: Parameters<CheerioAPI>[0]) => {
    $(node)
      .contents()
      .each((_, child) => {
        if (child.type === "text") {
          const n = count((child as { data?: string }).data ?? "");
          words += n;
          if (current) current.words += n;
          return;
        }
        if (child.type !== "tag") return;
        const tag = (child as { name?: string }).name ?? "";
        if (tag === "h2" || tag === "h3") {
          const heading = clean($(child).text());
          words += count(heading);
          current = { heading, words: 0 };
          sections.push(current);
          return;
        }
        walk(child as Parameters<CheerioAPI>[0]);
      });
  };
  const el = root.get(0);
  if (el) walk(el as Parameters<CheerioAPI>[0]);

  const resolve = (href: string | undefined) => {
    if (!href) return undefined;
    try {
      const u = new URL(href, base);
      u.hash = "";
      return u.href;
    } catch {
      return undefined;
    }
  };
  const lists: MainContent["lists"] = [];
  const seen = new Map<string, number>();
  root.find("ul, ol, [data-list]").each((_, list) => {
    const isData = $(list).is("[data-list]");
    const items = isData ? $(list).children() : $(list).children("li");
    if (!isData && items.length < 3) return;
    if (!isData && $(list).parents("ul, ol, [data-list]").length > 0) return;
    // The list's name: its data-list value, else the nearest heading before it.
    const named = $(list).attr("data-list")?.trim();
    const heading =
      clean($(list).prevAll("h1, h2, h3, h4").first().text()) ||
      clean($(list).parent().prevAll("h1, h2, h3, h4").first().text());
    const base0 = named || heading || "a list";
    const n = (seen.get(base0) ?? 0) + 1;
    seen.set(base0, n);
    const key = n === 1 ? base0 : `${base0} (${n})`;
    const links = items
      .map((_, item) => resolve($(item).find("a[href]").first().attr("href")))
      .get()
      .filter((h: string | undefined): h is string => h !== undefined);
    const paginated =
      $("link[rel=next], a[rel=next], [aria-label*='pagination' i], .pagination").length > 0;
    lists.push({ key, items: items.length, links, paginated });
  });
  return { words, sections, lists };
}
