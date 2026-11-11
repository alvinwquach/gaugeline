import { describePartial } from "../adapters/collect.js";
import type { JoomlaReading } from "../adapters/joomla-read.js";
import { CheckRegistry, defineCheck, type CheckContext, type Finding } from "../model.js";

/**
 * The checks that need Joomla's own answers: which published articles have no page on the live site, and whether
 * the Web Services API answers a visitor who has no token when the owner has said it is private. Pure over a
 * JoomlaReading (ids, aliases, statuses and counts, never a title or a text), so the same site gives the same
 * findings. Everything in a reading came from a platform and a site: it is printed as text and never acted on.
 */

/** What no check can say when the read itself fell short: a token Joomla refused, or a rate limit that stayed. */
function unfinished(r: JoomlaReading, ctx: CheckContext): void {
  if (r.unreadable !== undefined)
    ctx.couldNotCheck?.(r.site, `Joomla would not give its articles (${r.unreadable})`);
  for (const name of r.unknownTypes)
    ctx.couldNotCheck?.(
      r.site,
      `${JSON.stringify(name.slice(0, 40))} in gaugeline.adapters.json is not read: the Joomla adapter reads articles only.`,
    );
  if (r.partial) ctx.couldNotCheck?.(r.site, describePartial(r.partial));
}

export const joomlaArticleNoPage = defineCheck<JoomlaReading>({
  id: "joomla-article-no-page",
  size: "M",
  done: "Every published article of the Joomla site has a page that answers on the live site.",
  estimateChanges:
    "One article is usually a menu item that was unpublished or an alias that was renamed. Every article missing means the address pattern in the settings does not match the site menu, so fix the pattern first.",
  area: "Launch day",
  severity: "high",
  title: "A published Joomla article has no page on the live site",
  what: "Joomla says an article is published for every visitor, and the address its page should have answers 404 or 410 on the live site.",
  why: "Links, the sitemap and search results point at a page that is not there, and the client's announcement leads to an error page.",
  fix: "Check that a menu item or a category menu item shows the article, that the menu item is published and its access is Public, and that the article's category is published. If the article should not be public, unpublish it in the Joomla administrator. If every article fails, the address pattern in gaugeline.adapters.json (urls, articles) does not match the site's menu.",
  tech: "GET /api/index.php/v1/content/articles?filter[state]=1 (Accept: application/vnd.api+json, X-Joomla-Token) in windows of up to 100, stepped by the number that came back; the count is taken first with a window of one article (meta.total-pages is a page count) and checked with a window of two, and a list is complete only when every counted article was seen; articles at a view level other than Public (access 1), with a start time in the future, with a finish time in the past, or in one language (not All) are counted and not asked; then one GET of the live address, which is the settings' urls pattern filled with the alias or id (Joomla's API gives no address), redirects followed. A final 404 or 410 is the finding; any other answer that is not a 2xx is could-not-check for that page. With no pattern for articles nothing is asked and that is could-not-check. Ids and aliases only: a field is requested only when the settings name it in fingerprint, and none is used for this.",
  run(r, ctx) {
    unfinished(r, ctx);
    if (r.noArticles)
      ctx.couldNotCheck?.(
        r.site,
        "no published article was read, so no page was checked. The site may have no articles, or the token's user may not be able to list them.",
      );
    if (r.noPattern && r.unreadable === undefined)
      ctx.couldNotCheck?.(
        r.site,
        'no address pattern for articles in gaugeline.adapters.json (urls, for example "/blog/{slug}"), and the Joomla API gives no address for an article, so no page was asked.',
      );
    for (const u of r.unaddressed)
      ctx.couldNotCheck?.(r.site, `article ${u.id} was not checked, because ${u.reason}.`);
    if (r.skipped.otherLanguage > 0)
      ctx.couldNotCheck?.(
        r.site,
        `${r.skipped.otherLanguage} published ${r.skipped.otherLanguage === 1 ? "article is" : "articles are"} in one language, not All, so ${r.skipped.otherLanguage === 1 ? "its address carries" : "their addresses carry"} a language prefix the settings cannot say; ${r.skipped.otherLanguage === 1 ? "it was" : "they were"} not asked.`,
      );
    if (r.pagesSkipped > 0)
      ctx.couldNotCheck?.(
        r.site,
        `${r.pagesSkipped} ${r.pagesSkipped === 1 ? "page was" : "pages were"} not asked for, because a run asks for at most ${r.pageBudget}.`,
      );
    const out: Finding[] = [];
    for (const p of r.pages) {
      if (p.answer.kind === "unread") {
        ctx.couldNotCheck?.(p.url, `the page was not read (${p.answer.reason})`);
        continue;
      }
      if (p.answer.kind !== "missing") continue;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `article ${p.slug ?? p.id} is published in Joomla and ${p.path} answers ${p.answer.status}`,
        url: p.url,
      });
    }
    return out;
  },
});

