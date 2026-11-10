import { load } from "cheerio/slim";
import * as z from "zod";

/** Listing pages and dependent blocks one gaugeline.model.json may name. */
export const MAX_MODEL_RULES = 10;
/** Pages of results one listing may span before Gaugeline stops following "next" and says so. */
export const MAX_LISTING_PAGES = 10;

const path = z
  .string()
  .regex(
    /^\/[^\s?#*]{0,200}$/,
    'must be one path on the site like "/news" (no address, query, fragment or *)',
  );

const pathPattern = z
  .string()
  .regex(/^\/[^\s?#]{0,200}$/, 'must be a path on the site like "/dev/*" (no address or query)');

/** A document type name as Sanity writes it: a letter, then letters, digits, underscores and hyphens. */
const typeName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, 'must be a document type name like "article"');

const fieldName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'must be a plain field name like "subtitle"');

const fieldPath = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/,
    'must be a field path like "slug.current"',
  );

const selector = z
  .string()
  .min(1)
  .max(200)
  .refine((text) => {
    try {
      load("<p></p>")(text);
      return true;
    } catch {
      return false;
    }
  }, 'must be a CSS selector like "article.card"');

/**
 * A GROQ filter that narrows which published documents a rule is about (an archived entry the
 * listing leaves out on purpose). It is put inside `*[_type == "x" && (<filter>)]`, so it may not
 * close that bracket, open a projection or hold two statements.
 */
export function filterProblem(filter: string): string | undefined {
  if (/[{};]/.test(filter)) return "may not contain { } or ;";
  let round = 0;
  let square = 0;
  let quote = "";
  for (const c of filter) {
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") round += 1;
    else if (c === ")") round -= 1;
    else if (c === "[") square += 1;
    else if (c === "]") square -= 1;
    if (round < 0 || square < 0) return "has a closing bracket with no opening one";
  }
  if (quote) return "has a quote that is never closed";
  if (round !== 0 || square !== 0) return "has a bracket that is never closed";
  return undefined;
}

const filter = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .superRefine((text, ctx) => {
    const problem = filterProblem(text);
    if (problem)
      ctx.addIssue({
        code: "custom",
        message: `a GROQ filter like "!(archived == true)" ${problem}`,
      });
  });

const listingSchema = z.strictObject({
  /** What the listing is called in a finding. Default: its path. */
  name: z.string().trim().min(1).max(60).optional(),
  /** The listing page (its first page of results). */
  page: path,
  /** The document type the listing shows. */
  type: typeName,
  /** Which published documents of that type the listing is meant to show. Default: all of them. */
  filter: filter.optional(),
  /** Each entry on the page. */
  item: selector,
  /** Where the next page of results is linked, when it is not a link with rel="next". */
  next: selector.optional(),
  /** The field the entry's address is made from, to name the entries that are missing. Default slug.current. */
  slug: fieldPath.optional(),
});

const dependentSchema = z.strictObject({
  /** What the block is called in a finding. Default: its page and type. */
  name: z.string().trim().min(1).max(60).optional(),
  /** The page the block is on. */
  page: path,
  /** Each entry the block shows. */
  selector,
  /** The document type the block embeds. */
  type: typeName,
  /** Which published documents of that type the block may show. Default: all of them. */
  filter: filter.optional(),
  /** The list's name in the saved run (--since last): the heading before it, or its data-list value. */
  block: z.string().trim().min(1).max(80).optional(),
});

/** gaugeline.model.json: how the content model is read, and which pages are built from it. */
export const modelConfigSchema = z.strictObject({
  /** The schema file `sanity schema extract` writes, relative to this file. */
  schema: z.string().min(1).max(260).optional(),
  /** The schema file from before the change: fields it had and the schema no longer has are looked for in the documents. */
  previousSchema: z.string().min(1).max(260).optional(),
  /** Fields known to be retired, by document type, looked for in the documents. */
  retired: z.record(typeName, z.array(fieldName).min(1).max(50)).optional(),
  /** Listing pages: how many entries they show against how many are published. */
  listings: z.array(listingSchema).max(MAX_MODEL_RULES).optional(),
  /** Blocks on other pages that embed entries of a type. */
  dependents: z.array(dependentSchema).max(MAX_MODEL_RULES).optional(),
  /** Pages (a trailing * means "and everything under it") where an id is shown on purpose. */
  idsShownOn: z.array(pathPattern).max(20).optional(),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type ModelListing = z.infer<typeof listingSchema>;
export type ModelDependent = z.infer<typeof dependentSchema>;

/** Whether a path is covered by a pattern: exact, or a trailing * for "and everything under it". */
export function pathMatches(pattern: string, path: string): boolean {
  const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  if (pattern.endsWith("*")) {
    const base = trim(pattern.slice(0, -1));
    const here = trim(path);
    return base === "/" || here === base || here.startsWith(`${base}/`);
  }
  return trim(pattern) === trim(path);
}
