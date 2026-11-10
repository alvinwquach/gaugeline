import type { PrintfulProduct } from "../connectors/printful.js";
import type { SanityProduct } from "../connectors/sanity.js";
import type { StripeProduct } from "../connectors/stripe.js";

/**
 * Which rule paired two records, strongest first. The order is the one docs/products-and-prices
 * promises and it must not change: a product that matches at a stronger tier never reaches a weaker one.
 */
export const TIERS = ["saved-id", "metadata-id", "sku", "name"] as const;
export type Tier = (typeof TIERS)[number];

export type System = "stripe" | "printful";

/** Why a pair was made: the tier and the two fields that agreed. Field names only, never a client's text. */
export interface MatchEvidence {
  tier: Tier;
  sanityField: string;
  otherField: string;
  /**
   * Ids of other records in the same system that carry the same key. The first in input order was
   * taken and these were left unmatched. Empty when the key was unique.
   */
  sharedWith: string[];
}

export interface ProductGroup {
  sanity?: SanityProduct;
  stripe?: StripeProduct;
  printful?: PrintfulProduct;
  stripeTier?: Tier;
  printfulTier?: Tier;
  stripeEvidence?: MatchEvidence;
  printfulEvidence?: MatchEvidence;
}

/**
 * A place where the rules could not say "this one". Nothing here is a finding (the matcher emits
 * none); a later check decides what to say.
 *
 * - "claimed": the record the key leads to already belongs to an earlier Sanity product. This
 *   product is left without a partner in that system and does not try a weaker tier.
 * - "shared-key": two or more records of one system carry the key. The first in input order was
 *   taken (`chosen`); the rest are in `candidates` and stay unmatched.
 */
export interface AmbiguousMatch {
  sanityId: string;
  system: System;
  tier: Tier;
  reason: "claimed" | "shared-key";
  candidates: string[];
  chosen?: string;
}

export interface MatchResult {
  /** One group per Sanity product, in the order Sanity gave them. */
  groups: ProductGroup[];
  unmatchedStripe: StripeProduct[];
  unmatchedPrintful: PrintfulProduct[];
  ambiguous: AmbiguousMatch[];
}

// ---- keys ---------------------------------------------------------------------------------------

/**
 * A name as a key: Unicode NFKD, combining marks removed, lower-cased, and everything that is not a
 * letter or a digit dropped. "Tee", "tee!", " TEE " and "Tee" with an accent are one key; "Tee 2" is another.
 * A name with no letters or digits (only emoji, say) is the empty string, which is never a key.
 */
export function normaliseName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** A SKU as a key: trimmed and lower-cased. null when there is nothing left, so empty never matches empty. */
export function normaliseSku(s: string | undefined | null): string | null {
  const t = (s ?? "").trim().toLowerCase();
  return t === "" ? null : t;
}

/** An id as a key: trimmed, otherwise exact. null when blank. */
function idKey(s: string | undefined | null): string | null {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
}

function nameKey(s: string | undefined | null): string | null {
  const t = normaliseName(s ?? "");
  return t === "" ? null : t;
}

// ---- indexes ------------------------------------------------------------------------------------

/** key -> records carrying it, in input order. The first is the one a match takes. */
type Index<T> = Map<string, T[]>;

function add<T>(index: Index<T>, key: string | null, record: T): void {
  if (key === null) return;
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, [record]);
  else if (bucket[bucket.length - 1] !== record) bucket.push(record);
}

interface Indexes<T> {
  byId: Index<T>;
  byMeta: Index<T>;
  bySku: Index<T>;
  byName: Index<T>;
}

/** What one system has to say for each tier: the key a record offers, and the field names for the evidence. */
interface SystemSpec<T extends { id: string }> {
  system: System;
  /** The key the Sanity product offers for each tier, or null when it offers none. */
  sanityKey: Record<Tier, (s: SanityProduct) => string | null>;
  sanityField: Record<Tier, string>;
  otherField: Record<Tier, string>;
  offered: (record: T) => Record<Tier, (string | null)[]>;
}

const stripeSku = (p: StripeProduct): string | null => {
  // metadata.sku, whatever the case of the name "sku": the first such key in sorted order, so the
  // answer never depends on the order the keys came in.
  const key = Object.keys(p.metadata)
    .filter((k) => k.toLowerCase() === "sku")
    .sort()[0];
  return key === undefined ? null : normaliseSku(p.metadata[key]);
};

/** What a Sanity product offers for each tier; only the saved id differs between the two systems. */
function sanityKeys(
  savedId: (s: SanityProduct) => string | undefined,
): SystemSpec<never>["sanityKey"] {
  return {
    "saved-id": (s) => idKey(savedId(s)),
    "metadata-id": (s) => idKey(s._id),
    sku: (s) => normaliseSku(s.sku),
    name: (s) => nameKey(s.name),
  };
}

const STRIPE_SPEC: SystemSpec<StripeProduct> = {
  system: "stripe",
  sanityKey: sanityKeys((s) => s.stripeId),
  sanityField: { "saved-id": "stripeId", "metadata-id": "_id", sku: "sku", name: "name" },
  otherField: {
    "saved-id": "id",
    "metadata-id": "metadata.sanityId",
    sku: "metadata.sku",
    name: "name",
  },
  offered: (p) => ({
    "saved-id": [idKey(p.id)],
    "metadata-id": [idKey(p.metadata.sanityId)],
    sku: [stripeSku(p)],
    name: [nameKey(p.name)],
  }),
};

