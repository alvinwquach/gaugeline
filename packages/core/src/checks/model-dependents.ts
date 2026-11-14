import { load } from "cheerio/slim";
import { ready, safe, why } from "../content-model/shared.js";
import { defineCheck, type Finding } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import { countType } from "../sources/sanity-schema.js";
import { contentKey } from "../snapshot/page-snapshot.js";
import { pathOf, unreadable } from "../switches/shared.js";

export const modelDependents = defineCheck<PageSnapshot>({
  id: "model-dependents",
  size: "M",
  done: "The block shows entries again, or is empty on purpose and listed as such.",
  estimateChanges:
    "A renamed field in the query, a filter on a field older documents lack and a type that is now empty each fix differently.",
  area: "Visitors",
  severity: "medium",
  title: "A block that shows entries of a type is empty",
  what: 'A block on another page (an "insights" strip, a team row) is meant to show entries of a document type, shows none, and entries of that type are published.',
  why: "Pages that embed a type break when it changes: a renamed field or a stricter filter empties the block, the page still loads, and it is a page nobody opened.",
  fix: "Compare the block's query with the type as it is now (renamed fields, a filter on a field older documents lack). If the block is meant to be empty for now, take it out of gaugeline.model.json.",
  tech: "For each dependent in gaugeline.model.json: the page is read with GET and the entries are the selector's matches. With none, count(*[_type == T && (filter)]) over published documents (GET) says whether there is anything to show; a type with no published documents is not reported. With --since last and a block name, the evidence adds how many entries the saved run listed. A page that cannot be read is could not check",
  async run(page, ctx) {
    const r = ready(page, ctx, false);
    if (!r) return [];
    const dependents = r.model.config.dependents ?? [];
    if (dependents.length === 0) {
      ctx.couldNotCheck?.(
        page.finalUrl,
        'No dependent block is named in gaugeline.model.json, so nothing was looked at. Add one under "dependents" (its page, the selector of its entries and the document type). See docs/sources/sanity-schema.',
      );
      return [];
    }
    if (!ctx.statePages) return [];
    const origin = new URL(page.finalUrl).origin;
    const out: Finding[] = [];
    for (const dep of dependents) {
      const name = safe(dep.name ?? `${dep.type} on ${dep.page}`, 60);
      const got = await ctx.statePages.get(`${origin}${dep.page}`);
      if (!got.ok) {
        unreadable(ctx, page.finalUrl, got);
        continue;
      }
      const shown = load(got.page.hops.at(-1)?.body ?? "")(dep.selector).length;
      if (shown > 0) continue;
      let published: number;
      try {
        published = await countType(r.read, dep.type, dep.filter);
      } catch (err) {
        ctx.couldNotCheck?.(
          page.finalUrl,
          `The documents of "${safe(dep.type)}" could not be counted: ${why(err)}`,
        );
        break;
      }
      if (published === 0) continue;
      const before = dep.block
        ? ctx.previous?.pages?.[contentKey(got.page.finalUrl)]?.lists.find(
            (l) => l.key === dep.block,
          )?.items
        : undefined;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${name} on ${pathOf(got.page.finalUrl, origin)} shows no entries (nothing matches "${safe(dep.selector, 60)}"), and ${published} "${safe(dep.type)}" entr${published === 1 ? "y is" : "ies are"} published${before !== undefined && before > 0 ? `; the last run listed ${before}` : ""}`,
        url: got.page.finalUrl,
      });
    }
    return out;
  },
});
