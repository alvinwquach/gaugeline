import { describe, expect, it } from "vitest";
import { runConnectors } from "../run.js";
import {
  SQUARE_ENV_VARS,
  SQUARE_MAX_PAGES,
  createSquareConnector,
  mapSquareItem,
  mapSquareVariation,
  squareConnector,
  squarePrice,
} from "../square.js";
import { fake } from "./fake.js";
import { lowerHeaders, recorded, serving, type Seen } from "./serve.js";

// Key-shaped values are put together at run time: GitHub push protection rejects literals.
const TOKEN = ["EAAA", "ridgelinestudio0123456789abcdefghij"].join("");
const ENV = { SQUARE_ACCESS_TOKEN: TOKEN };
const LIST = "https://connect.squareup.com/v2/catalog/list";

const noSleep = () => Promise.resolve();

const variation = (id: string, data: Record<string, unknown>) => ({
  type: "ITEM_VARIATION",
  id,
  item_variation_data: { item_id: "ITEM1", pricing_type: "FIXED_PRICING", ...data },
});
const item = (
  id: string,
  name: string,
  variations: unknown[],
  extra: Record<string, unknown> = {},
) => ({
  type: "ITEM",
  id,
  item_data: { name, variations },
  ...extra,
});

describe("squarePrice: unit", () => {
  it("a fixed price is whole minor units, zero is zero, and the currency comes with it", () => {
    expect(
      squarePrice({
        pricing_type: "FIXED_PRICING",
        price_money: { amount: 5400, currency: "USD" },
      }),
    ).toEqual({
      price: 5400,
      currency: "USD",
    });
    expect(squarePrice({ price_money: { amount: 0, currency: "USD" } })).toEqual({
      price: 0,
      currency: "USD",
    });
  });

  it("variable pricing has no price, even if an amount is present", () => {
    expect(
      squarePrice({
        pricing_type: "VARIABLE_PRICING",
        price_money: { amount: 100, currency: "USD" },
      }),
    ).toEqual({ price: null, currency: "USD" });
    expect(squarePrice({ pricing_type: "VARIABLE_PRICING" })).toEqual({
      price: null,
      currency: "",
    });
  });

  it("a missing, negative, fractional, text or unsafe amount is null, never a guess", () => {
    for (const amount of [undefined, null, -1, 1.5, "100", Number.MAX_SAFE_INTEGER + 2, NaN])
      expect(
        squarePrice({ price_money: { amount, currency: "USD" } }).price,
        String(amount),
      ).toBeNull();
    expect(squarePrice({}).price).toBeNull();
    expect(squarePrice(undefined).price).toBeNull();
  });
});

describe("mapping to catalogue items: unit", () => {
  it("a variation keeps id, sku, price, currency and a null availability, and nothing else", () => {
    const v = mapSquareVariation(
      variation("V1", {
        name: "Large",
        sku: "RL-HOOD-L",
        price_money: { amount: 5850, currency: "USD" },
        track_inventory: true,
        ordinal: 3,
      }),
    );
    expect(v).toEqual({
      id: "V1",
      sku: "RL-HOOD-L",
      price: 5850,
      currency: "USD",
      available: null,
    });
    expect(Object.keys(v).sort()).toEqual(["available", "currency", "id", "price", "sku"]);
  });

  it("a missing or empty sku is left out, not an empty string", () => {
    for (const sku of [undefined, "", "  ", null, 7]) {
      const v = mapSquareVariation(
        variation("V", { sku, price_money: { amount: 1, currency: "USD" } }),
      );
      expect(Object.keys(v), String(sku)).not.toContain("sku");
    }
  });

  it("a variation with no id is refused", () => {
    expect(() => mapSquareVariation({ item_variation_data: {} })).toThrow(/no id/);
    expect(() => mapSquareVariation("v")).toThrow(/no id/);
  });

  it("an item keeps source, id, name, active and its variations; deleted and archived are not active", () => {
    const base = item("I1", "Training hoodie", [
      variation("V1", { price_money: { amount: 5400, currency: "USD" } }),
    ]);
    expect(mapSquareItem(base)).toEqual({
      source: "square",
      id: "I1",
      name: "Training hoodie",
      active: true,
      variants: [{ id: "V1", price: 5400, currency: "USD", available: null }],
    });
    expect(mapSquareItem({ ...base, is_deleted: true })?.active).toBe(false);
    expect(
      mapSquareItem({ ...base, item_data: { ...base.item_data, is_archived: true } })?.active,
    ).toBe(false);
  });

  it("an item with no variations has an empty list; an object that is not an item is skipped; one with no id is refused", () => {
    expect(mapSquareItem(item("I2", "Poster", []))?.variants).toEqual([]);
    expect(
      mapSquareItem({ type: "ITEM", id: "I3", item_data: { name: "Bare" } })?.variants,
    ).toEqual([]);
    expect(
      mapSquareItem({ type: "CATEGORY", id: "C1", category_data: { name: "Merch" } }),
    ).toBeUndefined();
    expect(() => mapSquareItem({ type: "ITEM", item_data: { name: "No id" } })).toThrow(/no id/);
  });

  it("keeps no description, images or location data", () => {
    const mapped = mapSquareItem(
      item("I4", "Mug", [], {
        present_at_all_locations: true,
        item_data: { name: "Mug", description_html: "<p>secret recipe</p>", image_ids: ["x"] },
      }),
    );
    expect(Object.keys(mapped ?? {}).sort()).toEqual([
      "active",
      "id",
      "name",
      "source",
      "variants",
    ]);
  });
});

