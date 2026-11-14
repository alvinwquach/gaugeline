import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { useCassette } from "../../../../testkit/src/index.js";
import { createFetcher, type Fetcher, type Transport } from "../../fetcher.js";
import { ConnectorRateLimitedError, ConnectorRefusedError } from "../http.js";
import { runConnectors } from "../run.js";
import {
  DEFAULT_PRODUCTS_QUERY,
  fieldQuery,
  readField,
  SANITY_ENV_VARS,
  parseProducts,
  productsUrl,
  sanityConnector,
  typeCounts,
} from "../sanity.js";
import type { Env } from "../types.js";
import { fake, testKey } from "./fake.js";

const TOKEN = testKey("sanity");

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** A fetcher that answers from the recorded Sanity cassette and logs every request it receives. */
function recorded(seen: Seen[] = []): Fetcher {
  const replay = useCassette("sanity-products", { mode: "replay" });
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href, headers: req.headers });
    return replay(url, req);
  };
  return createFetcher({ transport, timeoutMs: 5000 });
}

/** A fetcher whose network is one function: for answers too big or too odd to record. */
function serving(
  answer: (url: URL, headers: Record<string, string>) => { status: number; body: string },
  seen: Seen[] = [],
  maxBodyBytes?: number,
): Fetcher {
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href, headers: req.headers });
    const { status, body } = answer(url, req.headers);
    return Promise.resolve({
      status,
      headers: { "content-type": "application/json" },
      body: Readable.from([Buffer.from(body, "utf8")]),
    });
  };
  return createFetcher({ transport, timeoutMs: 5000, ...(maxBodyBytes ? { maxBodyBytes } : {}) });
}

const PUBLIC: Env = { SANITY_PROJECT_ID: "ember8kc", SANITY_DATASET: "production" };
const custom = (fields: string): string => `*[_type == "menuItem"]{${fields}}`;

describe("price conversion: unit", () => {
  const rows = (price: unknown) => [{ _id: "a", name: "A", price }];

  it('48 becomes 4800 and "48.00" becomes 4800', () => {
    expect(parseProducts(rows(48), "major")[0]?.price).toBe(4800);
    expect(parseProducts(rows("48.00"), "major")[0]?.price).toBe(4800);
  });

  it("48 with GAUGELINE_SANITY_PRICE_UNIT=cents stays 48", () => {
    expect(parseProducts(rows(48), "cents")[0]?.price).toBe(48);
    expect(parseProducts(rows("4800"), "cents")[0]?.price).toBe(4800);
  });

  it("a price that is not a plain amount is null, not a guess", () => {
    for (const bad of ["free", "48.123", -5, "", {}, [], true])
      expect(parseProducts(rows(bad), "major")[0]?.price).toBeNull();
    expect(parseProducts(rows(4.5), "cents")[0]?.price).toBeNull();
    expect(parseProducts(rows(-1), "cents")[0]?.price).toBeNull();
  });

  it("price 19.99 becomes 1999, never 1998", () => {
    expect(parseProducts(rows(19.99), "major")[0]?.price).toBe(1999);
  });
});

describe("shape validation: unit", () => {
  it("a custom query missing sku is accepted: the three links are optional", () => {
    const got = parseProducts([{ _id: "a", name: "A", price: 5 }], "major");
    expect(got).toEqual([{ _id: "a", name: "A", price: 500 }]);
  });

  it("missing _id is refused with the field named and how many rows lack it", () => {
    expect(() => parseProducts([{ _id: "a", name: "A" }, { name: "B" }], "major")).toThrow(
      /"_id".*1 of 2 rows/,
    );
  });

  it("missing name is refused with the field named", () => {
    expect(() => parseProducts([{ _id: "a" }], "major")).toThrow(/"name".*1 of 1 rows/);
  });

  it("something other than a list is refused and shows the shape expected", () => {
    expect(() => parseProducts({ _id: "a" }, "major")).toThrow(/did not return a list/);
    expect(() => parseProducts(null, "major")).toThrow(/did not return a list/);
  });

  it("links keep only text: a null is left out and a number becomes its digits", () => {
    const got = parseProducts(
      [{ _id: "a", name: "A", price: 1, sku: 1001, stripeId: null, printfulId: "" }],
      "major",
    );
    expect(got[0]).toEqual({ _id: "a", name: "A", price: 100, sku: "1001" });
  });

  it("an empty list is no products, not an error", () => {
    expect(parseProducts([], "major")).toEqual([]);
  });
});

