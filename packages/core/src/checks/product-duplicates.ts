import type { PrintfulProduct } from "../connectors/printful.js";
import type { SanityProduct } from "../connectors/sanity.js";
import type { StripeProduct } from "../connectors/stripe.js";
import { CheckRegistry, defineCheck, type Check, type Finding } from "../model.js";
import { normaliseName, normaliseSku } from "../products/match.js";
import { formatMoney } from "../products/money.js";
import { escapeInvisible } from "./hidden-text/escape.js";

/**
 * What the duplicate checks read: the connectors' own output, as `runConnectors` gives it, before
 * and without the matcher. A system that returned nothing (not configured, refused the key, did not
 * answer) is left out, so a failed connector is never read as a system with no duplicates; a system
 * that answered with an empty list is `[]`. `duplicatesInput` builds it from a connector run.
 */
export interface ProductDuplicatesInput {
  sanity?: readonly SanityProduct[];
  stripe?: readonly StripeProduct[];
  printful?: readonly PrintfulProduct[];
}

export const DUPLICATE_CHECK_IDS = [
  "duplicate-printful",
  "duplicate-sanity",
  "duplicate-stripe",
] as const;
export type DuplicateCheckId = (typeof DUPLICATE_CHECK_IDS)[number];

/** Build the input from the connector run: a system counts as read when the run holds an entry for it. */
export function duplicatesInput(run: {
  data: ReadonlyMap<string, readonly unknown[]>;
}): ProductDuplicatesInput {
  const sanity = run.data.get("sanity") as readonly SanityProduct[] | undefined;
  const stripe = run.data.get("stripe") as readonly StripeProduct[] | undefined;
  const printful = run.data.get("printful") as readonly PrintfulProduct[] | undefined;
  return {
    ...(sanity === undefined ? {} : { sanity }),
    ...(stripe === undefined ? {} : { stripe }),
    ...(printful === undefined ? {} : { printful }),
  };
}

// ---- grouping -----------------------------------------------------------------------------------

/**
 * The records that share a key, as groups of two or more, each group in input order and the groups
 * in the order their first record appeared. One pass over the records into a Map<string, T[]>
 * (a Map keeps insertion order, so first-seen order costs nothing); pairs are never compared, so
 * three copies are one group and not three pairs. An undefined or empty key is never a group.
 */
export function findDuplicates<T>(
  records: readonly T[],
  keyOf: (r: T) => string | undefined,
): T[][] {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const key = keyOf(record);
    if (key === undefined || key === "") continue;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [record]);
    else bucket.push(record);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

// ---- words --------------------------------------------------------------------------------------

/** The most copies a finding lists before it counts the rest. */
export const DUPLICATE_LIST_MAX = 10;

/** Text from a system, for one line of evidence: escaped and cut. */
const safe = (text: string, max = 60): string => escapeInvisible(text, max);

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

/** What the copies were grouped on. */
type Kind = "name" | "SKU" | "external id";

/** One group to report: the copies to list, and copies of the same key already reported under the name. */
interface Group<T> {
  kind: Kind;
  /** The key as the system holds it, from the first copy: the name, SKU or external id. */
  shown: string;
  copies: T[];
  /** Records of this group that an earlier group of the same system listed. */
  elsewhere: T[];
}

/**
 * The groups of one system, name first and then the other keys in order. A record that falls in
 * two groups (same name as one record, same SKU as another) is listed once, in the name group; a
 * later group lists only records not listed yet and names the ones that were, so nothing is lost
 * and nothing is counted twice. A later group with nothing new is dropped.
 */
function groupsOf<T>(
  records: readonly T[],
  keys: readonly { kind: Kind; keyOf: (r: T) => string | undefined; shown: (r: T) => string }[],
): Group<T>[] {
  const listed = new Set<T>();
  const out: Group<T>[] = [];
  for (const { kind, keyOf, shown } of keys) {
    for (const group of findDuplicates(records, keyOf)) {
      const copies = group.filter((r) => !listed.has(r));
      if (copies.length === 0) continue;
      const elsewhere = group.filter((r) => listed.has(r));
      for (const r of copies) listed.add(r);
      out.push({ kind, shown: shown(group[0] as T), copies, elsewhere });
    }
  }
  return out;
}

const ACTION = "Keep one, archive the rest and point the website at the one you keep.";

/** The copies for one line: at most DUPLICATE_LIST_MAX, then a count of the rest. */
function listOf(items: readonly string[]): string {
  const shown = items.slice(0, DUPLICATE_LIST_MAX).join("; ");
  return items.length > DUPLICATE_LIST_MAX
    ? `${shown}; and ${items.length - DUPLICATE_LIST_MAX} more`
    : shown;
}

