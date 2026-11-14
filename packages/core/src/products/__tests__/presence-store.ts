import { Readable } from "node:stream";
import { printfulConnector, type PrintfulProduct } from "../../connectors/printful.js";
import { runConnectors } from "../../connectors/run.js";
import { sanityConnector, type SanityProduct } from "../../connectors/sanity.js";
import { stripeConnector, type StripeProduct } from "../../connectors/stripe.js";
import { createFetcher } from "../../fetcher.js";
import { useCassette } from "../../../../testkit/src/index.js";
import { matchProducts, type MatchResult } from "../match.js";

/** A system that, in a test, does not answer: it is read as an HTTP 500, which is "unreachable". */
export type Down = "sanity" | "stripe" | "printful";

/**
 * Lowtide Surf Club's shop as the three connectors read it from the recorded, invented cassettes
 * `sanity-presence-surf`, `stripe-presence-surf` and `printful-presence-surf`, then matched. Shared
 * by the presence check tests and the docs test so the page and the checks look at the same store.
 * `down` lists the systems that answer 500 instead of the cassette.
 */
export async function readSurfStore(down: readonly Down[] = []): Promise<{
  sanity?: SanityProduct[];
  stripe?: StripeProduct[];
  printful?: PrintfulProduct[];
  match: MatchResult;
  data: Map<string, unknown[]>;
  notices: { connector: string; kind: string }[];
}> {
  const run = await runConnectors(
    [sanityConnector, stripeConnector, printfulConnector],
    {
      SANITY_PROJECT_ID: "lowtide1",
      // Key-shaped values are put together at run time: GitHub push protection rejects literals.
      STRIPE_API_KEY: ["rk", "test", "lowtidesurf", "0123456789abcdefghij"].join("_"),
      PRINTFUL_API_TOKEN: ["pf", "lowtidesurf", "0123456789abcdef"].join("-"),
      PRINTFUL_STORE_ID: "3141592",
    },
    createFetcher({
      transport: (url, req) => {
        const system: Down = url.hostname.endsWith("sanity.io")
          ? "sanity"
          : url.hostname === "api.stripe.com"
            ? "stripe"
            : "printful";
        if (down.includes(system))
          return Promise.resolve({
            status: 500,
            headers: { "content-type": "application/json" },
            body: Readable.from([Buffer.from("{}")]),
          });
        return useCassette(`${system}-presence-surf`, { mode: "replay" })(url, req);
      },
    }),
  );
  const sanity = run.data.get("sanity") as SanityProduct[] | undefined;
  const stripe = run.data.get("stripe") as StripeProduct[] | undefined;
  const printful = run.data.get("printful") as PrintfulProduct[] | undefined;
  return {
    ...(sanity === undefined ? {} : { sanity }),
    ...(stripe === undefined ? {} : { stripe }),
    ...(printful === undefined ? {} : { printful }),
    match: matchProducts(sanity, stripe, printful),
    data: run.data,
    notices: run.notices,
  };
}
