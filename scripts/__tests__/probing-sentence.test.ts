import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * docs/options.md says how many probing checks there are and names every one. The catalogue (docs/checks.data.json,
 * written by `pnpm gen:checks` from the registry) is the authority: a check is a probing check when its technical line
 * opens with "probing check". The sentence must name exactly those ids, once each, and spell the count.
 */
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function word(n: number): string {
  if (n < 20) return ONES[n] ?? String(n);
  const tens = TENS[Math.floor(n / 10)] ?? "";
  return n % 10 === 0 ? tens : `${tens}-${ONES[n % 10]}`;
}

const catalogue = JSON.parse(read("docs/checks.data.json")) as { id: string; tech: string }[];
const probing = catalogue
  .filter((c) => /^probing check\b/i.test(c.tech))
  .map((c) => c.id)
  .sort();

const options = read("docs/options.md");
const start = options.indexOf("There are ");
const sentence = options.slice(start, options.indexOf("\n\n", start));
const named = [...sentence.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g)].map((m) => m[1] ?? "");

describe("docs/options.md: the probing-check sentence", () => {
  it("is found, and the catalogue has probing checks", () => {
    expect(sentence).toMatch(/^There are [a-z-]+ probing checks:/);
    expect(probing.length).toBeGreaterThan(20);
  });

  it("names every probing check in the catalogue, once, and nothing else", () => {
    expect([...named].sort()).toEqual(probing);
  });

  it("spells the count the catalogue has", () => {
    expect(sentence).toMatch(new RegExp(`^There are ${word(probing.length)} probing checks:`));
  });

  it("spells how many of the last ones run from an adapter's reading as the number named after the first of them", () => {
    const first = named.indexOf("strapi-drafts-public");
    expect(first).toBeGreaterThan(-1);
    expect(sentence).toContain(
      `(the last\n${word(named.length - first)} run from an adapter's reading`,
    );
  });
});
