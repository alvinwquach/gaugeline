import type { CheckContext } from "../../model.js";
import { flattenSchema, type FlatSchema } from "../../schema-rules.js";
import type { PageSnapshot } from "../../snapshot.js";

export interface SchemaPage {
  page: PageSnapshot;
  path: string;
  flat: FlatSchema;
}

const cache = new WeakMap<PageSnapshot, FlatSchema>();

/** The pages the schema checks read, each flattened once. JSON-LD that failed to parse is skipped, and said so. */
export async function schemaPages(page: PageSnapshot, ctx: CheckContext): Promise<SchemaPage[]> {
  // Other pages are fetched only when there is something to compare: a schema guide, or JSON-LD on
  // the checked page. A page with neither costs no extra requests.
  const compare =
    ctx.schemaRules !== undefined || page.jsonLd.length > 0 || page.jsonLdErrors.length > 0;
  const pages = compare ? ((await ctx.pages?.()) ?? [page]) : [page];
  return pages.map((p) => {
    let flat = cache.get(p);
    if (!flat) {
      flat = flattenSchema(p.jsonLd, p.finalUrl);
      cache.set(p, flat);
    }
    return { page: p, path: new URL(p.finalUrl).pathname, flat };
  });
}

/** Warn once per check about blocks that did not parse (jsonld-invalid reports them). */
export function warnSkipped(pages: readonly SchemaPage[], ctx: CheckContext, check: string): void {
  for (const p of pages) {
    const n = p.page.jsonLdErrors.length;
    if (n > 0)
      ctx.warn(
        `${check}: ${n} JSON-LD ${n === 1 ? "block" : "blocks"} on ${p.path} did not parse and ${n === 1 ? "was" : "were"} skipped (see jsonld-invalid).`,
      );
  }
}

/** Nodes of an exact type (Organization, WebSite), with or without an @id. */
export function nodesOfType(flat: FlatSchema, type: string) {
  return [...flat.byId.values(), ...flat.unnamed].filter((n) => n.types.includes(type));
}

/** True when no page has any JSON-LD at all. */
export function noStructuredData(pages: readonly SchemaPage[]): boolean {
  return pages.every((p) => p.page.jsonLd.length === 0 && p.page.jsonLdErrors.length === 0);
}

/** An @id or URL on the site as a path with its #fragment ("/#organization"); other sites in full. */
export function idPath(raw: string, base: string): string {
  try {
    const u = new URL(raw, base);
    return u.origin === new URL(base).origin ? `${u.pathname}${u.search}${u.hash}` : u.href;
  } catch {
    return raw;
  }
}