describe("configured: unit", () => {
  it("needs only SANITY_PROJECT_ID", () => {
    expect(sanityConnector.configured({ SANITY_PROJECT_ID: "ember8kc" })).toBe(true);
    expect(sanityConnector.configured({})).toBe(false);
    expect(sanityConnector.configured({ SANITY_PROJECT_ID: "" })).toBe(false);
    expect(sanityConnector.configured({ SANITY_TOKEN: TOKEN, SANITY_DATASET: "production" })).toBe(
      false,
    );
  });

  it("declares every variable it may read, and only the token is a key", () => {
    expect([...SANITY_ENV_VARS].sort()).toEqual(
      [
        "GAUGELINE_PRODUCTS_QUERY",
        "GAUGELINE_SANITY_PRICE_UNIT",
        "SANITY_DATASET",
        "SANITY_PROJECT_ID",
        "SANITY_TOKEN",
      ].sort(),
    );
    expect(sanityConnector.secretEnvVars).toEqual(["SANITY_TOKEN"]);
  });
});

describe("integration: recorded answers", () => {
  it("a public dataset with no token: no Authorization header is sent, and products come back", async () => {
    const seen: Seen[] = [];
    const run = await runConnectors([sanityConnector], PUBLIC, recorded(seen));
    expect(run.notices).toEqual([]);
    const products = run.data.get("sanity") as unknown[];
    expect(products).toHaveLength(5);
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]?.headers ?? {}).map((h) => h.toLowerCase())).not.toContain(
      "authorization",
    );
  });

  it("reads the prices of a pop-up kitchen as whole minor units", async () => {
    const products = await sanityConnector.read(PUBLIC, recorded());
    expect(products.map((p) => [p._id, p.price])).toEqual([
      ["tasting-box", 4500],
      ["supper-ticket", 4800],
      ["hot-sauce", 1999],
      ["apron", null],
      ["gift-card", 0],
    ]);
    expect(products[0]).toEqual({
      _id: "tasting-box",
      name: "Tasting box for two",
      price: 4500,
      sku: "EMB-TASTE",
      stripeId: "prod_EmberTasting1",
    });
    expect(products[3]).toEqual({
      _id: "apron",
      name: "Ember apron",
      price: null,
      printfulId: "pf-apron-7",
    });
  });

  it("the request is one GET whose address asks for the published perspective", async () => {
    const seen: Seen[] = [];
    await sanityConnector.read(PUBLIC, recorded(seen));
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
    const url = new URL(seen[0]?.url ?? "");
    expect(url.hostname).toBe("ember8kc.api.sanity.io");
    expect(url.pathname).toBe("/v2021-10-21/data/query/production");
    expect(url.searchParams.get("perspective")).toBe("published");
    expect(url.searchParams.get("query")).toBe(DEFAULT_PRODUCTS_QUERY);
  });

  it("a token goes in the Authorization header and never in the address", async () => {
    const seen: Seen[] = [];
    const env = {
      SANITY_PROJECT_ID: "v1ewert0",
      SANITY_DATASET: "production",
      SANITY_TOKEN: TOKEN,
    };
    const products = await sanityConnector.read(env, recorded(seen));
    expect(products.map((p) => p._id)).toEqual(["clinic-pack"]);
    expect(products[0]?.price).toBe(12000);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    for (const s of seen) expect(s.url).not.toContain(TOKEN);
  });

  it("a private dataset with no token: the Viewer-role message, zero products, other connectors unaffected", async () => {
    const env = { SANITY_PROJECT_ID: "pr1v4te0", SANITY_DATASET: "production" };
    const run = await runConnectors(
      [sanityConnector, fake("stripe", ["STRIPE_API_KEY"], async () => [{ id: "prod_1" }])],
      { ...env, STRIPE_API_KEY: testKey("stripe") },
      recorded(),
    );
    expect(run.data.has("sanity")).toBe(false);
    expect(run.data.get("stripe")).toEqual([{ id: "prod_1" }]);
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]).toMatchObject({ connector: "sanity", kind: "refused" });
    expect(run.notices[0]?.message).toMatch(
      /private dataset needs a read-only token with the Viewer role/,
    );
    expect(run.notices[0]?.message).toContain("HTTP 401");
  });

  it("read throws a ConnectorRefusedError that says the same, so a caller outside the runner sees it", async () => {
    const env = { SANITY_PROJECT_ID: "pr1v4te0", SANITY_DATASET: "production" };
    const err = await sanityConnector.read(env, recorded()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorRefusedError);
    expect((err as Error).message).toMatch(/needs a read-only token with the Viewer role/);
    expect((err as ConnectorRefusedError).status).toBe(401);
  });

  it("a token Sanity does not accept gets a message about the token, not about having none", async () => {
    const env = {
      SANITY_PROJECT_ID: "b4dt0ken",
      SANITY_DATASET: "production",
      SANITY_TOKEN: TOKEN,
    };
    const run = await runConnectors([sanityConnector], env, recorded());
    const refused = run.notices.find((n) => n.kind === "refused");
    expect(refused?.message).toMatch(/did not accept SANITY_TOKEN/);
    expect(refused?.message).toMatch(/Viewer role/);
    expect(refused?.message).not.toContain(TOKEN);
  });

  it("a token that can write is still used, with one notice recommending Viewer", async () => {
    const seen: Seen[] = [];
    const env = {
      SANITY_PROJECT_ID: "wr1ter00",
      SANITY_DATASET: "production",
      SANITY_TOKEN: TOKEN,
    };
    const run = await runConnectors([sanityConnector], env, recorded(seen));
    expect((run.data.get("sanity") as unknown[]).length).toBe(1);
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]).toMatchObject({ connector: "sanity", kind: "advice" });
    expect(run.notices[0]?.message).toMatch(/"editor".*Viewer role/);
    expect(seen.every((s) => s.method === "GET")).toBe(true);
    expect(seen.every((s) => s.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("a Viewer token gets no notice", async () => {
    const env = {
      SANITY_PROJECT_ID: "v1ewert0",
      SANITY_DATASET: "production",
      SANITY_TOKEN: TOKEN,
    };
    const run = await runConnectors([sanityConnector], env, recorded());
    expect(run.notices).toEqual([]);
  });

  it("a role Gaugeline cannot read gives no advice and no failure", async () => {
    const env = {
      SANITY_PROJECT_ID: "v1ewert0",
      SANITY_DATASET: "production",
      SANITY_TOKEN: TOKEN,
    };
    const fetcher = serving((url) =>
      url.pathname.endsWith("/users/me")
        ? { status: 404, body: "{}" }
        : { status: 200, body: JSON.stringify({ result: [] }) },
    );
    const run = await runConnectors([sanityConnector], env, fetcher);
    expect(run.notices).toEqual([]);
    expect(run.data.get("sanity")).toEqual([]);
  });

  it("SANITY_DATASET unset: the notice says which dataset name was assumed", async () => {
    const seen: Seen[] = [];
    const run = await runConnectors(
      [sanityConnector],
      { SANITY_PROJECT_ID: "ember8kc" },
      recorded(seen),
    );
    expect(new URL(seen[0]?.url ?? "").pathname).toBe("/v2021-10-21/data/query/production");
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]).toMatchObject({ kind: "advice" });
    expect(run.notices[0]?.message).toContain('"production" was assumed');
    expect((run.data.get("sanity") as unknown[]).length).toBe(5);
  });

  it("the assumed-dataset notice also explains a failure", async () => {
    const run = await runConnectors(
      [sanityConnector],
      { SANITY_PROJECT_ID: "pr1v4te0" },
      recorded(),
    );
    expect(run.notices.map((n) => n.kind)).toEqual(["refused", "advice"]);
  });

  it("a named dataset is read as named, with no assumption notice", async () => {
    const seen: Seen[] = [];
    const run = await runConnectors(
      [sanityConnector],
      { SANITY_PROJECT_ID: "ember8kc", SANITY_DATASET: "staging" },
      recorded(seen),
    );
    expect(new URL(seen[0]?.url ?? "").pathname).toBe("/v2021-10-21/data/query/staging");
    expect(run.notices).toEqual([]);
  });

  it("no SANITY_PROJECT_ID: could-not-check, never a pass, and nothing is requested", async () => {
    const seen: Seen[] = [];
    const run = await runConnectors([sanityConnector], { SANITY_TOKEN: TOKEN }, recorded(seen));
    expect(run.data.has("sanity")).toBe(false);
    expect(run.notices).toEqual([
      expect.objectContaining({
        connector: "sanity",
        kind: "not-configured",
        message: expect.stringContaining("SANITY_PROJECT_ID"),
      }),
    ]);
    expect(seen).toEqual([]);
  });

  it("a rate limit says when to try again", async () => {
    const env = { SANITY_PROJECT_ID: "r4t3l1m1", SANITY_DATASET: "production" };
    const err = await sanityConnector.read(env, recorded()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorRateLimitedError);
    expect((err as Error).message).toContain("in 30 seconds");
  });

  it("a query Sanity cannot run points at GAUGELINE_PRODUCTS_QUERY", async () => {
    const env = { ...PUBLIC, GAUGELINE_PRODUCTS_QUERY: "*[_type ==" };
    await expect(sanityConnector.read(env, recorded())).rejects.toThrow(
      /HTTP 400.*GAUGELINE_PRODUCTS_QUERY/,
    );
  });
});

