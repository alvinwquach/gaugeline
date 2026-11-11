import { Parser } from "htmlparser2";
import { INVISIBLE } from "../ai-directives.js";
import { hiddenReason } from "../checks/hidden-text/styles.js";
import { matchesGlob } from "../hidden.js";
import { primaryLanguage } from "../languages.js";
import type { LanguageRules } from "../languages.js";
import { jsonLdNodes, type PageSnapshot } from "../snapshot.js";
import { HISTORIC_TYPES, STALE_LANGUAGES } from "./words.js";

/** The page text kept for dates. */
const MAX_TEXT = 200_000;

export interface PageCopy {
  /** What a visitor reads, one block per line. Never an attribute (alt, title, aria-label), script or comment. */
  text: string;
  /** The same, from inside a footer (footer element or role="contentinfo") only. */
  footer: string;
}

const SKIPPED = new Set(["script", "style", "noscript", "template", "svg", "head", "title"]);
const BLOCKS = new Set(
  "address article aside blockquote body br dd details div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table tbody td tfoot th thead tr ul".split(
    " ",
  ),
);
const PUBLISHED =
  /(?:^|[\s_-])(?:published|updated|modified|entry-date|post-date|pubdate|dt-published|dt-updated|byline)(?:$|[\s_-])/i;

interface Frame {
  name: string;
  skip: boolean;
  footer: boolean;
  article: boolean;
}

const cache = new WeakMap<object, PageCopy>();

/**
 * The visible text of the page as sent, without running JavaScript. Hidden elements, scripts, styles,
 * noscript, templates, comments and attributes are left out, and so is a <time> that is an article's
 * published or modified date (itemprop datePublished or dateModified, a published or updated class, or
 * any <time> inside an <article>). Invisible characters are removed. Linear in the body.
 */
export function pageCopy(page: Pick<PageSnapshot, "hops">): PageCopy {
  const hit = cache.get(page);
  if (hit) return hit;
  const html = page.hops.at(-1)?.body ?? "";
  const stack: Frame[] = [];
  let skip = 0;
  let footer = 0;
  let article = 0;
  let text = "";
  let foot = "";
  let line = "";
  const flush = () => {
    const clean = line.replace(/\s+/g, " ").trim();
    line = "";
    if (clean === "" || text.length >= MAX_TEXT) return;
    text += `${clean}\n`;
    if (footer > 0) foot += `${clean}\n`;
  };
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const block = BLOCKS.has(name);
        if (block) flush();
        const role = (attribs["role"] ?? "").toLowerCase();
        const published =
          name === "time" &&
          (article > 0 ||
            /^date(?:published|modified)$/i.test(attribs["itemprop"] ?? "") ||
            PUBLISHED.test(attribs["class"] ?? "") ||
            attribs["pubdate"] !== undefined);
        const f: Frame = {
          name,
          skip: SKIPPED.has(name) || hiddenReason(attribs) !== undefined || published,
          footer: name === "footer" || role === "contentinfo",
          article: name === "article",
        };
        stack.push(f);
        if (f.skip) skip++;
        if (f.footer) footer++;
        if (f.article) article++;
      },
      ontext(data) {
        if (skip === 0) line += data.replace(INVISIBLE, "");
      },
      onclosetag(name) {
        let i = stack.length - 1;
        while (i >= 0 && stack[i]?.name !== name) i--;
        if (i < 0) return;
        while (stack.length > i) {
          const f = stack.pop() as Frame;
          if (BLOCKS.has(f.name) || f.footer) flush();
          if (f.skip) skip--;
          if (f.footer) footer--;
          if (f.article) article--;
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  flush();
  const copy = { text, footer: foot };
  cache.set(page, copy);
  return copy;
}

/** Why a page is a record of the past, whose dates are meant to be old, or undefined when it is not. */
export function historicReason(
  page: PageSnapshot,
  historic: readonly string[] = [],
): string | undefined {
  let path = "/";
  try {
    path = new URL(page.finalUrl).pathname;
  } catch {
    // An address that does not parse has no path to match.
  }
  if (historic.some((g) => matchesGlob(g, path))) return "its path is listed under historic";
  const types = (t: unknown): string[] =>
    (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string");
  for (const node of jsonLdNodes(page))
    for (const t of types(node["@type"]))
      if (HISTORIC_TYPES.has(t.toLowerCase())) return `its structured data says ${t}`;
  for (const url of page.itemTypes ?? []) {
    const last = (
      url
        .split(/[/#]/)
        .filter((s) => s !== "")
        .at(-1) ?? ""
    ).toLowerCase();
    if (HISTORIC_TYPES.has(last)) return `its microdata says ${last}`;
  }
  if ((page.og["og:type"] ?? "").toLowerCase() === "article") return "its og:type is article";
  return undefined;
}

/** English, the page's own language and the languages the site's language settings name, where Gaugeline has words for them. */
export function languagesOf(page: PageSnapshot, rules?: LanguageRules): string[] {
  const names = new Set<string>(["en"]);
  if (page.htmlLang) names.add(primaryLanguage(page.htmlLang));
  for (const r of [
    rules?.default,
    ...Object.keys(rules?.prefixes ?? {}),
    ...Object.keys(rules?.subdomains ?? {}),
  ])
    if (r) names.add(primaryLanguage(r));
  return [...names].filter((n) => (STALE_LANGUAGES as readonly string[]).includes(n));
}