describe("configured: unit", () => {
  it("needs the token and nothing else, and the token is the key", () => {
    expect(squareConnector.id).toBe("square");
    expect(squareConnector.envVars).toEqual([...SQUARE_ENV_VARS]);
    expect(squareConnector.secretEnvVars).toEqual(["SQUARE_ACCESS_TOKEN"]);
    expect(squareConnector.configured(ENV)).toBe(true);
    expect(squareConnector.configured({})).toBe(false);
    expect(squareConnector.configured({ SQUARE_ACCESS_TOKEN: "" })).toBe(false);
  });
});

describe("integration: recorded responses", () => {
  it("the coach's studio counter: two pages of the catalogue become four items, in order", async () => {
    const seen: Seen[] = [];
    const items = await squareConnector.read(ENV, recorded("square-shop", seen));
    expect(items.map((i) => [i.id, i.name, i.active, i.variants.length])).toEqual([
      ["SQHOODIE0000000000000001", "Training hoodie", true, 3],
      ["SQPASS00000000000000001", "Month pass", true, 1],
      ["SQINTRO0000000000000001", "Intro session", true, 1],
      ["SQWINTER000000000000001", "Winter challenge", false, 1],
    ]);
    expect(items[0]?.variants.map((v) => [v.sku, v.price, v.currency, v.available])).toEqual([
      ["RL-HOOD-S", 5400, "USD", null],
      ["RL-HOOD-M", 5400, "USD", null],
      ["RL-HOOD-L", 5850, "USD", null],
    ]);
    expect(items.every((i) => i.source === "square")).toBe(true);
    expect(seen.map((s) => new URL(s.url).search)).toEqual([
      "?types=ITEM",
      "?types=ITEM&cursor=SQcursorPage2Ridgeline0001",
    ]);
  });

  it("a price of zero stays 0 (a free intro session is a price, not a missing one)", async () => {
    const items = await squareConnector.read(ENV, recorded("square-shop"));
    expect(items.find((i) => i.name === "Intro session")?.variants[0]?.price).toBe(0);
  });

  it("a product with forty variations comes back whole", async () => {
    const items = await squareConnector.read(ENV, recorded("square-large"));
    expect(items).toHaveLength(1);
    const kit = items[0];
    expect(kit?.variants).toHaveLength(40);
    expect(kit?.variants.map((v) => v.sku)).toEqual(
      Array.from({ length: 40 }, (_, i) => `RL-KIT-${String(i + 1).padStart(2, "0")}`),
    );
    expect(kit?.variants[0]?.price).toBe(2000);
    expect(kit?.variants[39]?.price).toBe(3950);
    expect(new Set(kit?.variants.map((v) => v.id)).size).toBe(40);
  });

  it("every request is a GET to the catalogue list; the token is in a header, never in an address", async () => {
    const seen: Seen[] = [];
    await squareConnector.read(ENV, recorded("square-shop", seen));
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      const u = new URL(s.url);
      expect(s.method).toBe("GET");
      expect(`${u.origin}${u.pathname}`).toBe(LIST);
      expect(lowerHeaders(s.headers).authorization).toBe(`Bearer ${TOKEN}`);
      expect(s.url).not.toContain(TOKEN);
      expect(u.searchParams.get("types")).toBe("ITEM");
    }
  });

  it("a cursor with characters that need escaping travels escaped", async () => {
    const seen: Seen[] = [];
    await squareConnector.read(
      ENV,
      serving(
        (url) =>
          url.searchParams.has("cursor")
            ? { status: 200, body: { objects: [] } }
            : { status: 200, body: { objects: [item("I1", "A", [])], cursor: "a+b/c=d&e" } },
        seen,
      ),
    );
    expect(seen).toHaveLength(2);
    expect(new URL(seen[1]?.url ?? "").searchParams.get("cursor")).toBe("a+b/c=d&e");
    expect(seen[1]?.url).toContain("cursor=a%2Bb%2Fc%3Dd%26e");
  });
});

