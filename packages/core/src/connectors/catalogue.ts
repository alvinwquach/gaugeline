/**
 * What a seller's own system says it sells, in one shape for every provider. Shopify and Square
 * (X37) return rows of this shape directly, so whatever compares a page with a provider reads
 * these and cannot tell the two apart. Printful and Stripe keep their own shapes (G23a to G23c).
 *
 * Nothing here is content: no descriptions, images or variant names. An item is an id, a name, a
 * state and its variants; a variant is an id, a SKU, a price, a currency and whether it can be bought.
 */

/** One size, colour or option of an item. */
export interface CatalogueVariant {
  id: string;
  /** Absent when the provider has none (never an empty string). */
  sku?: string;
  /** Whole minor units (cents, pence). 0 is a free item. null means no fixed price, never a free one. */
  price: number | null;
  /** ISO 4217 code as the provider sends it, or "" when it did not say. */
  currency: string;
  /** true: can be bought now. false: sold out. null: the provider's answer does not say. */
  available: boolean | null;
}

export interface CatalogueItem {
  source: "shopify" | "square";
  id: string;
  name: string;
  /** false for an archived, draft or deleted item: still data, but not for sale. */
  active: boolean;
  variants: CatalogueVariant[];
}
