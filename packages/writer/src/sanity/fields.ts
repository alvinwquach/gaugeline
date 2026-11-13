/**
 * Which fields a Sanity draft may change (ADR-0010, X71), in the same two layers as the file writer's paths:
 * a deny-list that applies whatever the customer configures (a floor), and `allowedFields` in the worker's
 * configuration for the site (the fence). The fence is required here: with none listed, every field is refused.
 *
 * The floor refuses money, links' addresses and secrets: "it never proposes a price change: prices are
 * flagged for a person" (the row's own rule). A name is read as words (`priceFrom`, `ticket_price` are
 * `price from` and `ticket price`); the words below are refused as whole words, and the longer ones also
 * inside a longer name (`unitprice`). It is a deny-list, not a boundary: any field that holds a price under a
 * name this list does not know is the customer's to leave out of `allowedFields`.
 */

/** Refused as a whole word of the field's name. */
const DENIED_WORDS: ReadonlySet<string> = new Set([
  "price",
  "prices",
  "pricing",
  "cost",
  "costs",
  "fee",
  "fees",
  "amount",
  "amounts",
  "currency",
  "discount",
  "discounts",
  "tariff",
  "tariffs",
  "charge",
  "charges",
  "deposit",
  "payment",
  "payments",
  "salary",
  "wage",
  "wages",
  "total",
  "slug",
  "password",
  "secret",
  "token",
]);

/** Refused anywhere in the lower-cased name, so a name written as one word is caught too. */
const DENIED_INSIDE = ["price", "currency", "discount", "payment", "password", "secret", "apikey"];

/** The words of a field name: camelCase and snake_case split, lower-cased. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
}

/** True when the field is one the writer never changes, whatever `allowedFields` says. */
export function isDeniedField(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    words(name).some((w) => DENIED_WORDS.has(w)) || DENIED_INSIDE.some((w) => lower.includes(w))
  );
}

/** An entry of `allowedFields`: `<document type>.<field>`, both plain names, nothing else (no wildcard). */
const ENTRY = /^[A-Za-z][A-Za-z0-9_]{0,63}\.[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function isAllowedFieldsList(list: unknown): list is readonly string[] {
  return (
    Array.isArray(list) &&
    list.length <= 200 &&
    list.every((e) => typeof e === "string" && ENTRY.test(e))
  );
}

/** True when `documentType.field` is listed (exact, case-sensitive) and the field is not on the floor. */
export function isAllowedField(
  documentType: string,
  field: string,
  allowed: readonly string[],
): boolean {
  return allowed.includes(`${documentType}.${field}`) && !isDeniedField(field);
}