/** "2 products in Sanity share the name "Tote": ..." for any system. */
function sentence<T>(
  system: string,
  noun: string,
  g: Group<T>,
  describe: (r: T) => string,
  extra: string,
): string {
  const n = g.copies.length;
  const key = g.kind === "name" ? `name "${safe(g.shown)}"` : `${g.kind} "${safe(g.shown)}"`;
  const head =
    g.elsewhere.length === 0
      ? `${n} ${plural(n, noun)} in ${system} share the ${key}`
      : `${n} more ${plural(n, noun)} in ${system} ${n === 1 ? "shares" : "share"} the ${key}`;
  const also =
    g.elsewhere.length === 0
      ? ""
      : ` The ${g.kind} is also on ${g.elsewhere
          .slice(0, DUPLICATE_LIST_MAX)
          .map((r) => describe(r).split(" ")[0])
          .join(", ")} (reported under its name).`;
  return `${head}: ${listOf(g.copies.map(describe))}.${also}${extra} ${ACTION}`;
}

// ---- Stripe -------------------------------------------------------------------------------------

/** A product's default price for a line of evidence. Nothing here is a float: the amount is an integer. */
function priceOf(p: StripeProduct): string {
  if (p.defaultPriceId === null) return "no default price";
  const price = p.prices.find((x) => x.id === p.defaultPriceId);
  if (price === undefined) return "default price not read";
  if (price.unitAmount === null) return "no fixed amount";
  return `default price ${formatMoney({ amount: price.unitAmount, currency: price.currency })}`;
}

/** The amount of a default price, or undefined when there is none to compare. */
function amountOf(p: StripeProduct): string | undefined {
  const price = p.prices.find((x) => x.id === p.defaultPriceId);
  return price === undefined || price.unitAmount === null
    ? undefined
    : formatMoney({ amount: price.unitAmount, currency: price.currency });
}

function scanStripe(products: readonly StripeProduct[]): Finding[] {
  const active = products.filter((p) => p.active);
  // Archived products are indexed by name so a group can mention its archived siblings.
  const archivedByName = new Map<string, StripeProduct[]>();
  for (const p of products) {
    if (p.active) continue;
    const key = normaliseName(p.name);
    if (key === "") continue;
    const bucket = archivedByName.get(key);
    if (bucket === undefined) archivedByName.set(key, [p]);
    else bucket.push(p);
  }
  return findDuplicates(active, (p) => normaliseName(p.name)).map((copies) => {
    const first = copies[0] as StripeProduct;
    const prices = [...new Set(copies.map(amountOf).filter((a): a is string => a !== undefined))];
    const differ =
      prices.length > 1
        ? ` The copies charge different prices: ${prices.slice(0, DUPLICATE_LIST_MAX).join(", ")}.`
        : "";
    const archived = archivedByName.get(normaliseName(first.name)) ?? [];
    const siblings =
      archived.length === 0
        ? ""
        : ` ${archived.length} archived ${plural(archived.length, "product")} with the same name ${archived.length === 1 ? "is" : "are"} not counted: ${archived
            .slice(0, DUPLICATE_LIST_MAX)
            .map((p) => safe(p.id))
            .join(", ")}.`;
    const group: Group<StripeProduct> = {
      kind: "name",
      shown: first.name,
      copies,
      elsewhere: [],
    };
    return {
      checkId: "duplicate-stripe",
      severity: "medium",
      title: TITLES["duplicate-stripe"],
      evidence: sentence(
        "Stripe",
        "active product",
        group,
        (p) => `${safe(p.id)} "${safe(p.name)}" (${priceOf(p)})`,
        `${differ}${siblings}`,
      ),
      url: `stripe:${first.id}`,
    };
  });
}

// ---- Sanity and Printful ------------------------------------------------------------------------

const nameKey = (r: { name: string }): string => normaliseName(r.name);

function scanSanity(products: readonly SanityProduct[]): Finding[] {
  const groups = groupsOf(products, [
    { kind: "name", keyOf: nameKey, shown: (r) => r.name },
    {
      kind: "SKU",
      keyOf: (r) => normaliseSku(r.sku) ?? undefined,
      shown: (r) => (r.sku ?? "").trim(),
    },
  ]);
  return groups.map((g) => ({
    checkId: "duplicate-sanity",
    severity: "medium",
    title: TITLES["duplicate-sanity"],
    evidence: sentence("Sanity", "product", g, (r) => `${safe(r._id)} "${safe(r.name)}"`, ""),
    url: `sanity:${(g.copies[0] as SanityProduct)._id}`,
  }));
}