describe("custom query (GAUGELINE_PRODUCTS_QUERY): recorded answers", () => {
  const env = (fields: string, more: Env = {}): Env => ({
    ...PUBLIC,
    GAUGELINE_PRODUCTS_QUERY: custom(fields),
    ...more,
  });

  it("replaces the default; a query without sku is accepted", async () => {
    const seen: Seen[] = [];
    const got = await sanityConnector.read(env("_id, name, price"), recorded(seen));
    expect(got.map((p) => [p._id, p.price, p.sku])).toEqual([
      ["menu-1", 125000, undefined],
      ["menu-2", 180000, undefined],
    ]);
    expect(new URL(seen[0]?.url ?? "").searchParams.get("query")).toBe(custom("_id, name, price"));
  });

  it("GAUGELINE_SANITY_PRICE_UNIT=cents reads prices as minor units already", async () => {
    const got = await sanityConnector.read(
      env('_id, name, "price": priceCents, sku', { GAUGELINE_SANITY_PRICE_UNIT: "cents" }),
      recorded(),
    );
    // 1250 stays 1250, "900" stays 900, and 4.5 is not a whole number of cents.
    expect(got.map((p) => p.price)).toEqual([1250, 900, null]);
  });

  it("a product with no price field is returned with price null", async () => {
    const got = await sanityConnector.read(env("_id, name"), recorded());
    expect(got.map((p) => [p._id, p.price])).toEqual([
      ["menu-1", null],
      ["menu-2", 180000],
    ]);
  });

  it("a query missing name or _id is refused with the field named", async () => {
    await expect(sanityConnector.read(env("_id, price"), recorded())).rejects.toThrow(/"name"/);
    await expect(sanityConnector.read(env("name, price"), recorded())).rejects.toThrow(/"_id"/);
  });

  it("a query too long to send as a GET says so", async () => {
    const long = {
      ...PUBLIC,
      GAUGELINE_PRODUCTS_QUERY: `*[_type == "product"]{_id, name, price${", price".repeat(1500)}}`,
    };
    const seen: Seen[] = [];
    await expect(sanityConnector.read(long, recorded(seen))).rejects.toThrow(/too long/);
    expect(seen).toEqual([]);
  });
});

