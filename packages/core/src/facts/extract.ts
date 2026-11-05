import { load } from "cheerio/slim";
import type { PageSnapshot } from "../snapshot.js";
import { jsonLdNodes } from "../snapshot.js";
import { businessFromJsonLd } from "./business.js";
import type { Fact, Occurrence } from "./types.js";

/** The visible text a page shows (or the selector's text), and its image descriptions, read once. */
interface PageText {
  text: string;
  alts: string;
  links: string[];
}

const cache = new WeakMap<object, Map<string, PageText>>();

function pageText(page: PageSnapshot, selector?: string): PageText {
  const key = selector ?? "";
  const perPage = cache.get(page) ?? new Map<string, PageText>();
  const hit = perPage.get(key);
  if (hit) return hit;
  const $ = load(page.hops.at(-1)?.body ?? "");
  $("script, style, noscript, template").remove();
  const scope = selector ? $(selector) : $("body");
  scope.find("*").each((_, el) => {
    $(el).append(" ");
  });
  const text = scope.text().replace(/\s+/g, " ").trim();
  const alts = scope
    .find("img[alt]")
    .map((_, el) => $(el).attr("alt") ?? "")
    .get()
    .join(" ");
  const links = scope
    .find("a[href]")
    .map((_, el) => $(el).attr("href") ?? "")
    .get();
  const result = { text, alts, links };
  perPage.set(key, result);
  cache.set(page, perPage);
  return result;
}

const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every place a fact appears on a page: visible text (by pattern, or inside the configured
 * selector), links, structured data, and image descriptions (reported, never matched as text).
 */
export function findFact(page: PageSnapshot, fact: Fact): Occurrence[] {
  const path = new URL(page.finalUrl).pathname;
  const { text, alts, links } = pageText(page, fact.selector);
  const out: Occurrence[] = [];
  const add = (source: Occurrence["source"], raw: string) =>
    out.push({ path, source, raw: raw.trim() });
  switch (fact.kind) {
    case "phone": {
      for (const m of text.matchAll(PHONE)) add("text", m[0]);
      for (const l of links) if (/^tel:/i.test(l)) add("link", decodeURIComponent(l.slice(4)));
      const ld = businessFromJsonLd(page)?.phoneText;
      if (ld) add("structured data", ld);
      for (const m of alts.matchAll(PHONE)) add("image description", m[0]);
      break;
    }
    case "hours": {
      // Hours are read where they are written as hours; the structured data block is its own source.
      const days =
        /\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b[^.;]{0,40}?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:-|–|to)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi;
      for (const m of text.matchAll(days)) add("text", m[0]);
      const ld = businessFromJsonLd(page);
      if (ld && Object.keys(ld.hours).length > 0) add("structured data", JSON.stringify(ld.hours));
      break;
    }
    case "handle": {
      if (fact.service === "venmo") {
        for (const l of links) {
          const m = /^https?:\/\/(?:www\.)?venmo\.com\/(?:u\/)?([^/?#]+)/i.exec(l);
          if (m?.[1]) add("link", `@${decodeURIComponent(m[1])}`);
        }
        for (const m of text.matchAll(/venmo\b[^@]{0,30}(@[A-Za-z0-9][A-Za-z0-9._-]{1,40})/gi))
          if (m[1]) add("text", m[1]);
      } else if (fact.service === "cashapp") {
        for (const l of links) {
          const m = /^https?:\/\/(?:www\.)?cash\.app\/(\$[^/?#]+)/i.exec(l);
          if (m?.[1]) add("link", decodeURIComponent(m[1]));
        }
        for (const m of text.matchAll(/(?<![\w$])(\$[A-Za-z][A-Za-z0-9_-]{1,20})\b/g))
          if (m[1]) add("text", m[1]);
      } else {
        for (const m of text.matchAll(
          /zelle\b[^@\d]{0,30}([\w.+-]+@[\w-]+\.[\w.]+|\+?[\d(][\d\s().-]{6,}\d)/gi,
        ))
          if (m[1]) add("text", m[1]);
      }
      break;
    }
    case "price": {
      // Longest names first, so "Tamal box" does not also read the "Tamal box (half)" price.
      const names = [fact.item, ...(fact.variants ?? []).map((v) => v.name)].sort(
        (a, b) => b.length - a.length,
      );
      const claimed: [number, number][] = [];
      for (const name of names) {
        const re = new RegExp(
          `(?<![\\w])${escape(name)}(?![\\w(])[^$\\d]{0,40}(\\$\\s?\\d+(?:[.,]\\d{2})?|\\d+(?:[.,]\\d{2})?\\s?(?:USD|dollars))`,
          "gi",
        );
        for (const m of text.matchAll(re)) {
          const at = m.index ?? 0;
          if (claimed.some(([a, b]) => at >= a && at < b)) continue;
          claimed.push([at, at + m[0].length]);
          if (name.toLowerCase() === fact.item.toLowerCase() && m[1]) add("text", m[1]);
        }
      }
      for (const n of jsonLdNodes(page)) {
        if (typeof n.name !== "string" || n.name.trim().toLowerCase() !== fact.item.toLowerCase())
          continue;
        const offers = Array.isArray(n.offers) ? n.offers : n.offers ? [n.offers] : [];
        for (const o of offers) {
          const price = (o as Record<string, unknown> | null)?.price;
          if (price !== undefined) add("structured data", String(price));
        }
      }
      break;
    }
    case "text": {
      const re = new RegExp(escape(fact.value.trim()).replace(/\s+/g, "\\s+"), "i");
      if (re.test(text)) add("text", fact.value);
      if (re.test(alts)) add("image description", fact.value);
      break;
    }
  }
  return out;
}
