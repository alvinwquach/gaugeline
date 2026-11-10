import { load, type CheerioAPI } from "cheerio/slim";
import { escapeInvisible } from "../checks/hidden-text/escape.js";
import { jsonLdNodes, type PageSnapshot } from "../snapshot.js";
import type { ForecastRule, FreshnessRule, SpotCheck } from "./config.js";

/**
 * Reading a page for the things a freshness rule asks about: when it says it was updated, a figure
 * on it, and the dates of the predictions it lists. Everything is read from the page as sent, with
 * no JavaScript; what comes out is text from the page, which is data, and the caller escapes it.
 */

const cache = new WeakMap<object, CheerioAPI>();

function dom(page: PageSnapshot): CheerioAPI {
  let $ = cache.get(page);
  if (!$) {
    $ = load(page.hops.at(-1)?.body ?? "");
    cache.set(page, $);
  }
  return $;
}

type El = ReturnType<CheerioAPI>;

/** Elements in these are not shown: a selector that lands in one found nothing. */
const NOT_SHOWN = "template, script, style, noscript";

/** The elements a selector matches that the page shows. */
function shown($: CheerioAPI, selector: string, within?: El): El {
  const found = within ? within.find(selector) : $(selector);
  return found.filter((_, node) => $(node).closest(NOT_SHOWN).length === 0);
}

/** The attributes a selector names: "[data-updated]" and "time[datetime]" give data-updated and datetime. */
function namedAttributes(selector: string): string[] {
  return [...selector.matchAll(/\[\s*([A-Za-z][\w:-]*)\s*(?:[~|^$*]?=[^\]]*)?\]/g)].map(
    (m) => m[1] ?? "",
  );
}

function squash(text: string): string {
  return text.replace(/[\s\u00A0]+/g, " ").trim();
}

/**
 * What an element says: the attribute asked for, else datetime, content, the attributes its selector
 * names, value, and last its own text. The first one that is not empty wins.
 */
function valueOf(
  el: El,
  selector: string,
  attr: string | undefined,
): { raw: string; via: string } | undefined {
  const tries = attr ? [attr] : ["datetime", "content", ...namedAttributes(selector), "value"];
  for (const name of tries) {
    const raw = squash(el.attr(name) ?? "");
    if (raw !== "") return { raw, via: name };
  }
  if (attr) return undefined;
  const text = squash(el.text());
  return text === "" ? undefined : { raw: text, via: "text" };
}

export type StampRead = { found: false } | { found: true; raw: string; from: string };

/** The first value of a property anywhere in the page's structured data. */
function jsonldValue(page: PageSnapshot, property: string): string | undefined {
  const visit = (value: unknown, depth: number): string | undefined => {
    if (depth > 8 || value === null || typeof value !== "object") return undefined;
    if (Array.isArray(value)) {
      for (const v of value) {
        const got = visit(v, depth + 1);
        if (got !== undefined) return got;
      }
      return undefined;
    }
    const obj = value as Record<string, unknown>;
    const own = obj[property];
    if (typeof own === "string" && own.trim() !== "") return own.trim();
    if (typeof own === "number" && Number.isFinite(own)) return String(own);
    for (const v of Object.values(obj)) {
      const got = visit(v, depth + 1);
      if (got !== undefined) return got;
    }
    return undefined;
  };
  return visit(page.jsonLd, 0);
}

/** When the page says its data was updated: the configured element, else its structured data. */
export function readStamp(
  page: PageSnapshot,
  stamp: NonNullable<FreshnessRule["stamp"]>,
): StampRead {
  if (stamp.selector !== undefined) {
    const $ = dom(page);
    const el = shown($, stamp.selector).first();
    if (el.length > 0) {
      const got = valueOf(el, stamp.selector, stamp.attr);
      if (got) return { found: true, raw: got.raw, from: `${stamp.selector} (${got.via})` };
    }
  }
  if (stamp.jsonld !== undefined) {
    const raw = jsonldValue(page, stamp.jsonld);
    if (raw !== undefined) return { found: true, raw, from: `structured data ${stamp.jsonld}` };
  }
  return { found: false };
}

export type FigureRead = { found: false } | { found: true; raw: string };

/** The text of a figure on the page: the first element the selector matches. */
export function readFigure(
  page: PageSnapshot,
  spot: Pick<SpotCheck, "selector" | "attr">,
): FigureRead {
  const $ = dom(page);
  const el = shown($, spot.selector).first();
  if (el.length === 0) return { found: false };
  const got = valueOf(el, spot.selector, spot.attr);
  return got ? { found: true, raw: got.raw } : { found: false };
}

/** One prediction on a page. */
export interface ForecastItem {
  /** What to call it in a finding: its text (escaped, short), or the Event's name. */
  label: string;
  /** The date as the page writes it; undefined when the item has none. */
  raw: string | undefined;
  /** The item already shows its result. */
  settled: boolean;
}

/** The most predictions read from one page. */
export const MAX_FORECAST_ITEMS = 200;
const LABEL = 50;

const EVENT_TYPE = /(?:^|[/:])\w*Event$/;

/** The predictions on a page and when each one's event is. */
export function readForecasts(page: PageSnapshot, forecast: ForecastRule): ForecastItem[] {
  if (forecast.item === undefined) {
    const property = forecast.jsonld ?? "startDate";
    return jsonLdNodes(page)
      .filter((n) => {
        const type = n["@type"];
        return (Array.isArray(type) ? type : [type]).some(
          (t) => typeof t === "string" && EVENT_TYPE.test(t.trim()),
        );
      })
      .slice(0, MAX_FORECAST_ITEMS)
      .map((n) => {
        const raw = n[property];
        const name = typeof n.name === "string" ? n.name : "an event";
        return {
          label: escapeInvisible(squash(name), LABEL),
          raw: typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined,
          settled: false,
        };
      });
  }
  const $ = dom(page);
  const item = forecast.item;
  const out: ForecastItem[] = [];
  shown($, item).each((_, node) => {
    if (out.length >= MAX_FORECAST_ITEMS) return false;
    const el = $(node);
    let date: string | undefined;
    if (forecast.date !== undefined) {
      const inner = shown($, forecast.date, el).first();
      date = inner.length > 0 ? valueOf(inner, forecast.date, undefined)?.raw : undefined;
    } else {
      date =
        valueOf(el, item, undefined)?.via === "text"
          ? undefined
          : valueOf(el, item, undefined)?.raw;
      if (date === undefined) {
        const t = el.find("time[datetime]").first();
        if (t.length > 0) date = valueOf(t, "time[datetime]", undefined)?.raw;
      }
    }
    const settled =
      forecast.settled !== undefined &&
      (el.is(forecast.settled) || el.find(forecast.settled).length > 0);
    out.push({
      label: escapeInvisible(squash(el.text()), LABEL),
      raw: date,
      settled,
    });
    return undefined;
  });
  return out;
}
