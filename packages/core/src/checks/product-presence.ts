import type { PrintfulProduct } from "../connectors/printful.js";
import type { StripeProduct } from "../connectors/stripe.js";
import { CheckRegistry, defineCheck, type Check, type Finding } from "../model.js";
import type { MatchResult, ProductGroup } from "../products/match.js";
import { escapeInvisible } from "./hidden-text/escape.js";
import { matchedBy } from "./prices.js";

/**
 * Which systems returned data in this run. A system that is not configured, did not answer or
 * refused the key is `false`; one that answered with an empty list is `true`. The difference is the
 * point of these checks: a failed Stripe must never look like a Stripe with no products.
 */
export interface ProductSystemsRead {
  sanity: boolean;
  stripe: boolean;
  printful: boolean;
}

/**
 * What the presence checks read: the result of matchProducts (no requests are made here) and which
 * systems returned data. `presenceInput` builds it from a match and the connector run.
 */
export interface ProductPresenceInput {
  /** One group per Sanity product, in the order Sanity gave them. */
  groups: readonly ProductGroup[];
  unmatchedStripe: readonly StripeProduct[];
  unmatchedPrintful: readonly PrintfulProduct[];
  read: ProductSystemsRead;
}

export const PRESENCE_CHECK_IDS = [
  "printful-missing",
  "printful-orphan",
  "printful-unsynced",
  "stripe-archived",
  "stripe-missing",
  "stripe-orphan",
] as const;
export type PresenceCheckId = (typeof PRESENCE_CHECK_IDS)[number];

/**
 * Build the input from a match and the connector run: a system counts as read when the run holds
 * an entry for it (`runConnectors` gives no entry to a connector that has no answer).
 */
export function presenceInput(
  match: Pick<MatchResult, "groups" | "unmatchedStripe" | "unmatchedPrintful">,
  run: { data: ReadonlyMap<string, unknown[]> },
): ProductPresenceInput {
  return {
    groups: match.groups,
    unmatchedStripe: match.unmatchedStripe,
    unmatchedPrintful: match.unmatchedPrintful,
    read: {
      sanity: run.data.has("sanity"),
      stripe: run.data.has("stripe"),
      printful: run.data.has("printful"),
    },
  };
}

// ---- words --------------------------------------------------------------------------------------

/** The most unsynced variants a finding lists before it counts the rest. */
const VARIANT_MAX = 10;

const plural = (n: number, one: string, many = `${one}s`): string => `${n === 1 ? one : many}`;

/** Text from a system, for one line of evidence: escaped and cut. */
const safe = (text: string, max = 60): string => escapeInvisible(text, max);

/** A product's name for a message. The id stands in for an empty name. */
function nameOf(name: string, id: string): string {
  const text = safe(name).trim();
  return text === "" ? safe(id) : text;
}

/** "Sanity x, Stripe y": the ids from each system that has the product. */
function idsOf(parts: readonly (readonly [string, string | undefined])[]): string {
  return parts
    .filter((p): p is readonly [string, string] => p[1] !== undefined)
    .map(([system, id]) => `${system} ${safe(id)}`)
    .join(", ");
}

const sanityRef = (g: ProductGroup): string => `sanity:${g.sanity?._id ?? ""}`;
const sanityName = (g: ProductGroup): string => nameOf(g.sanity?.name ?? "", g.sanity?._id ?? "");

/** How many products a system returned: the paired ones and the leftovers. */
function totals(i: ProductPresenceInput): { sanity: number; stripe: number; printful: number } {
  return {
    sanity: i.groups.length,
    stripe: i.groups.filter((g) => g.stripe !== undefined).length + i.unmatchedStripe.length,
    printful: i.groups.filter((g) => g.printful !== undefined).length + i.unmatchedPrintful.length,
  };
}

const NAMES = { sanity: "Sanity", stripe: "Stripe", printful: "Printful" } as const;

