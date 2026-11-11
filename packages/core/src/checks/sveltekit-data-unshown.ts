import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { VISIBLE_TEXT_MAX } from "../snapshot.js";
import { isSveltekitSite, privateNames } from "../sveltekit/detect.js";
import { pageData } from "../sveltekit/read.js";
import { isHtmlPage } from "./page.js";

/** The most field names listed in one finding. */
const LISTED = 8;
/** Strings shorter than this are too common to say anything about. */
const MIN_LENGTH = 4;

export const sveltekitDataUnshown = defineCheck<PageSnapshot>({
  id: "sveltekit-data-unshown",
  size: "M",
  done: "The page's __data.json holds only fields the page shows, or the rest is deliberate.",
  estimateChanges:
    "Each unused field is dropped in its load function; fields used only by scripts or by other pages may be deliberate.",
  area: "Security & email",
  severity: "low",
  title: "The page's data has text the page does not show",
  what: "This SvelteKit page's __data.json has text fields whose text is nowhere on the page a visitor reads.",
  why: "Everything load returns is sent to every visitor. A field the page does not show is either unused (so it can go) or used by a script (so it is worth a look): either way it is public.",
  fix: "Return only what the page needs from load, or move the rest to a route that checks who is asking.",
  tech: "SvelteKit sites only. One GET of <page>/__data.json (the page's own data, fetched by the framework's client on every navigation; devalue payload walked to depth 6, capped). Text fields of 4 or more characters whose text is not in the page's visible text; names only, never values. Fields named like something private are left to sveltekit-private-fields. A payload or page text that cannot be read in full is could not check. Fields used by scripts or other pages are shown too, so read the list as a prompt (uncited)",
  async run(page, ctx) {
    if (!ctx.fetcher || !isSveltekitSite(page) || !isHtmlPage(page)) return [];
    const text = page.visibleText;
    if (text === undefined || text.length >= VISIBLE_TEXT_MAX) {
      ctx.couldNotCheck?.(page.finalUrl, "the page's visible text was not read in full");
      return [];
    }
    const data = await pageData(page, ctx);
    if ("unread" in data.read) {
      ctx.couldNotCheck?.(data.url, data.read.unread);
      return [];
    }
    const haystack = text.toLowerCase();
    const unshown = new Set<string>();
    for (const node of data.read.nodes)
      for (const f of node)
        if (
          f.kind === "string" &&
          typeof f.value === "string" &&
          f.value.trim().length >= MIN_LENGTH &&
          !haystack.includes(f.value.trim().toLowerCase().replace(/\s+/g, " "))
        )
          unshown.add(f.path === "" ? "(root)" : f.path);
    const listed = [...unshown].filter(
      (p) => privateNames([p.split(".").at(-1) ?? p]).length === 0,
    );
    if (listed.length === 0) return [];
    return [
      {
        checkId: "sveltekit-data-unshown",
        severity: "low",
        title: this.title,
        evidence: `${new URL(data.url).pathname} has ${listed.length} text field${listed.length === 1 ? "" : "s"} not on the page: ${listed.slice(0, LISTED).join(", ")}${listed.length > LISTED ? `, and ${listed.length - LISTED} more` : ""} (field names only)`,
        url: page.finalUrl,
      },
    ];
  },
});