describe("errors: integration", () => {
  it("401: one notice that names the token, and the other systems are still returned", async () => {
    const seen: Seen[] = [];
    const run = await runConnectors(
      [fake("sanity", ["SANITY_PROJECT_ID"], async () => [{ id: "menu" }]), squareConnector],
      { ...ENV, SANITY_PROJECT_ID: "ember" },
      serving(
        () => ({
          status: 401,
          body: { errors: [{ category: "AUTHENTICATION_ERROR", detail: `bad ${TOKEN}` }] },
        }),
        seen,
      ),
    );
    expect(run.data.get("sanity")).toHaveLength(1);
    expect(run.data.has("square")).toBe(false);
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]?.kind).toBe("refused");
    expect(run.notices[0]?.message).toMatch(/SQUARE_ACCESS_TOKEN/);
    expect(run.notices[0]?.message).toMatch(/401/);
    expect(JSON.stringify(run)).not.toContain(TOKEN);
    expect(seen).toHaveLength(1);
  });

  it("403: the notice says the token needs ITEMS_READ", async () => {
    const run = await runConnectors(
      [squareConnector],
      ENV,
      serving(() => ({ status: 403 })),
    );
    expect(run.notices[0]?.kind).toBe("refused");
    expect(run.notices[0]?.message).toMatch(/ITEMS_READ/);
  });

  it("429 with Retry-After: waits once, then succeeds; a second 429 says when to try again", async () => {
    const waits: number[] = [];
    let limited = false;
    const connector = createSquareConnector({
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    const ok = await connector.read(
      ENV,
      serving(() => {
        if (!limited) {
          limited = true;
          return { status: 429, headers: { "retry-after": "1" } };
        }
        return { status: 200, body: { objects: [] } };
      }),
    );
    expect(ok).toEqual([]);
    expect(waits).toEqual([1000]);

    const run = await runConnectors(
      [createSquareConnector({ sleep: noSleep })],
      ENV,
      serving(() => ({ status: 429, headers: { "retry-after": "30" } })),
    );
    expect(run.notices[0]?.kind).toBe("unreachable");
    expect(run.notices[0]?.message).toContain("in 30 seconds");
  });

  it("an answer that is not JSON or not a catalogue is unreachable, with the token blanked", async () => {
    for (const body of ["<html>down</html>", "[1,2]", { objects: "x" }]) {
      const run = await runConnectors(
        [squareConnector],
        ENV,
        serving(() => ({ status: 200, body })),
      );
      expect(run.notices[0]?.kind, JSON.stringify(body)).toBe("unreachable");
      expect(JSON.stringify(run)).not.toContain(TOKEN);
    }
  });
});

describe("paging: edge cases", () => {
  it("an empty catalogue (no objects key at all) is an empty list", async () => {
    expect(
      await squareConnector.read(
        ENV,
        serving(() => ({ status: 200, body: {} })),
      ),
    ).toEqual([]);
  });

  it("the same cursor twice stops the read with a note", async () => {
    const notes: string[] = [];
    const seen: Seen[] = [];
    const items = await squareConnector.read(
      ENV,
      serving(
        () => ({ status: 200, body: { objects: [item("I1", "A", [])], cursor: "SAME" } }),
        seen,
      ),
      (m) => notes.push(m),
    );
    // The second answer repeats the cursor just sent: its rows are kept (once), and the read stops.
    expect(items.map((i) => i.id)).toEqual(["I1"]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/same page/);
    expect(seen).toHaveLength(2);
  });

  it("past the page cap the run keeps what it read and one note says so", async () => {
    const notes: string[] = [];
    const seen: Seen[] = [];
    let n = 0;
    const items = await squareConnector.read(
      ENV,
      serving(() => {
        n++;
        return {
          status: 200,
          body: { objects: [item(`I${n}`, `Item ${n}`, [])], cursor: `C${n}` },
        };
      }, seen),
      (m) => notes.push(m),
    );
    expect(seen).toHaveLength(SQUARE_MAX_PAGES);
    expect(items).toHaveLength(SQUARE_MAX_PAGES);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(new RegExp(`${SQUARE_MAX_PAGES} pages`));
  });

  it("an object that is not an item (a category on the list) is skipped, not an error", async () => {
    const items = await squareConnector.read(
      ENV,
      serving(() => ({
        status: 200,
        body: { objects: [{ type: "CATEGORY", id: "C1" }, item("I1", "Mug", [])] },
      })),
    );
    expect(items.map((i) => i.id)).toEqual(["I1"]);
  });
});

describe("keys and the runner: promise tests", () => {
  it("no token: zero requests and a not-configured notice that names the variable, never a pass", async () => {
    const seen: Seen[] = [];
    const run = await runConnectors(
      [squareConnector],
      {},
      serving(() => ({ status: 200 }), seen),
    );
    expect(seen).toHaveLength(0);
    expect(run.data.has("square")).toBe(false);
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]?.kind).toBe("not-configured");
    expect(run.notices[0]?.message).toContain("SQUARE_ACCESS_TOKEN");
  });

  it("an empty token is the same as none", async () => {
    const seen: Seen[] = [];
    const run = await runConnectors(
      [squareConnector],
      { SQUARE_ACCESS_TOKEN: "" },
      serving(() => ({ status: 200 }), seen),
    );
    expect(seen).toHaveLength(0);
    expect(run.notices[0]?.kind).toBe("not-configured");
  });

  it("an error body that echoes the token reaches no notice", async () => {
    const run = await runConnectors(
      [squareConnector],
      ENV,
      serving(() => ({ status: 500, body: `boom ${TOKEN}` })),
    );
    expect(run.notices[0]?.kind).toBe("unreachable");
    expect(JSON.stringify(run)).not.toContain(TOKEN);
  });
});
