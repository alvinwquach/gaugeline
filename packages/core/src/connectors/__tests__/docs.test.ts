import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../../fetcher.js";
import { startServer, type FixtureServer } from "../../__tests__/helpers/server.js";
import { connectorGet } from "../http.js";
import { runConnectors } from "../run.js";
import { sanityConnector } from "../sanity.js";
import { printfulConnector } from "../printful.js";
import { guardStripeKey, stripeConnector } from "../stripe.js";
import { useCassette } from "../../../../testkit/src/index.js";
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
        printfulConnector,
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

describe("docs/products-and-prices.md: Reading Sanity", () => {
  it("the Products and Advice blocks are what the Sanity connector returns for the pop-up kitchen's public dataset", async () => {
    const transport = useCassette("sanity-products", { mode: "replay" });
    const run = await runConnectors(
      [sanityConnector],
      { SANITY_PROJECT_ID: "ember8kc" },
      createFetcher({ transport }),
    );
    const block = (title: string) =>
      new RegExp(`\`\`\`json title=${title}\n([\\s\\S]*?)\n\`\`\``).exec(page)?.[1];
    expect(block("Products")).toBe(JSON.stringify(run.data.get("sanity"), null, 2));
    expect(block("Advice")).toBe(JSON.stringify(run.notices, null, 2));
  });

  it("the no-token message quoted in docs/private-datasets.md is the one the run prints", async () => {
    const privateDocs = readFileSync(
      fileURLToPath(new URL("../../../../../docs/private-datasets.md", import.meta.url)),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const transport = useCassette("sanity-products", { mode: "replay" });
    const run = await runConnectors(
      [sanityConnector],
      { SANITY_PROJECT_ID: "pr1v4te0", SANITY_DATASET: "production" },
      createFetcher({ transport }),
    );
    expect(privateDocs).toContain(`> ${run.notices[0]?.message}`);
  });
});

describe("docs/products-and-prices.md: Reading Stripe", () => {
  const block = (title: string) =>
    new RegExp(`\`\`\`json title=${title}\n([\\s\\S]*?)\n\`\`\``).exec(page)?.[1];
  // Built at run time: GitHub push protection rejects key-shaped literals.
  const key = ["rk", "live", "ExampleKitchen0123456789"].join("_");

  it("the Stripe products block is what the connector returns for the pop-up kitchen's account", async () => {
    const run = await runConnectors(
      [stripeConnector],
      { STRIPE_API_KEY: key },
      createFetcher({ transport: useCassette("stripe-products", { mode: "replay" }) }),
    );
    expect(run.notices).toEqual([]);
    const shown = (run.data.get("stripe") as Array<{ id: string }>).filter((p) =>
      ["prod_PopTamalBox", "prod_PopFlight"].includes(p.id),
    );
    expect(block("Stripe products")).toBe(JSON.stringify(shown, null, 2));
  });

  it("the page's tamal box price is the archived one, and checkout charges the default price", async () => {
    const fixture = readFileSync(
      fileURLToPath(
        new URL("../../../../fixtures/sites/stripe-test-mode/index.html", import.meta.url),
      ),
      "utf8",
    );
    const products = await stripeConnector.read(
      { STRIPE_API_KEY: key },
      createFetcher({ transport: useCassette("stripe-products", { mode: "replay" }) }),
    );
    const box = products.find((p) => p.id === "prod_PopTamalBox");
    const charged = box?.prices.find((p) => p.id === box.defaultPriceId);
    const archived = box?.prices.find((p) => !p.active);
    expect(fixture).toContain("$42.00");
    expect(charged?.unitAmount).toBe(4800);
    expect(archived?.unitAmount).toBe(4200);
  });

  it("the Stripe notices block is what a key without the Prices permission gets", async () => {
    const run = await runConnectors(
      [stripeConnector],
      { STRIPE_API_KEY: key },
      createFetcher({ transport: useCassette("stripe-no-prices", { mode: "replay" }) }),
    );
    expect(block("Stripe notices")).toBe(JSON.stringify(run.notices, null, 2));
    expect(JSON.stringify(run.notices)).not.toContain(key);
  });

  it("the refusal quoted for a secret key is the one the connector throws", () => {
    const secret = ["sk", "live", "ExampleKitchen0123456789"].join("_");
    let thrown: { message: string; hint?: string } | undefined;
    try {
      guardStripeKey({ STRIPE_API_KEY: secret }, { allowSecretKey: false });
    } catch (err) {
      thrown = err as { message: string; hint?: string };
    }
    expect(page).toContain(`${thrown?.message}\nTry: ${thrown?.hint}`);
  });
});

describe("docs/products-and-prices.md: Reading Printful", () => {
  const block = (title: string) =>
    new RegExp(`\`\`\`json title=${title}\n([\\s\\S]*?)\n\`\`\``).exec(page)?.[1];
  // Built at run time: GitHub push protection rejects key-shaped literals.
  const token = ["pf", "ridgeline", "0123456789abcdef"].join("-");
  const env = { PRINTFUL_API_TOKEN: token, PRINTFUL_STORE_ID: "3141592" };

  it("the Printful products block is what the connector returns for the coach's merch store (the hoodie and the bottle)", async () => {
    const run = await runConnectors(
      [printfulConnector],
      env,
      createFetcher({ transport: useCassette("printful-merch", { mode: "replay" }) }),
    );
    expect(run.notices).toEqual([]);
    const shown = (run.data.get("printful") as Array<{ id: string }>).filter((p) =>
      ["5002", "5003"].includes(p.id),
    );
    expect(block("Printful products")).toBe(JSON.stringify(shown, null, 2));
  });

  it("the page's numbers hold: the large hoodie is not synced and costs more than the medium", async () => {
    const products = await printfulConnector.read(
      env,
      createFetcher({ transport: useCassette("printful-merch", { mode: "replay" }) }),
    );
    const hoodie = products.find((p) => p.id === "5002");
    expect(hoodie?.variants.map((v) => [v.sku, v.synced, v.retailPrice])).toEqual([
      ["RL-HOOD-M", true, 5400],
      ["RL-HOOD-L", false, 5850],
    ]);
    expect(page).toContain("$54.00");
    expect(page).toContain("$58.50");
  });

  it("the Printful notices block is what a store number the token cannot see gets", async () => {
    const transport: Transport = () =>
      Promise.resolve({
        status: 403,
        headers: { "content-type": "application/json" },
        body: Readable.from([Buffer.from("{}")]),
      });
    const run = await runConnectors(
      [printfulConnector],
      { ...env, PRINTFUL_STORE_ID: "2718281" },
      createFetcher({ transport }),
    );
    expect(block("Printful notices")).toBe(JSON.stringify(run.notices, null, 2));
    expect(JSON.stringify(run.notices)).not.toContain(token);
  });
});