describe("edge cases", () => {
  it("a custom query returning 5,000 documents is read in one response and no content is logged", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      _id: `menu-${i}`,
      name: `Invented dish number ${i} with a secret recipe`,
      price: `${(i % 90) + 1}.${String((i * 7) % 100).padStart(2, "0")}`,
      sku: `SKU-${i}`,
    }));
    const seen: Seen[] = [];
    const lines: string[] = [];
    const fetcher = serving(() => ({ status: 200, body: JSON.stringify({ result: rows }) }), seen);
    const run = await runConnectors(
      [sanityConnector],
      { ...PUBLIC, GAUGELINE_PRODUCTS_QUERY: custom("_id, name, price, sku"), SANITY_TOKEN: TOKEN },
      fetcher,
      { debug: (l) => lines.push(l) },
    );
    // One query and the one request for the token's role: the products are not asked for twice.
    expect(seen.filter((s) => s.url.includes("/data/query/"))).toHaveLength(1);
    expect((run.data.get("sanity") as unknown[]).length).toBe(5000);
    const text = lines.join("\n");
    expect(text).toContain("5000 rows");
    expect(text).not.toContain("secret recipe");
    expect(text).not.toContain("SKU-");
    expect(JSON.stringify(run.notices)).not.toContain("secret recipe");
  });

  it("an answer cut at the size cap is an error that says so, not half a list", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ _id: `p-${i}`, name: "Dish", price: 1 }));
    const fetcher = serving(
      () => ({ status: 200, body: JSON.stringify({ result: rows }) }),
      [],
      500,
    );
    await expect(sanityConnector.read(PUBLIC, fetcher)).rejects.toThrow(/larger than/);
  });

  it("an answer that is not a query result is an error, not an empty list", async () => {
    for (const body of ["<html>maintenance</html>", "[]", '{"ok":true}'])
      await expect(
        sanityConnector.read(
          PUBLIC,
          serving(() => ({ status: 200, body })),
        ),
      ).rejects.toThrow(/not a query result/);
  });

  it("a project id that is not one is refused before any request", async () => {
    const seen: Seen[] = [];
    for (const bad of ["a.b", "x/../y", "ember 8kc", "EMBER.EXAMPLE.COM/"])
      await expect(
        sanityConnector.read(
          { SANITY_PROJECT_ID: bad },
          serving(() => ({ status: 200, body: "{}" }), seen),
        ),
      ).rejects.toThrow(/not a Sanity project id/);
    expect(seen).toEqual([]);
  });

  it("the address built for a dataset name is encoded", () => {
    expect(productsUrl("ember8kc", "a b", "*[]")).toBe(
      "https://ember8kc.api.sanity.io/v2021-10-21/data/query/a%20b?query=*%5B%5D&perspective=published",
    );
  });

  it("the same input gives the same products", async () => {
    const a = await sanityConnector.read(PUBLIC, recorded());
    const b = await sanityConnector.read(PUBLIC, recorded());
    expect(a).toEqual(b);
  });
});

