/**
 * The field floor (X71). The words are written out here, not read from the module, so removing a word from
 * the module fails a test (a test that iterated the module's own list would shrink with it).
 */
import { describe, expect, it } from "vitest";
import { isAllowedField, isDeniedField } from "../sanity/fields.js";

const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1);

const WORDS = [
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
];
// A name written as one word is caught by these (the whole-word rule cannot see inside it).
const INSIDE: [string, string][] = [
  ["price", "unitprice"],
  ["currency", "billingcurrencycode"],
  ["discount", "memberdiscountcode"],
  ["payment", "paymentlink"],
  ["password", "adminpasswordhint"],
  ["secret", "mysecretnote"],
  ["apikey", "myapikeyvalue"],
];

describe("every denied word is refused as a word of the name", () => {
  for (const w of WORDS)
    it(w, () => {
      for (const name of [
        w,
        cap(w),
        `menu_${w}`,
        `menu${cap(w)}`,
        `${w}_from`,
        `${w}From`,
        w.toUpperCase(),
      ])
        expect(isDeniedField(name), name).toBe(true);
    });
});

describe("every denied substring is refused inside a name written as one word", () => {
  for (const [w, name] of INSIDE)
    it(`${w}: ${name}`, () => {
      expect(isDeniedField(name)).toBe(true);
      expect(isDeniedField(name.toUpperCase())).toBe(true);
    });
});

describe("names that only contain the letters are not refused", () => {
  for (const name of [
    "description",
    "operatingHours",
    "tagline",
    "rating",
    "heading",
    "hours",
    "phone",
    "title",
    "costume",
    "tokenizer",
  ])
    it(name, () => {
      // costume and tokenizer are one word each: the whole-word rule does not read them as cost or token.
      expect(isDeniedField(name), name).toBe(false);
    });
});

describe("the fence", () => {
  it("is the exact <type>.<field> entry and the floor together", () => {
    expect(isAllowedField("page", "hours", ["page.hours"])).toBe(true);
    expect(isAllowedField("page", "hours", ["post.hours"])).toBe(false);
    expect(isAllowedField("page", "hours", [])).toBe(false);
    expect(isAllowedField("page", "price", ["page.price"])).toBe(false);
  });
});
