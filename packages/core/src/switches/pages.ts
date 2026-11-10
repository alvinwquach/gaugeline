import { NetworkError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import { pageKey, primaryLanguage, twinUrl, type LanguageRules } from "../languages.js";
import type { Budget } from "../limits.js";
import { classifyHop, describeRefusal } from "../refusal.js";
import { inKind } from "../request-log.js";
import { buildSnapshot, type PageSnapshot } from "../snapshot.js";
import type { Phrase } from "./config.js";

export type StatePage =
  | { ok: true; url: string; page: PageSnapshot }
  | {
      ok: false;
      url: string;
      /**
       * gone: the site answered 404 or 410. refused: a firewall or challenge. unreachable: no answer
       * or a server error. not-html: not a page. over-limit: the run's allowance for these pages was spent.
       */
      kind: "gone" | "refused" | "unreachable" | "not-html" | "over-limit";
      message: string;
    };

/** The pages gaugeline.switches.json is about, each read once with a GET. */
export interface StatePages {
  get(url: string): Promise<StatePage>;
}

function key(url: string): string {
  const u = new URL(url);
  u.hash = "";
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.href;
}

function shorten(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

export interface StatePagesOptions {
  fetcher: Fetcher;
  budget: Budget;
  /** Pages the run already has (the page checked): used as they are, not asked for again. */
  known?: readonly PageSnapshot[];
}

/**
 * Pages are read with GET through the run's fetcher (so private addresses stay refused), at most
 * the run's allowance of distinct pages, each once however many rules name it. A page that cannot be
 * read says why; it is never an exception.
 */
export function createStatePages(opts: StatePagesOptions): StatePages {
  const done = new Map<string, Promise<StatePage>>();
  for (const page of opts.known ?? [])
    for (const url of new Set([page.finalUrl, page.requestedUrl]))
      done.set(key(url), Promise.resolve({ ok: true, url: page.finalUrl, page }));

  async function fetchOne(url: string): Promise<StatePage> {
    const where = shorten(url);
    if (opts.budget.take("statePages", [url]).length === 0)
      return {
        ok: false,
        url,
        kind: "over-limit",
        message: `${where} was not read: a run reads at most ${opts.budget.summary().statePages.limit} pages named in gaugeline.switches.json`,
      };
    let hops;
    try {
      hops = await inKind("extra-page", () => opts.fetcher.get(url));
    } catch (err) {
      if (err instanceof NetworkError)
        return { ok: false, url, kind: "unreachable", message: `${where} could not be reached` };
      throw err;
    }
    const last = hops.at(-1);
    if (!last)
      return { ok: false, url, kind: "unreachable", message: `${where} could not be reached` };
    const outcome = classifyHop(last);
    if (outcome.kind === "refused")
      return {
        ok: false,
        url,
        kind: "refused",
        message: `${where} ${describeRefusal(outcome)}, so it was not read`,
      };
    if (last.status === 404 || last.status === 410)
      return { ok: false, url, kind: "gone", message: `${where} answers ${last.status}` };
    if (last.status < 200 || last.status >= 300)
      return {
        ok: false,
        url,
        kind: "unreachable",
        message: `${where} answers ${last.status}`,
      };
    if (!/html/i.test(last.headers["content-type"] ?? "text/html"))
      return { ok: false, url, kind: "not-html", message: `${where} is not a web page` };
    return { ok: true, url: last.url, page: buildSnapshot(hops) };
  }

  return {
    get(url) {
      const k = key(url);
      let pending = done.get(k);
      if (!pending) {
        pending = fetchOne(url);
        done.set(k, pending);
      }
      return pending;
    },
  };
}

/** One page a phrase has to be found on. */
export interface Target {
  /** The path as the config wrote it, for the finding. */
  path: string;
  url: string;
  phrase: Phrase;
  /** The language this version of the page is in, when the site's language scheme gave its address. */
  lang?: string;
}

/**
 * The pages a `pageSays` entry is about. One page, or, for a phrase written in several languages on
 * a site whose language scheme is known (gaugeline.languages.json), each language's version of it.
 */
export function targetsFor(
  path: string,
  phrase: Phrase,
  origin: string,
  rules: LanguageRules | undefined,
): Target[] {
  const base = `${origin}${path}`;
  if (typeof phrase === "string" || !rules || Object.keys(phrase).length < 2)
    return [{ path, url: base, phrase }];
  const langs = Object.keys(phrase).map((l) => primaryLanguage(l));
  const urls = langs.map((l) => twinUrl(base, l, rules));
  if (urls.some((u) => u === undefined)) return [{ path, url: base, phrase }];
  return langs.map((lang, i) => ({ path, url: urls[i] as string, phrase, lang }));
}

/** The language a page is in: its html lang, else the one its address gives under the site's scheme. */
export function pageLanguage(
  page: PageSnapshot,
  rules: LanguageRules | undefined,
): string | undefined {
  if (page.htmlLang) return primaryLanguage(page.htmlLang);
  return rules ? pageKey(page.finalUrl, rules).lang : undefined;
}

/**
 * The phrases a page may say to be right: the phrase, or for several languages the one for this
 * page's language. When the page's language is not among them, any of them will do.
 */
export function phrasesFor(
  target: Target,
  page: PageSnapshot,
  rules: LanguageRules | undefined,
): string[] {
  const { phrase } = target;
  if (typeof phrase === "string") return [phrase];
  const byLang = new Map(Object.entries(phrase).map(([l, p]) => [primaryLanguage(l), p]));
  const lang = target.lang ?? pageLanguage(page, rules);
  const chosen = lang === undefined ? undefined : byLang.get(lang);
  return chosen === undefined ? [...byLang.values()] : [chosen];
}