const PROBING_NOTE =
  "this check asks the Web Services API's article list as a visitor with no token, so it runs only with --owner-consent (or gaugeline.consent.json), on sites you own or have permission to test";

export const joomlaApiPublic = defineCheck<JoomlaReading>({
  id: "joomla-api-public",
  size: "S",
  done: "The Joomla article list answers a visitor who sends no token with 401, and nothing else, because gaugeline.adapters.json says it is private (expectPrivate).",
  estimateChanges:
    "Usually one plugin to switch off or one route to make private, then a re-run. Allow longer if a headless front end calls the API from the browser and needs to move that call to the server.",
  area: "Security & email",
  severity: "high",
  title: "The Joomla Web Services API answers visitors with no token",
  what: "gaugeline.adapters.json says the Web Services API is meant to be private (expectPrivate: true), and a plain GET of its article list with no token is answered with a list of articles.",
  why: "Anyone who finds the route can read every article the Public view level can see as data, including articles that are not linked from the site, and can page through all of them. If the API was meant to be private, its protection is off.",
  fix: "In the Joomla administrator open System, Plugins and switch off the Web Services plugins you do not use (Web Services - Content, for articles), or find the extension that registered a public route (Joomla's own routes need a token). Send the token from the server only, never from the browser. If the API is meant to be public, remove expectPrivate from gaugeline.adapters.json: the token is not touched.",
  tech: `probing check, off without --owner-consent: ${PROBING_NOTE}; only when the settings say expectPrivate: true (a token being set says nothing); one GET of /api/index.php/v1/content/articles?page[limit]=1 with Accept: application/vnd.api+json and no X-Joomla-Token, no cookie and nothing the fetcher adds per address; a 200 with a JSON:API list (data) and a numeric meta.total-pages is the finding (the number is a count, never an article); 401 or 403 is a route that needs a token and 404 is an API that is off or not at that address, both with no finding; a 200 that is not the API's list (a page that answers every path) and any other status are could-not-check; the answer is read as a count and nothing else`,
  run(r, ctx) {
    if (!r.ownerConsent) {
      ctx.couldNotCheck?.(
        r.site,
        `not asked: ${PROBING_NOTE}. Run with --owner-consent to check whether the Joomla Web Services API answers visitors with no token.`,
      );
      return [];
    }
    unfinished(r, ctx);
    if (!r.expectedPrivate) {
      ctx.couldNotCheck?.(
        r.site,
        "not asked: no privacy expectation given. Some sites use the API in public on purpose, so Gaugeline asks only when gaugeline.adapters.json says expectPrivate: true for joomla.",
      );
      return [];
    }
    const api = r.publicApi;
    if (api === undefined) return [];
    if (api.state === "unread") {
      ctx.couldNotCheck?.(
        r.site,
        `the Web Services API was not read (${api.reason ?? "no reason given"})`,
      );
      return [];
    }
    if (api.state !== "public") return [];
    return [
      {
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `a request with no token to /api/index.php/v1/content/articles was answered with a list of ${api.total ?? 0} ${api.total === 1 ? "article" : "articles"}, and gaugeline.adapters.json says the API is private (expectPrivate)`,
        url: r.site,
      },
    ];
  },
});

export const JOOMLA_CHECKS = [joomlaArticleNoPage, joomlaApiPublic] as const;

/** The checks a Joomla read runs. They are not in the page registry: they read the CMS and the live site, not one page. */
export function createJoomlaRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of JOOMLA_CHECKS) registry.register(check);
  return registry;
}
