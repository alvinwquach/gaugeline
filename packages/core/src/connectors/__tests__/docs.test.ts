import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFetcher } from "../../fetcher.js";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { connectorGet } from "../http.js";
import { runConnectors } from "../run.js";
import { fake, testKey } from "./fake.js";

const page = readFileSync(
  fileURLToPath(new URL("../../../../../docs/products-and-prices.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const servers: FixtureServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

describe("docs/products-and-prices.md: the pop-up kitchen example", () => {
  it("the Notices block is what runConnectors returns for Sanity set, a refused Stripe key and no Printful token", async () => {
    const stripeKey = testKey("ember");
    const stripe = await startServer({
      "/v1/products": (req, res) =>
        void res
          .writeHead(401, { "content-type": "application/json" })
          .end(JSON.stringify({ error: `No such API key: ${req.headers.authorization}` })),
    });
    servers.push(stripe);
    const env = {
      SANITY_PROJECT_ID: "emberkitchen",
      SANITY_DATASET: "production",
      SANITY_TOKEN: testKey("sanity"),
      STRIPE_API_KEY: stripeKey,
      PRINTFUL_STORE_ID: "1234567",
    };
    const run = await runConnectors(
      [
        fake("sanity", ["SANITY_PROJECT_ID", "SANITY_DATASET", "SANITY_TOKEN"], async () => [
          { id: "tasting-box", price: 4500 },
        ]),
        fake("stripe", ["STRIPE_API_KEY"], async (e, f) => [
          await connectorGet(f, `${stripe.origin}/v1/products`, {
            authorization: `Bearer ${e.STRIPE_API_KEY}`,
          }),
        ]),
        fake("printful", ["PRINTFUL_API_TOKEN", "PRINTFUL_STORE_ID"], async () => []),
      ],
      env,
      createFetcher({ allowPrivate: true }),
    );
    expect([...run.data.keys()]).toEqual(["sanity"]);
    const shown = /```json title=Notices\n([\s\S]*?)\n```/.exec(page)?.[1];
    expect(shown).toBe(JSON.stringify(run.notices, null, 2));
    expect(JSON.stringify(run.notices)).not.toContain(stripeKey);
  });
});