describe("typeCounts", () => {
  it("returns a count per _type as a Map, in alphabetical order", async () => {
    const counts = await typeCounts(PUBLIC, recorded());
    expect(counts).toBeInstanceOf(Map);
    expect([...counts]).toEqual([
      ["menuItem", 14],
      ["product", 5],
      ["siteSettings", 1],
    ]);
  });

  it("asks only for type names and counts, by GET, for what is published", async () => {
    const seen: Seen[] = [];
    await typeCounts(PUBLIC, recorded(seen));
    expect(seen.map((s) => s.method)).toEqual(["GET", "GET"]);
    for (const s of seen) expect(new URL(s.url).searchParams.get("perspective")).toBe("published");
    const queries = seen.map((s) => new URL(s.url).searchParams.get("query") ?? "");
    expect(queries[0]).toBe("array::unique(*[]._type)");
    expect(queries[1]).toBe(
      '{"t0": count(*[_type == "menuItem"]), "t1": count(*[_type == "product"]), "t2": count(*[_type == "siteSettings"])}',
    );
  });

  it("is also on the connector, and a private dataset says it needs a Viewer token", async () => {
    expect(sanityConnector.typeCounts).toBe(typeCounts);
    await expect(
      sanityConnector.typeCounts({ SANITY_PROJECT_ID: "pr1v4te0" }, recorded()),
    ).rejects.toThrow(/Viewer role/);
  });

  it("an empty dataset is an empty Map and a type name is quoted, never pasted into the query", async () => {
    expect(
      (
        await typeCounts(
          PUBLIC,
          serving(() => ({ status: 200, body: '{"result":[]}' })),
        )
      ).size,
    ).toBe(0);
    const asked: string[] = [];
    const fetcher = serving((url) => {
      const q = url.searchParams.get("query") ?? "";
      asked.push(q);
      return q.startsWith("array::")
        ? { status: 200, body: JSON.stringify({ result: ['we"ird]) || true //'] }) }
        : { status: 200, body: JSON.stringify({ result: { t0: 3 } }) };
    });
    const counts = await typeCounts(PUBLIC, fetcher);
    expect(counts.get('we"ird]) || true //')).toBe(3);
    expect(asked[1]).toBe('{"t0": count(*[_type == "we\\"ird]) || true //"])}');
  });

  it("counts a long list of types in chunks of 50", async () => {
    const names = Array.from({ length: 120 }, (_, i) => `type${String(i).padStart(3, "0")}`);
    const fetcher = serving((url) => {
      const q = url.searchParams.get("query") ?? "";
      if (q.startsWith("array::")) return { status: 200, body: JSON.stringify({ result: names }) };
      const keys = [...q.matchAll(/"t(\d+)":/g)].map((m) => m[1] as string);
      return {
        status: 200,
        body: JSON.stringify({
          result: Object.fromEntries(keys.map((k) => [`t${k}`, Number(k) + 1])),
        }),
      };
    });
    const counts = await typeCounts(PUBLIC, fetcher);
    expect(counts.size).toBe(120);
    expect(counts.get("type000")).toBe(1);
  });

  it("a count that is not a count is an error", async () => {
    const fetcher = serving((url) =>
      (url.searchParams.get("query") ?? "").startsWith("array::")
        ? { status: 200, body: '{"result":["a"]}' }
        : { status: 200, body: '{"result":{"t0":"many"}}' },
    );
    await expect(typeCounts(PUBLIC, fetcher)).rejects.toThrow(/not a count/);
  });
});

