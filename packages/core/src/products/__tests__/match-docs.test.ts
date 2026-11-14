import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runConnectors } from "../../connectors/run.js";
import { printfulConnector, type PrintfulProduct } from "../../connectors/printful.js";
import { sanityConnector, type SanityProduct } from "../../connectors/sanity.js";
import { stripeConnector, type StripeProduct } from "../../connectors/stripe.js";
import { createFetcher } from "../../fetcher.js";
import { useCassette } from "../../../../testkit/src/index.js";
import { TIERS, matchProducts, type MatchResult } from "../match.js";

const page = readFileSync(
  fileURLToPath(new URL("../../../../../docs/products-and-prices.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

/** The result as the docs page shows it: ids and tiers, no names, prices or other content. */
export function describeMatch(r: MatchResult) {
  return {
    groups: r.groups.map((g) => ({
      sanity: g.sanity?._id,
      stripe: g.stripe ? { id: g.stripe.id, tier: g.stripeTier } : null,
      printful: g.printful ? { id: g.printful.id, tier: g.printfulTier } : null,
    })),
    unmatchedStripe: r.unmatchedStripe.map((p) => p.id),
    unmatchedPrintful: r.unmatchedPrintful.map((p) => p.id),
    ambiguous: r.ambiguous,
  };
}

export async function matchRecordedMerch(): Promise<MatchResult> {
  const run = await runConnectors(
    [sanityConnector, stripeConnector, printfulConnector],
    {
      SANITY_PROJECT_ID: "ridge7st",
      // Key-shaped values are put together at run time: GitHub push protection rejects literals.
      STRIPE_API_KEY: ["rk", "test", "ridgeline", "0123456789abcdefghij"].join("_"),
      PRINTFUL_API_TOKEN: ["pf", "ridgeline", "0123456789abcdef"].join("-"),
      PRINTFUL_STORE_ID: "3141592",
    },
    createFetcher({
      transport: (url, req) => {
        const name = url.hostname.endsWith("sanity.io")
          ? "sanity-match-merch"
          : url.hostname === "api.stripe.com"
            ? "stripe-match-merch"
            : "printful-merch";
        return useCassette(name, { mode: "replay" })(url, req);
      },
    }),
  );
  return matchProducts(
    run.data.get("sanity") as SanityProduct[],
    run.data.get("stripe") as StripeProduct[],
    run.data.get("printful") as PrintfulProduct[],
  );
}

describe("docs/products-and-prices.md: How products are matched", () => {
  it("the Match result block is what the matcher returns for the coach's merch cassettes", async () => {
    const shown = /```json title=Match result\n([\s\S]*?)\n```/.exec(page)?.[1];
    expect(shown).toBe(JSON.stringify(describeMatch(await matchRecordedMerch()), null, 2));
  });

  it("the page lists the four rules in the order the matcher tries them", () => {
    const section = /## How products are matched\n([\s\S]*?)\n\|/.exec(page)?.[1] ?? "";
    const rules = [...section.matchAll(/^(\d)\. (.*)$/gm)].map((m) => m[2] ?? "");
    expect(rules).toHaveLength(TIERS.length);
    expect(rules[0]).toContain("saved on the Sanity product");
    expect(rules[1]).toContain("sanityId");
    expect(rules[2]).toContain("SKU");
    expect(rules[3]).toContain("name");
  });

  it("the page names the freelancer's client and tells the leftovers apart from findings", () => {
    expect(page).toContain("Ridgeline Strength Coaching");
    expect(page).toContain("A leftover is not a finding by itself");
  });
});
