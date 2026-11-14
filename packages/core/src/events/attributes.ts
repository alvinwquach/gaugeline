import { load } from "cheerio/slim";
import type { PageSnapshot } from "../snapshot.js";
import { regionOf, type DomElement } from "./observe.js";
import type { EventsConfig } from "./types.js";

type El = DomElement;

/** One element that lacks attributes its rule requires. */
export interface MissingAttributes {
  text: string;
  /** Where a link goes, resolved; absent for an element that is not a link. */
  destination?: string;
  /** The required attributes it lacks, in the rule's order. */
  attributes: string[];
}

/** What one attribute rule found on the page. */
export interface AttributeGap {
  /** Index into config.attributes. */
  rule: number;
  /** "nav links" for a region, the selector as written otherwise. */
  label: string;
  /** Elements the rule selected. */
  total: number;
  /** The ones with a missing or empty attribute, in document order. */
  missing: MissingAttributes[];
}

const clean = (s: string) => s.replace(/[\s\u00A0]+/g, " ").trim();

/**
 * The elements each attribute rule selects, and which of them lack a required attribute. An
 * attribute counts only with a value: data-track="" is missing. A region rule reads every link in
 * that region (the same regions the click plan uses); a selector rule reads any element it matches,
 * and a selector the parser cannot read matches nothing. Reads the HTML already fetched.
 */
export function missingAttributes(
  page: Pick<PageSnapshot, "hops" | "finalUrl">,
  config: Pick<EventsConfig, "attributes">,
): AttributeGap[] {
  const $ = load((page.hops.at(-1)?.body ?? "").replace(/^\uFEFF/, ""));
  const gaps: AttributeGap[] = [];
  config.attributes.forEach((rule, i) => {
    let found: El[];
    try {
      found = rule.selector
        ? ($(rule.selector).toArray() as El[])
        : ($("a[href]").toArray() as El[]).filter(
            (el) =>
              regionOf($, el) === rule.region && !/^\s*javascript:/i.test($(el).attr("href") ?? ""),
          );
    } catch {
      found = [];
    }
    const missing: MissingAttributes[] = [];
    for (const el of found) {
      const lacks = rule.require.filter((name) => clean($(el).attr(name) ?? "") === "");
      if (lacks.length === 0) continue;
      const href = $(el).attr("href");
      let destination: string | undefined;
      try {
        destination = href ? new URL(href.trim(), page.finalUrl).href : undefined;
      } catch {
        destination = undefined;
      }
      const text = clean($(el).attr("aria-label") ?? $(el).text());
      missing.push({ text, ...(destination ? { destination } : {}), attributes: lacks });
    }
    if (missing.length > 0)
      gaps.push({
        rule: i,
        label: rule.selector ?? `${rule.region} links`,
        total: found.length,
        missing,
      });
  });
  return gaps;
}