describe("promise: the token is in no message and no result", () => {
  /** A network that echoes the Authorization header into everything it says. */
  function echoing(kind: "401" | "500" | "throw" | "body"): Fetcher {
    const transport: Transport = (_url, req) => {
      const auth = req.headers.authorization ?? "";
      if (kind === "throw")
        return Promise.reject(new Error(`connect failed with ${auth} ${auth.slice(7)}`));
      const status = kind === "401" ? 401 : kind === "500" ? 500 : 200;
      return Promise.resolve({
        status,
        headers: { "content-type": "application/json" },
        body: Readable.from([Buffer.from(JSON.stringify({ error: auth, result: auth }), "utf8")]),
      });
    };
    return createFetcher({ transport, timeoutMs: 5000 });
  }
  const env = { ...PUBLIC, SANITY_TOKEN: TOKEN };

  it.each(["401", "500", "throw", "body"] as const)(
    "when Sanity answers %s and echoes the token, no error message or run output holds it",
    async (kind) => {
      const lines: string[] = [];
      const run = await runConnectors([sanityConnector], env, echoing(kind), {
        debug: (l) => lines.push(l),
      });
      expect(JSON.stringify(run)).not.toContain(TOKEN);
      expect(JSON.stringify([...run.data])).not.toContain(TOKEN);
      expect(lines.join("\n")).not.toContain(TOKEN);
      for (const call of [
        () => sanityConnector.read(env, echoing(kind)),
        () => typeCounts(env, echoing(kind)),
      ]) {
        const err = await call().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).not.toContain(TOKEN);
        expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(TOKEN);
      }
    },
  );

  it("the products of a run that used a token hold no token", async () => {
    const withToken = {
      SANITY_PROJECT_ID: "v1ewert0",
      SANITY_DATASET: "production",
      SANITY_TOKEN: TOKEN,
    };
    const run = await runConnectors([sanityConnector], withToken, recorded());
    expect(JSON.stringify([...run.data])).not.toContain(TOKEN);
    expect(JSON.stringify(run.notices)).not.toContain(TOKEN);
  });
});