/**
 * One line per system saying what it returned, so an empty Stripe is told apart from one that was
 * not read: "Stripe returned zero products." or "Stripe was not read."
 */
export function summarisePresence(i: ProductPresenceInput): string[] {
  const n = totals(i);
  return (["sanity", "stripe", "printful"] as const).map((s) =>
    !i.read[s]
      ? `${NAMES[s]} was not read.`
      : `${NAMES[s]} returned ${n[s] === 0 ? "zero products" : `${n[s]} ${plural(n[s], "product")}`}.`,
  );
}

// ---- the passes ---------------------------------------------------------------------------------
// Each check is one pass over the groups or over one leftover list. The matcher already built the
// Maps; nothing here looks anything up twice.

interface Subject<T> {
  product: T;
  /** The Sanity product it was paired with. Absent when Sanity was not read. */
  group?: ProductGroup;
}

/**
 * The Stripe products the archived check looks at: the paired ones when Sanity was read, in
 * Sanity's order; every product that was read, in Stripe's order, when Sanity was not (nothing is
 * paired then, and an archived product is archived whoever links it).
 */
function stripeSubjects(i: ProductPresenceInput): Subject<StripeProduct>[] {
  if (!i.read.stripe) return [];
  if (!i.read.sanity) return i.unmatchedStripe.map((product) => ({ product }));
  return i.groups.flatMap((group) =>
    group.stripe === undefined ? [] : [{ product: group.stripe, group }],
  );
}

function printfulSubjects(i: ProductPresenceInput): Subject<PrintfulProduct>[] {
  if (!i.read.printful) return [];
  if (!i.read.sanity) return i.unmatchedPrintful.map((product) => ({ product }));
  return i.groups.flatMap((group) =>
    group.printful === undefined ? [] : [{ product: group.printful, group }],
  );
}

const TITLES: Readonly<Record<PresenceCheckId, string>> = {
  "printful-missing": "On the website, not in fulfillment",
  "printful-orphan": "In fulfillment, not on the website",
  "printful-unsynced": "A fulfillment product has variants that cannot be made",
  "stripe-archived": "A website product is archived in checkout",
  "stripe-missing": "A website product is missing from checkout",
  "stripe-orphan": "In checkout, not on the website",
};

function scanStripeMissing(i: ProductPresenceInput): Finding[] {
  if (!i.read.sanity || !i.read.stripe) return [];
  const empty = totals(i).stripe === 0;
  return i.groups
    .filter((g) => g.sanity !== undefined && g.stripe === undefined)
    .map((g) => ({
      checkId: "stripe-missing",
      severity: "high",
      title: TITLES["stripe-missing"],
      evidence: `"${sanityName(g)}" (${idsOf([["Sanity", g.sanity?._id]])}) is on the website but has no product in Stripe, so checkout cannot sell it.${empty ? " Stripe returned zero products." : ""}`,
      url: sanityRef(g),
    }));
}

function scanStripeArchived(i: ProductPresenceInput): Finding[] {
  return stripeSubjects(i)
    .filter((s) => !s.product.active)
    .map(({ product, group }) => {
      const how = matchedBy(group?.stripeTier);
      return {
        checkId: "stripe-archived",
        severity: "high",
        title: TITLES["stripe-archived"],
        evidence: `"${nameOf(product.name, product.id)}" (${idsOf([
          ["Sanity", group?.sanity?._id],
          ["Stripe", product.id],
        ])}) is archived in Stripe, so checkout will not sell it${group === undefined ? "." : ` while the website still lists it${how === "" ? "" : ` (${how})`}.`}`,
        url: group === undefined ? `stripe:${product.id}` : sanityRef(group),
      };
    });
}

