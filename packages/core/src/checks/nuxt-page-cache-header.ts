import { defineCheck } from "../model.js";
import { isNuxtSite } from "../nuxt/detect.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

const YEAR = 31_536_000;
/** More directives than this in one header are not read. */
const MAX_DIRECTIVES = 40;

/** Cache-Control as a Map from lower-case directive to its number (or true when it has none). */
export function parseCacheControl(value: string): Map<string, number | true> {
  const out = new Map<string, number | true>();
  for (const part of value.split(",").slice(0, MAX_DIRECTIVES)) {
    const [name, arg] = part.trim().toLowerCase().split("=", 2);
    if (!name) continue;
    const n = arg === undefined ? NaN : Number(arg.replace(/^"|"$/g, ""));
    out.set(name, Number.isFinite(n) ? n : true);
  }
  return out;
}

export const nuxtPageCacheHeader = defineCheck<PageSnapshot>({
  id: "nuxt-page-cache-header",
  size: "S",
  done: "A page's cache header says it may be kept briefly (or revalidated), and a page that sets a cookie is not kept by shared caches.",
  estimateChanges:
    "A routeRules entry that applies to every route ('/**') is one change, but each route that needs a longer time then needs its own rule.",
  area: "Launch day",
  severity: "medium",
  title: "A Nuxt page is cached in a way that will show old or other people's content",
  what: "The HTML of this Nuxt page is told to be cached for a year or as immutable, or it sets a cookie while shared caches (a CDN) are allowed to keep it.",
  why: "Edits to a page that caches for a year never reach visitors who already have it, and a CDN that keeps a response with a Set-Cookie hands one visitor's cookie to the next.",
  fix: "In nuxt.config routeRules, give page routes a short time or swr/isr (for example '/**': { swr: 600 }) and keep long, immutable headers for /_nuxt/** files only. Do not set cookies on routes that are cached.",
  tech: "Nuxt sites only, from the page's own response headers (nothing extra is requested): Cache-Control with immutable or a max-age or s-maxage of a year or more on an HTML page; or a Set-Cookie header together with public or s-maxage above 0 in Cache-Control and no Vary: Cookie, private or no-store. routeRules headers, swr and isr add these headers in Nuxt. Directives are held in a Map from name to number",
  run(page) {
    if (!isNuxtSite(page) || !isHtmlPage(page)) return [];
    const headers = page.hops.at(-1)?.headers ?? {};
    const cc = parseCacheControl(headers["cache-control"] ?? "");
    const parts: string[] = [];
    const age = Math.max(
      typeof cc.get("max-age") === "number" ? (cc.get("max-age") as number) : 0,
      typeof cc.get("s-maxage") === "number" ? (cc.get("s-maxage") as number) : 0,
    );
    if (cc.has("immutable") || age >= YEAR)
      parts.push(
        cc.has("immutable")
          ? "its Cache-Control says immutable"
          : `its Cache-Control keeps it for ${Math.round(age / 86400)} days`,
      );
    const sMax = cc.get("s-maxage");
    const shared = cc.has("public") || (typeof sMax === "number" && sMax > 0);
    const guarded =
      cc.has("private") || cc.has("no-store") || /\bcookie\b/i.test(headers.vary ?? "");
    if (headers["set-cookie"] !== undefined && shared && !guarded)
      parts.push("it sets a cookie and shared caches may keep it");
    if (parts.length === 0) return [];
    return [
      {
        checkId: "nuxt-page-cache-header",
        severity: "medium",
        title: this.title,
        evidence: parts.join("; "),
        url: page.finalUrl,
      },
    ];
  },
});
