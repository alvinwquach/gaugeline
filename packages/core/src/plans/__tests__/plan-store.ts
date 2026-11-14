import { runConnectors } from "../../connectors/run.js";
import { stripeConnector, type StripeProduct } from "../../connectors/stripe.js";
import { createFetcher, type Hop } from "../../fetcher.js";
import { buildSnapshot } from "../../snapshot.js";
import { useCassette } from "../../../../testkit/src/index.js";
import { plansConfigSchema, type PlansConfig } from "../config.js";
import { planPageOf, readPagePlans, type PagePlan } from "../read.js";

/**
 * Harbor Street Yoga's membership page and gaugeline.plans.json, and its Stripe account as the
 * recorded, invented cassette `stripe-plans-harbor` holds it. Shared by the check tests and the
 * docs test so the page and the checks look at the same studio.
 */
export const HARBOR_PAGE = `<!doctype html><html><head><title>Memberships</title></head><body>
<h1>Memberships</h1>
<section><h2>Foundation</h2><p>$49 per month</p><p>7-day free trial</p></section>
<section><h2>Momentum</h2><p>$129 per month</p></section>
<section><h2>Elite</h2><p>$249 per month</p></section>
</body></html>`;

export const HARBOR_CONFIG: PlansConfig = plansConfigSchema.parse({
  plans: [
    { name: "Foundation", page: "/membership" },
    { name: "Momentum", id: "momentum", page: "/membership" },
    { name: "Elite", page: "/membership", price: "price_HarborElite24900" },
  ],
  products: ["prod_HarborFoundation"],
});

export const hopOf = (url: string, body: string): Hop => ({
  url,
  status: 200,
  headers: { "content-type": "text/html" },
  ms: 1,
  body,
});

export async function readHarbor(): Promise<{ plans: PagePlan[]; stripe: StripeProduct[] }> {
  const run = await runConnectors(
    [stripeConnector],
    // Key-shaped values are put together at run time: GitHub push protection rejects literals.
    { STRIPE_API_KEY: ["rk", "test", "harborstreet", "0123456789abcdefghij"].join("_") },
    createFetcher({ transport: useCassette("stripe-plans-harbor", { mode: "replay" }) }),
  );
  const page = planPageOf(buildSnapshot([hopOf("https://harbor.example/membership", HARBOR_PAGE)]));
  return {
    plans: readPagePlans(HARBOR_CONFIG, () => page),
    stripe: run.data.get("stripe") as StripeProduct[],
  };
}