function scanStripeOrphan(i: ProductPresenceInput): Finding[] {
  // With no Sanity products read nothing could have matched, so every Stripe product would be a leftover.
  if (!i.read.sanity || !i.read.stripe) return [];
  return i.unmatchedStripe
    .filter((p) => p.active)
    .map((p) => ({
      checkId: "stripe-orphan",
      severity: "low",
      title: TITLES["stripe-orphan"],
      evidence: `"${nameOf(p.name, p.id)}" (${idsOf([["Stripe", p.id]])}) is active in Stripe but no product on the website points to it. It may be a payment link on purpose; if it is not, archive it.`,
      url: `stripe:${p.id}`,
    }));
}

function scanPrintfulUnsynced(i: ProductPresenceInput): Finding[] {
  return printfulSubjects(i).flatMap(({ product, group }) => {
    const unsynced = product.variants.filter((v) => !v.synced);
    if (unsynced.length === 0) return [];
    const labels = unsynced.map((v) =>
      v.sku === undefined ? `variant ${safe(v.id)}` : safe(v.sku),
    );
    const shown = labels.slice(0, VARIANT_MAX).join(", ");
    const list =
      labels.length > VARIANT_MAX ? `${shown} and ${labels.length - VARIANT_MAX} more` : shown;
    const how = matchedBy(group?.printfulTier);
    return [
      {
        checkId: "printful-unsynced",
        severity: "high",
        title: TITLES["printful-unsynced"],
        evidence: `"${nameOf(product.name, product.id)}" (${idsOf([
          ["Sanity", group?.sanity?._id],
          ["Printful", product.id],
        ])}): ${unsynced.length} of ${product.variants.length} ${plural(product.variants.length, "variant")} ${unsynced.length === 1 ? "is" : "are"} not synced, so an order for ${unsynced.length === 1 ? "it" : "them"} cannot be made: ${list}${how === "" ? "" : ` (${how})`}.`,
        url: group === undefined ? `printful:${product.id}` : sanityRef(group),
      },
    ];
  });
}

function scanPrintfulMissing(i: ProductPresenceInput): Finding[] {
  if (!i.read.sanity || !i.read.printful) return [];
  return i.groups
    .filter((g) => g.sanity !== undefined && g.printful === undefined)
    .map((g) => ({
      checkId: "printful-missing",
      severity: "low",
      title: TITLES["printful-missing"],
      evidence: `"${sanityName(g)}" (${idsOf([["Sanity", g.sanity?._id]])}) has no product in Printful. That is expected for a digital product or anything you do not print; if this one should be printed, link it.`,
      url: sanityRef(g),
    }));
}

function scanPrintfulOrphan(i: ProductPresenceInput): Finding[] {
  if (!i.read.sanity || !i.read.printful) return [];
  return i.unmatchedPrintful.map((p) => ({
    checkId: "printful-orphan",
    severity: "low",
    title: TITLES["printful-orphan"],
    evidence: `"${nameOf(p.name, p.id)}" (${idsOf([["Printful", p.id]])}) is in Printful but no product on the website points to it. It may be a sample or a draft; if it is not, remove it or link it.`,
    url: `printful:${p.id}`,
  }));
}

// ---- the checks ---------------------------------------------------------------------------------

export const stripeMissing = defineCheck<ProductPresenceInput>({
  id: "stripe-missing",
  area: "Sales & prices",
  severity: "high",
  title: TITLES["stripe-missing"],
  what: "A product published on your website has no matching product in Stripe.",
  why: "A product people can see but checkout does not know cannot be bought: the button fails, or the order never reaches you. That is lost money from the first visitor.",
  fix: "Create the product in Stripe, or save its Stripe id on the website product so the two are linked. If it is not for sale, unpublish it.",
  tech: "a published Sanity product that matchProducts paired with no Stripe product; runs only when both Sanity and Stripe returned data, so a Stripe that was not configured, refused the key or did not answer never makes a product missing; a Stripe that answered with no products at all makes every product missing, and the evidence says so; one finding per product with its name and ids",
  run: (input) => scanStripeMissing(input),
});

