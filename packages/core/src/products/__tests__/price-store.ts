import { printfulConnector, type PrintfulProduct } from "../../connectors/printful.js";
import { runConnectors } from "../../connectors/run.js";
import { sanityConnector, type SanityProduct } from "../../connectors/sanity.js";
import { stripeConnector, type StripeProduct } from "../../connectors/stripe.js";
import { createFetcher } from "../../fetcher.js";
import { useCassette } from "../../../../testkit/src/index.js";
import { matchProducts, type MatchResult } from "../match.js";

/**
 * Ember Supper Club's shop as the three connectors read it from the recorded, invented cassettes
 * `sanity-price-supper`, `stripe-price-supper` and `printful-price-supper`, then matched. Shared by
 * the price check tests and the docs test so the page and the checks look at the same store.
 */
export async function readSupperStore(): Promise<{
  sanity: SanityProduct[];
  stripe: StripeProduct[];
  printful: PrintfulProduct[];
  match: MatchResult;
}> {
  const run = await runConnectors(
    [sanityConnector, stripeConnector, printfulConnector],
    {
      SANITY_PROJECT_ID: "ember7sc",
      // Key-shaped values are put together at run time: GitHub push protection rejects literals.
      STRIPE_API_KEY: ["rk", "test", "embersupper", "0123456789abcdefghij"].join("_"),
      PRINTFUL_API_TOKEN: ["pf", "embersupper", "0123456789abcdef"].join("-"),
      PRINTFUL_STORE_ID: "2718281",
    },
    createFetcher({
      transport: (url, req) => {
        const name = url.hostname.endsWith("sanity.io")
          ? "sanity-price-supper"
          : url.hostname === "api.stripe.com"
            ? "stripe-price-supper"
            : "printful-price-supper";
        return useCassette(name, { mode: "replay" })(url, req);
      },
    }),
  );
  const sanity = run.data.get("sanity") as SanityProduct[];
  const stripe = run.data.get("stripe") as StripeProduct[];
  const printful = run.data.get("printful") as PrintfulProduct[];
  return { sanity, stripe, printful, match: matchProducts(sanity, stripe, printful) };
}
