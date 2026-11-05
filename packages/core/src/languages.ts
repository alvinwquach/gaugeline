import { load } from "cheerio/slim";
import * as z from "zod";
import type { Fetcher, Hop } from "./fetcher.js";
import type { Budget } from "./limits.js";
import { NetworkError } from "./errors.js";
import { buildSnapshot, jsonLdNodes, type PageSnapshot } from "./snapshot.js";

/** How a site spells its language versions, until the config file (G29): gaugeline.languages.json. */
export const languageRulesSchema = z.strictObject({
  /** Path prefix per language, e.g. { "en": "/", "es": "/es/" }. */
  prefixes: z.record(z.string(), z.string()).optional(),
  /** Host prefix per language, e.g. { "es": "es." }. */
  subdomains: z.record(z.string(), z.string()).optional(),
  /** A query parameter that names the language, e.g. "lang". */
  param: z.string().min(1).optional(),
  /** The default language (no prefix, no subdomain, no parameter). */
  default: z.string().min(1).optional(),
  /** Paths that are deliberately in one language only (globs: * one segment, ** any depth). */
  exclude: z.array(z.string()).optional(),
  /** Strings in the default language that must not appear on another version (button labels, headings). */
  untranslated: z.array(z.string().min(1)).optional(),
  /** A CSS selector for the price, used when a page has no structured data offers. */
  priceSelector: z.string().min(1).optional(),
});
export type LanguageRules = z.infer<typeof languageRulesSchema>;

/** ISO 639-1 two-letter language codes. A two-letter primary subtag must be one of these. */
export const ISO_639_1: ReadonlySet<string> = new Set(
  "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu".split(
    " ",
  ),
);

const TAG =
  /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?((?:-(?:[a-z\d]{5,8}|\d[a-z\d]{3}))*)$/i;

/**
 * A BCP 47 (RFC 5646) language tag as hreflang uses it: language, optional script, optional region
 * (two letters or three digits), optional variants. "x-default" is hreflang's own value. Underscores
 * are not valid, and a two-letter language must be a real ISO 639-1 code ("sp" is not).
 */
export function isLanguageTag(tag: string): boolean {
  if (tag.toLowerCase() === "x-default") return true;
  const m = TAG.exec(tag);
  if (!m) return false;
  const lang = (m[1] ?? "").toLowerCase();
  return lang.length === 3 || ISO_639_1.has(lang);
}

/** The primary language subtag: "es-US" -> "es". */
export function primaryLanguage(tag: string): string {
  return tag.split(/[-_]/)[0]?.toLowerCase() ?? "";
}

/** A page's language and its key: the path with the language marker removed, the same for every twin. */
export function pageKey(url: string, rules: LanguageRules = {}): { lang?: string; key: string } {
  const u = new URL(url);
  let lang: string | undefined;
  let host = u.hostname.toLowerCase();
  let path = u.pathname;
  for (const [l, prefix] of Object.entries(rules.subdomains ?? {})) {
    if (host.startsWith(prefix.toLowerCase())) {
      lang = l;
      host = host.slice(prefix.length);
    }
  }
  if (rules.param && u.searchParams.has(rules.param)) {
    lang = u.searchParams.get(rules.param) ?? lang;
    u.searchParams.delete(rules.param);
  }
  const prefixes = Object.entries(rules.prefixes ?? {})
    .filter(([, p]) => p !== "/" && p !== "")
    .sort((a, b) => b[1].length - a[1].length);
  for (const [l, prefix] of prefixes) {
    const bare = prefix.replace(/\/$/, "");
    if (path === bare || path.startsWith(`${bare}/`)) {
      lang = l;
      path = path.slice(bare.length) || "/";
      break;
    }
  }
  lang ??= rules.default ?? Object.entries(rules.prefixes ?? {}).find(([, p]) => p === "/")?.[0];
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const search = u.searchParams.toString();
  return { ...(lang ? { lang } : {}), key: `${host}${trimmed}${search ? `?${search}` : ""}` };
}