describe("read only", () => {
  it("every request made reading products, counts and the token's role is a GET", async () => {
    const seen: Seen[] = [];
    const fetcher = recorded(seen);
    await sanityConnector.read(PUBLIC, fetcher);
    await typeCounts(PUBLIC, fetcher);
    await runConnectors(
      [sanityConnector],
      { SANITY_PROJECT_ID: "wr1ter00", SANITY_DATASET: "production", SANITY_TOKEN: TOKEN },
      recorded(seen),
    );
    expect(seen.length).toBeGreaterThanOrEqual(5);
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(["GET"]));
  });
});

describe("one field of a published document (switches): unit", () => {
  it("builds a GROQ query for the first published document of a type", () => {
    expect(fieldQuery("siteSettings", ["features", "preOrders"])).toBe(
      '*[_type == "siteSettings"][0].features.preOrders',
    );
  });

  it("refuses a type or field name that could add to the query", () => {
    expect(() => fieldQuery('x"] || true //', ["a"])).toThrow(/not a Sanity document type name/);
    expect(() => fieldQuery("siteSettings", ['a"]'])).toThrow(/plain field names/);
    expect(() => fieldQuery("siteSettings", ["a b"])).toThrow(/plain field names/);
    expect(() => fieldQuery("siteSettings", [])).toThrow(/plain field names/);
    expect(() => fieldQuery("siteSettings", ["a", "b[0]"])).toThrow(/plain field names/);
  });
});

describe("one field of a published document (switches): recorded answers", () => {
  const read = (seen: Seen[] = []) => {
    const replay = useCassette("sanity-switches", { mode: "replay" });
    const transport: Transport = (url, req) => {
      seen.push({ method: req.method, url: url.href, headers: req.headers });
      return replay(url, req);
    };
    return createFetcher({ transport, timeoutMs: 5000 });
  };
  const env: Env = { SANITY_PROJECT_ID: "mar1gold", SANITY_DATASET: "production" };

  it("returns the value, or null when the document or field is missing, with one GET asking for published content", async () => {
    const seen: Seen[] = [];
    const fetcher = read(seen);
    expect(await readField(env, fetcher, "siteSettings", ["features", "preOrders"])).toBe(false);
    expect(await readField(env, fetcher, "siteSettings", ["eightySixed"])).toEqual([
      "Pozole rojo",
      "Tamales de rajas",
    ]);
    expect(await readField(env, fetcher, "noSuchType", ["x"])).toBeNull();
    expect(seen.map((s) => s.method)).toEqual(["GET", "GET", "GET"]);
    expect(seen[0]?.url).toContain("perspective=published");
  });

  it("sends the token in a header, never in the address, and a refusal says what key is needed", async () => {
    const seen: Seen[] = [];
    await expect(
      readField(
        { SANITY_PROJECT_ID: "pr1v4te0", SANITY_TOKEN: TOKEN },
        read(seen),
        "siteSettings",
        ["features", "preOrders"],
      ),
    ).rejects.toBeInstanceOf(ConnectorRefusedError);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]?.url).not.toContain(TOKEN);
  });

  it("a bad query (HTTP 400) is explained without pointing at the products query variable", async () => {
    const fetcher = serving(() => ({ status: 400, body: "{}" }));
    await expect(readField(env, fetcher, "siteSettings", ["x"])).rejects.toThrow(
      /document type and field names/,
    );
  });
});
