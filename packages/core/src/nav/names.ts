import { load, type CheerioAPI } from "cheerio/slim";
import type { PageSnapshot } from "../snapshot.js";
import type { NavRegion, NavRules } from "./read-regions.js";

/** One header or footer link whose accessible name is empty. */
export interface UnnamedLink {
  region: Exclude<NavRegion, "body">;
  /** Resolved address; a bare "#" is kept as written. */
  href: string;
  /** Position among the unnamed links of the page, from 1. */
  order: number;
}

type El = Parameters<CheerioAPI>[0];

/** Characters that draw nothing: whitespace, no-break space, zero-width and joiner characters. */
const BLANK = /[\s\u00A0\u200B-\u200D\u2060\uFEFF]+/g;
const blank = (s: string | undefined) => (s ?? "").replace(BLANK, "") === "";

/**
 * The name a link would be given, in the order of the accessible name computation: aria-labelledby,
 * aria-label, the content (text, an image's alt, an svg's title, a labelled descendant), then the
 * title attribute. Hidden content (hidden, aria-hidden="true") adds nothing. This is a simplified
 * form: no CSS is applied, so text hidden by a stylesheet counts as a name.
 */
function nameOf($: CheerioAPI, el: El): string {
  const labelled = ($(el).attr("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  if (labelled.length > 0) {
    const text = labelled
      .map((id) => $(`[id="${id.replace(/"/g, "")}"]`).first())
      .map((t) => (t.length > 0 ? content($, t.get(0) as El) : ""))
      .join(" ");
    if (!blank(text)) return text;
  }
  const aria = $(el).attr("aria-label");
  if (!blank(aria)) return aria ?? "";
  const inner = content($, el);
  if (!blank(inner)) return inner;
  return blank($(el).attr("title")) ? "" : ($(el).attr("title") ?? "");
}

function content($: CheerioAPI, el: El): string {
  const parts: string[] = [];
  for (const child of $(el).contents().toArray()) {
    if (child.type === "text") {
      parts.push((child as unknown as { data: string }).data);
      continue;
    }
    if (child.type !== "tag") continue;
    const node = $(child);
    const tag = (child as unknown as { name: string }).name;
    if (node.attr("hidden") !== undefined || node.attr("aria-hidden") === "true") continue;
    if (["script", "style", "template", "noscript"].includes(tag)) continue;
    const label = node.attr("aria-label");
    if (!blank(label)) parts.push(label ?? "");
    else if (tag === "img") parts.push(node.attr("alt") ?? "");
    else if (tag === "svg") {
      const title = node.children("title").first().text();
      parts.push(blank(title) ? content($, child as El) : title);
    } else parts.push(content($, child as El));
  }
  return parts.join(" ");
}

/**
 * Links in the header and footer regions (the same selectors `nav-changed` reads) whose accessible
 * name is empty: an icon with no label, an image with alt="" or none, an empty anchor. A link with no
 * href is not a link and is skipped. Reads the HTML the site sent; nothing is requested.
 */
export function linksWithoutName(
  page: Pick<PageSnapshot, "hops" | "finalUrl">,
  rules: NavRules = {},
): UnnamedLink[] {
  const $ = load(page.hops.at(-1)?.body ?? "");
  const header = rules.regions?.header ?? "header, nav, [role=banner]";
  const footer = rules.regions?.footer ?? "footer, [role=contentinfo]";
  const out: UnnamedLink[] = [];
  $("a[href]").each((_, el) => {
    const region: UnnamedLink["region"] | undefined =
      $(el).closest(footer).length > 0
        ? "footer"
        : $(el).closest(header).length > 0
          ? "header"
          : undefined;
    if (!region || !blank(nameOf($, el))) return;
    const raw = ($(el).attr("href") ?? "").trim();
    let href = raw;
    try {
      href = new URL(raw, page.finalUrl).href;
    } catch {
      // keep the text as written
    }
    out.push({ region, href, order: out.length + 1 });
  });
  return out;
}