export const stripeArchived = defineCheck<ProductPresenceInput>({
  id: "stripe-archived",
  area: "Sales & prices",
  severity: "high",
  title: TITLES["stripe-archived"],
  what: "The Stripe product matched to a product on your website is archived.",
  why: "Stripe will not sell an archived product, so the page invites a purchase that checkout turns down.",
  fix: "Unarchive the product in Stripe if it is still on sale, or take it off the website if it is not.",
  tech: "a matched Stripe product with active false; runs when Stripe returned data; an archived Stripe product that nothing matches is not reported (it is not an orphan either); with Sanity not read it is reported from the Stripe list alone; one finding per product with its name and the Sanity and Stripe ids",
  run: (input) => scanStripeArchived(input),
});

export const stripeOrphan = defineCheck<ProductPresenceInput>({
  id: "stripe-orphan",
  area: "Sales & prices",
  severity: "low",
  title: TITLES["stripe-orphan"],
  what: "An active Stripe product is not linked to any product on your website.",
  why: "It may be a payment link or an invoice item on purpose. If it is a leftover, it clutters reports and someone may sell it by mistake.",
  fix: "If it is meant to exist, leave it. If not, archive it in Stripe, or save its id on the website product it belongs to.",
  tech: "an active Stripe product in matchProducts' unmatchedStripe; archived ones are skipped; runs only when both Sanity and Stripe returned data, because with no website products read every Stripe product would be unmatched; one finding per product with its name and id",
  run: (input) => scanStripeOrphan(input),
});

export const printfulUnsynced = defineCheck<ProductPresenceInput>({
  id: "printful-unsynced",
  area: "Sales & prices",
  severity: "high",
  title: TITLES["printful-unsynced"],
  what: "A Printful product matched to a product on your website has a variant that is not synced.",
  why: "Printful cannot make an order for a variant whose design is not matched to a printable item, so a customer can pay for something that is never printed.",
  fix: "In Printful, open the product and finish syncing the variants listed, or remove them from the store and from the website.",
  tech: "a matched Printful product with at least one sync_variants entry whose synced is false; runs when Printful returned data; the variants are listed by SKU, or by id when there is none, at most 10 and then a count of the rest; an unmatched Printful product is not reported here; with Sanity not read it is reported from the Printful list alone",
  run: (input) => scanPrintfulUnsynced(input),
});

export const printfulMissing = defineCheck<ProductPresenceInput>({
  id: "printful-missing",
  area: "Sales & prices",
  severity: "low",
  title: TITLES["printful-missing"],
  what: "A product on your website has no matching product in Printful.",
  why: "For something you print, nobody will make the order. For a ticket, a download or a service, that is expected and nothing needs fixing.",
  fix: "If the product should be printed, create it in Printful or save its Printful id on the website product. Otherwise leave it.",
  tech: "a published Sanity product that matchProducts paired with no Printful product; runs only when both Sanity and Printful returned data; low because most shops sell some products that are not printed; one finding per product with its name and id",
  run: (input) => scanPrintfulMissing(input),
});

export const printfulOrphan = defineCheck<ProductPresenceInput>({
  id: "printful-orphan",
  area: "Sales & prices",
  severity: "low",
  title: TITLES["printful-orphan"],
  what: "A Printful product is not linked to any product on your website.",
  why: "It is probably a sample, a draft or a product that was taken off the website. It can still be ordered through Printful's own store.",
  fix: "Delete it in Printful if it is a leftover, or save its id on the website product it belongs to.",
  tech: "a Printful product in matchProducts' unmatchedPrintful; runs only when both Sanity and Printful returned data; one finding per product with its name and id",
  run: (input) => scanPrintfulOrphan(input),
});

/** The six presence checks, in id order. They read a ProductPresenceInput, not a page. */
export const PRESENCE_CHECKS: readonly Check<ProductPresenceInput>[] = [
  printfulMissing,
  printfulOrphan,
  printfulUnsynced,
  stripeArchived,
  stripeMissing,
  stripeOrphan,
];

export function createPresenceRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const c of PRESENCE_CHECKS) registry.register(c);
  return registry;
}
