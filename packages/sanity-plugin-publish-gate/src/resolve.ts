/**
 * Which page a Sanity document renders to. Pure string work with no imports, so the Studio can use
 * it in the browser and the Function can use it in Node: the same document gives the same answer.
 * Everything in a document is data: a slug is checked against a short list of safe characters
 * before it goes into an address, and an address can never leave the site.
 */

/** The parts of a document the resolver reads. Any other field is allowed and ignored. */
export interface GateDocument {
  _id: string;
  _type: string;
  [field: string]: unknown;
}

/**
 * How one document type maps to a page: a template ("/shop/{category.slug}/{slug}"), a function
 * that returns a path, or null for a type that is not a page (site settings).
 */
export type PageRule = string | null | ((doc: GateDocument) => string | null | undefined);
export type PageRules = Readonly<Record<string, PageRule>>;

export interface ResolveOptions {
  /** The live site, for example "https://lantern-yard.example". */
  site: string;
  pages: PageRules;
}

export type Resolution =
  | { kind: "page"; url: string }
  /** Not a page (a settings document, a type with no rule). Not gated. */
  | { kind: "no-page"; reason: string }
  /** A page, but its address cannot be worked out from the document. The reason names the field. */
  | { kind: "unresolved"; reason: string };

/** One or more slug segments: letters, digits and . _ ~ - only; "." and ".." are refused below. */
const SLUG = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
/** The longest slug taken into an address, and the longest address a rule may give. */
const MAX_SLUG = 512;
const MAX_URL = 2048;
const FIELD = /\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g;

function valueAt(doc: GateDocument, path: string): unknown {
  let at: unknown = doc;
  for (const key of path.split(".")) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  // A Sanity slug is { _type: "slug", current: "menu" }.
  if (at !== null && typeof at === "object" && "current" in at)
    return (at as { current: unknown }).current;
  return at;
}

function fill(template: string, doc: GateDocument): string | { missing: string } {
  let missing: string | undefined;
  const filled = template.replace(FIELD, (_, path: string) => {
    const v = valueAt(doc, path);
    const text = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
    if (
      typeof text !== "string" ||
      text.length > MAX_SLUG ||
      !SLUG.test(text) ||
      text.split("/").some((s) => s === "." || s === "..")
    ) {
      missing ??= path;
      return "";
    }
    return text;
  });
  return missing === undefined ? filled : { missing };
}

/** Where a path goes on the site, or undefined when it would leave it. */
function onSite(path: string, site: URL): string | undefined {
  if (path.length > MAX_URL) return undefined;
  if (/^\/(?![/\\])/.test(path)) {
    // A path: the base decides the host, whatever the path holds.
    const url = new URL(path, site);
    return url.origin === site.origin ? url.href : undefined;
  }
  if (/^https?:\/\//i.test(path) && URL.canParse(path)) {
    const url = new URL(path);
    // An address with a user name or password would be requested, and reported, with it.
    if (url.username !== "" || url.password !== "") return undefined;
    return url.origin === site.origin ? url.href : undefined;
  }
  return undefined;
}

export function resolvePage(doc: GateDocument, options: ResolveOptions): Resolution {
  if (!/^https?:\/\/[^\s/]/i.test(options.site) || !URL.canParse(options.site))
    throw new Error(
      "site must be a full http or https address, for example https://lantern-yard.example.",
    );
  const site = new URL(options.site);
  if (!Object.hasOwn(options.pages, doc._type))
    return { kind: "no-page", reason: `"${doc._type}" documents have no page rule.` };
  const rule = options.pages[doc._type];
  if (rule === null || rule === undefined)
    return { kind: "no-page", reason: `"${doc._type}" documents are not pages.` };
  const made = typeof rule === "function" ? rule(doc) : fill(rule, doc);
  if (made === null || made === undefined)
    return { kind: "no-page", reason: `This ${doc._type} renders to no page.` };
  if (typeof made === "object")
    return {
      kind: "unresolved",
      reason: `The page address needs "${made.missing}", which is missing or not a safe slug.`,
    };
  const url = onSite(made, site);
  return url === undefined
    ? { kind: "unresolved", reason: "The page rule gave an address that is not on the site." }
    : { kind: "page", url };
}