const PRINTFUL_SPEC: SystemSpec<PrintfulProduct> = {
  system: "printful",
  sanityKey: sanityKeys((s) => s.printfulId),
  sanityField: { ...STRIPE_SPEC.sanityField, "saved-id": "printfulId" },
  otherField: {
    "saved-id": "id",
    "metadata-id": "externalId",
    sku: "variants[].sku",
    name: "name",
  },
  offered: (p) => ({
    "saved-id": [idKey(p.id)],
    "metadata-id": [idKey(p.externalId)],
    // Every variant offers its SKU: a Sanity SKU matches the product that sells that variant.
    sku: p.variants.map((v) => normaliseSku(v.sku)),
    name: [nameKey(p.name)],
  }),
};

function build<T extends { id: string }>(records: readonly T[], spec: SystemSpec<T>): Indexes<T> {
  const ix: Indexes<T> = {
    byId: new Map(),
    byMeta: new Map(),
    bySku: new Map(),
    byName: new Map(),
  };
  for (const r of records) {
    const o = spec.offered(r);
    for (const k of o["saved-id"]) add(ix.byId, k, r);
    for (const k of o["metadata-id"]) add(ix.byMeta, k, r);
    for (const k of o.sku) add(ix.bySku, k, r);
    for (const k of o.name) add(ix.byName, k, r);
  }
  return ix;
}

const INDEX_OF: Record<Tier, keyof Indexes<never>> = {
  "saved-id": "byId",
  "metadata-id": "byMeta",
  sku: "bySku",
  name: "byName",
};

interface Found<T> {
  record: T;
  tier: Tier;
  evidence: MatchEvidence;
}

/**
 * Try the four tiers for one Sanity product in one system and stop at the first hit. A key with no
 * record is not a hit (the next tier is tried). A key whose first record is already claimed is a
 * hit that cannot be used: the search stops and the product is left without a partner.
 */
function find<T extends { id: string }>(
  s: SanityProduct,
  spec: SystemSpec<T>,
  ix: Indexes<T>,
  claimed: Set<string>,
  ambiguous: AmbiguousMatch[],
): Found<T> | null {
  for (const tier of TIERS) {
    const key = spec.sanityKey[tier](s);
    if (key === null) continue;
    const candidates = ix[INDEX_OF[tier]].get(key);
    if (candidates === undefined) continue;
    const first = candidates[0] as T;
    const ids = candidates.map((c) => c.id);
    if (claimed.has(first.id)) {
      ambiguous.push({
        sanityId: s._id,
        system: spec.system,
        tier,
        reason: "claimed",
        candidates: ids,
      });
      return null;
    }
    claimed.add(first.id);
    const sharedWith = ids.slice(1);
    if (sharedWith.length > 0)
      ambiguous.push({
        sanityId: s._id,
        system: spec.system,
        tier,
        reason: "shared-key",
        candidates: ids,
        chosen: first.id,
      });
    return {
      record: first,
      tier,
      evidence: {
        tier,
        sanityField: spec.sanityField[tier],
        otherField: spec.otherField[tier],
        sharedWith,
      },
    };
  }
  return null;
}

/**
 * Pair each Sanity product with the Stripe and Printful product it stands for. Pure: no network,
 * no clock, no randomness, so the same input always gives the same answer.
 *
 * Sanity is the anchor and is read in input order. For each product and each system the tiers run
 * strongest first (TIERS) and stop at the first hit. A record that has been paired is claimed and
 * cannot be paired again. There is no score, no edit distance and no transitive merging, and no
 * finding is emitted here.
 *
 * A system that is not configured is passed as undefined (or empty). With no Sanity products there
 * are no groups and every Stripe and Printful product is unmatched.
 */
export function matchProducts(
  sanity: readonly SanityProduct[] | undefined,
  stripe: readonly StripeProduct[] | undefined,
  printful: readonly PrintfulProduct[] | undefined,
): MatchResult {
  const stripes = stripe ?? [];
  const printfuls = printful ?? [];
  const stripeIx = build(stripes, STRIPE_SPEC);
  const printfulIx = build(printfuls, PRINTFUL_SPEC);
  const stripeClaimed = new Set<string>();
  const printfulClaimed = new Set<string>();
  const ambiguous: AmbiguousMatch[] = [];

  const groups: ProductGroup[] = [];
  for (const s of sanity ?? []) {
    const group: ProductGroup = { sanity: s };
    const st = find(s, STRIPE_SPEC, stripeIx, stripeClaimed, ambiguous);
    if (st) {
      group.stripe = st.record;
      group.stripeTier = st.tier;
      group.stripeEvidence = st.evidence;
    }
    const pf = find(s, PRINTFUL_SPEC, printfulIx, printfulClaimed, ambiguous);
    if (pf) {
      group.printful = pf.record;
      group.printfulTier = pf.tier;
      group.printfulEvidence = pf.evidence;
    }
    groups.push(group);
  }

  return {
    groups,
    unmatchedStripe: stripes.filter((p) => !stripeClaimed.has(p.id)),
    unmatchedPrintful: printfuls.filter((p) => !printfulClaimed.has(p.id)),
    ambiguous,
  };
}