const externalKey = (r: PrintfulProduct): string | undefined => {
  const t = (r.externalId ?? "").trim();
  return t === "" ? undefined : t;
};

function scanPrintful(products: readonly PrintfulProduct[]): Finding[] {
  const groups = groupsOf(products, [
    { kind: "name", keyOf: nameKey, shown: (r) => r.name },
    { kind: "external id", keyOf: externalKey, shown: (r) => externalKey(r) ?? "" },
  ]);
  return groups.map((g) => ({
    checkId: "duplicate-printful",
    severity: "medium",
    title: TITLES["duplicate-printful"],
    evidence: sentence("Printful", "product", g, (r) => `${safe(r.id)} "${safe(r.name)}"`, ""),
    url: `printful:${(g.copies[0] as PrintfulProduct).id}`,
  }));
}

// ---- the checks ---------------------------------------------------------------------------------

const TITLES: Readonly<Record<DuplicateCheckId, string>> = {
  "duplicate-printful": "The same product is in Printful more than once",
  "duplicate-sanity": "The same product is on the website more than once",
  "duplicate-stripe": "The same product is in Stripe more than once",
};

export const duplicateStripe = defineCheck<ProductDuplicatesInput>({
  id: "duplicate-stripe",
  size: "S",
  done: "One product is kept active in Stripe and the others are archived.",
  estimateChanges: "Payment links and subscriptions on the copies have to be moved first.",
  area: "Sales & prices",
  severity: "medium",
  title: TITLES["duplicate-stripe"],
  what: "Two or more active Stripe products have the same name once case, spacing and punctuation are ignored.",
  why: "Until one record is the real one, nothing can say what checkout should charge: the copies may carry different prices, and the website may point at any of them.",
  fix: "Keep one, archive the rest in Stripe and point the website at the one you keep. Gaugeline does not choose which.",
  tech: "active Stripe products grouped by normaliseName in one pass into a Map; one finding per group listing every copy with its id and default price, up to 10 and then a count; archived products are not counted as copies and are named in the finding when their group also has active ones; names that normalise to an empty string are never grouped; runs only when Stripe returned data",
  run: (input) => (input.stripe === undefined ? [] : scanStripe(input.stripe)),
});

export const duplicateSanity = defineCheck<ProductDuplicatesInput>({
  id: "duplicate-sanity",
  size: "S",
  done: "One product is kept in the website's content and the others are unpublished or deleted.",
  estimateChanges: "Links to the copies need a redirect.",
  area: "Sales & prices",
  severity: "medium",
  title: TITLES["duplicate-sanity"],
  what: "Two or more published Sanity products have the same name, or the same non-empty SKU.",
  why: "The shop has the same product twice, so a price, a photo or a stock figure can be right on one copy and wrong on the other, and a link to checkout may be saved on only one of them.",
  fix: "Keep one product, unpublish or delete the rest in Sanity and point the website at the one you keep. Gaugeline does not choose which.",
  tech: "published Sanity products grouped by normaliseName, then by SKU (trimmed, lower-case), each in one pass into a Map; a product in a name group and a SKU group is listed once, in the name group; one finding per group with every copy's _id, up to 10 and then a count; an empty SKU or a name that normalises to nothing is never a group; runs only when Sanity returned data",
  run: (input) => (input.sanity === undefined ? [] : scanSanity(input.sanity)),
});

export const duplicatePrintful = defineCheck<ProductDuplicatesInput>({
  id: "duplicate-printful",
  size: "S",
  done: "One product is kept in Printful and the website points at it.",
  estimateChanges: "Orders attached to the copies need care before they are deleted.",
  area: "Sales & prices",
  severity: "medium",
  title: TITLES["duplicate-printful"],
  what: "Two or more Printful products have the same name, or the same external id.",
  why: "An order for the product can be made from either copy, with different designs or prices, and the shop only knows one of them.",
  fix: "Keep one product, delete the rest in Printful and point the website at the one you keep. Gaugeline does not choose which.",
  tech: "Printful store products grouped by normaliseName, then by external id (trimmed, exact), each in one pass into a Map; a product in a name group and an external id group is listed once, in the name group; one finding per group with every copy's id, up to 10 and then a count; a blank external id or a name that normalises to nothing is never a group; runs only when Printful returned data",
  run: (input) => (input.printful === undefined ? [] : scanPrintful(input.printful)),
});

/** The three duplicate checks, in id order. They read a ProductDuplicatesInput, not a page. */
export const DUPLICATE_CHECKS: readonly Check<ProductDuplicatesInput>[] = [
  duplicatePrintful,
  duplicateSanity,
  duplicateStripe,
];

export function createDuplicatesRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of DUPLICATE_CHECKS) registry.register(c);
  return registry;
}