/** The address of a page's twin in another language, from the configured scheme. */
export function twinUrl(url: string, lang: string, rules: LanguageRules): string | undefined {
  const { lang: from } = pageKey(url, rules);
  if (from === lang) return url;
  const u = new URL(url);
  if (rules.prefixes && rules.prefixes[lang] !== undefined) {
    const fromPrefix = (from ? rules.prefixes[from] : undefined) ?? "/";
    const rest = u.pathname.slice(fromPrefix.replace(/\/$/, "").length) || "/";
    u.pathname = `${(rules.prefixes[lang] ?? "/").replace(/\/$/, "")}${rest.startsWith("/") ? rest : `/${rest}`}`;
    return u.href;
  }
  if (rules.param) {
    if (lang === rules.default) u.searchParams.delete(rules.param);
    else u.searchParams.set(rules.param, lang);
    return u.href;
  }
  return undefined;
}

/** Group (lang, url) pairs into Map<pageKey, Map<lang, url>>: twins share a key. */
export function languageMap(
  entries: Iterable<{ lang: string; url: string }>,
  rules: LanguageRules = {},
): Map<string, Map<string, string>> {
  const map = new Map<string, Map<string, string>>();
  for (const { lang, url } of entries) {
    const key = pageKey(url, rules).key;
    const group = map.get(key) ?? new Map<string, string>();
    if (!group.has(lang.toLowerCase())) group.set(lang.toLowerCase(), url);
    map.set(key, group);
  }
  return map;
}

/** One language version of the checked page, as read. */
export interface LanguageVersion {
  lang: string;
  url: string;
  hops: Hop[];
  page?: PageSnapshot;
  /** Why it counts as missing: "returned 404", "redirects to /". */
  missing?: string;
}

/** The checked page's language group: every version it names or the scheme implies. */
export interface LanguageGroup {
  /** The checked page's own language, if known. */
  lang?: string;
  /** lang -> url, from hreflang, the sitemap's xhtml:link entries and the configured scheme. */
  urls: Map<string, string>;
  versions: LanguageVersion[];
}

function isHome(url: string, rules: LanguageRules): boolean {
  const path = new URL(url).pathname.replace(/\/+$/, "") || "/";
  return (
    path === "/" ||
    Object.values(rules.prefixes ?? {}).some((p) => (p.replace(/\/+$/, "") || "/") === path)
  );
}

export interface LanguageOptions {
  page: PageSnapshot;
  fetcher: Fetcher;
  budget: Budget;
  rules?: LanguageRules;
  /** xhtml:link alternates the sitemap gives for pages (loc -> its alternates). */
  sitemapAlternates?: () => Promise<{ loc: string; hreflang: string; href: string }[]>;
}

/** Find the checked page's twins and read each once (GET, within the run's languageVersions allowance). */
export async function readLanguageGroup({
  page,
  fetcher,
  budget,
  rules = {},
  sitemapAlternates,
}: LanguageOptions): Promise<LanguageGroup> {
  const urls = new Map<string, string>();
  const add = (lang: string, href: string) => {
    if (lang.toLowerCase() === "x-default") return;
    try {
      const u = new URL(href, page.finalUrl).href;
      if (!urls.has(lang.toLowerCase())) urls.set(lang.toLowerCase(), u);
    } catch {
      // not an address
    }
  };
  for (const a of page.hreflang ?? []) add(a.hreflang, a.href);
  const self = pageKey(page.finalUrl, rules);
  if (sitemapAlternates) {
    for (const a of await sitemapAlternates()) {
      if (pageKey(a.loc, rules).key === self.key) add(a.hreflang, a.href);
    }
  }
  for (const lang of Object.keys(rules.prefixes ?? {})) {
    const t = twinUrl(page.finalUrl, lang, rules);
    if (t) add(lang, t);
  }
  const ownLang =
    self.lang ??
    [...urls].find(
      ([, u]) =>
        pageKey(u, rules).key === self.key &&
        u.replace(/\/+$/, "") === page.finalUrl.replace(/\/+$/, ""),
    )?.[0];
  // One fetch per address: two codes naming the same page (es and es-MX) are one version.
  const seenUrls = new Set<string>([page.finalUrl.replace(/\/+$/, "")]);
  const others = [...urls].filter(([lang, u]) => {
    const key = u.replace(/\/+$/, "");
    if (lang === ownLang || seenUrls.has(key)) return false;
    seenUrls.add(key);
    return true;
  });
  const taken = budget.take("languageVersions", others);
  const versions = await Promise.all(
    taken.map(async ([lang, url]): Promise<LanguageVersion> => {
      let hops: Hop[] = [];
      try {
        hops = await fetcher.get(url);
      } catch (err) {
        if (!(err instanceof NetworkError)) throw err;
        return { lang, url, hops, missing: "did not answer" };
      }
      const last = hops.at(-1);
      if (!last || last.status >= 400)
        return { lang, url, hops, missing: `returned ${last?.status ?? "nothing"}` };
      if (hops.length > 1 && isHome(last.url, rules) && !isHome(url, rules)) {
        return { lang, url, hops, missing: `redirects to ${new URL(last.url).pathname}` };
      }
      return { lang, url, hops, page: buildSnapshot(hops) };
    }),
  );
  return { ...(ownLang ? { lang: ownLang } : {}), urls, versions };
}

export function lazyLanguageGroup(opts: LanguageOptions): () => Promise<LanguageGroup> {
  let pending: Promise<LanguageGroup> | undefined;
  return () => (pending ??= readLanguageGroup(opts));
}

/** "$12", "12 USD", "$12.00", "12,00 €" -> 12; undefined when there is no single number. */
export function parsePrice(text: string): number | undefined {
  const m = /(\d{1,3}(?:[ ,.]\d{3})*|\d+)(?:([.,])(\d{1,2}))?/.exec(text.replace(/\u00a0/g, " "));
  if (!m) return undefined;
  const whole = (m[1] ?? "").replace(/[ ,.]/g, "");
  return Number(`${whole}.${m[3] ?? "0"}`);
}

/** Priced items on a page: structured data offers first, then the configured selector; never free text. */
export function pagePrices(
  page: PageSnapshot,
  rules: LanguageRules = {},
): { key: string; price: number; currency?: string; raw: string }[] {
  const out: { key: string; price: number; currency?: string; raw: string }[] = [];
  for (const n of jsonLdNodes(page)) {
    const types = (Array.isArray(n["@type"]) ? n["@type"] : [n["@type"]]).filter(
      (t): t is string => typeof t === "string",
    );
    if (!types.some((t) => /Product|Offer|MenuItem/.test(t))) continue;
    const key =
      typeof n.sku === "string"
        ? `sku:${n.sku}`
        : typeof n.name === "string"
          ? `name:${n.name.trim().toLowerCase()}`
          : undefined;
    const offers = types.some((t) => /Offer/.test(t))
      ? [n]
      : Array.isArray(n.offers)
        ? n.offers
        : n.offers
          ? [n.offers]
          : [];
    for (const o of offers) {
      if (!o || typeof o !== "object" || !key) continue;
      const offer = o as Record<string, unknown>;
      const raw = String(
        offer.price ??
          (offer.priceSpecification as Record<string, unknown> | undefined)?.price ??
          "",
      );
      const price = parsePrice(raw);
      if (price === undefined) continue;
      const currency = typeof offer.priceCurrency === "string" ? offer.priceCurrency : undefined;
      out.push({
        key,
        price,
        raw: `${raw}${currency ? ` ${currency}` : ""}`,
        ...(currency ? { currency } : {}),
      });
    }
  }
  if (out.length === 0 && rules.priceSelector) {
    const $ = load(page.hops.at(-1)?.body ?? "");
    $(rules.priceSelector).each((i, el) => {
      const raw = $(el).text().trim();
      const price = parsePrice(raw);
      if (price !== undefined) out.push({ key: `selector:${i}`, price, raw });
    });
  }
  return out;
}
