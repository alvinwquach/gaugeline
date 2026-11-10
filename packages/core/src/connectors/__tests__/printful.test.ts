import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { useCassette } from "../../../../testkit/src/index.js";
import { createFetcher, type Fetcher, type Transport } from "../../fetcher.js";
import {
  PRINTFUL_ENV_VARS,
  PRINTFUL_MAX_DETAILS,
  PRINTFUL_MAX_LIST_PAGES,
  createPrintfulConnector,
  mapPrintfulVariant,
  printfulConnector,
  retailToMinor,
} from "../printful.js";
import { runConnectors } from "../run.js";
import { fake } from "./fake.js";

// Key-shaped values are put together at run time: GitHub push protection rejects literals.
const TOKEN = ["pf", "ridgeline", "coaching", "0123456789abcdef"].join("-");
const STORE = "3141592";
const ENV = { PRINTFUL_API_TOKEN: TOKEN, PRINTFUL_STORE_ID: STORE };

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
}

const isList = (s: Seen) => new URL(s.url).pathname === "/store/products";
const isDetail = (s: Seen) => /^\/store\/products\/\d+$/.test(new URL(s.url).pathname);

/** A fetcher that answers from a recorded cassette, logs every request and counts those in flight. */
function recorded(cassette: string, seen: Seen[] = [], gauge = { now: 0, max: 0 }): Fetcher {
  const replay = useCassette(cassette, { mode: "replay" });
  const transport: Transport = async (url, req) => {
    seen.push({ method: req.method, url: url.href, headers: req.headers });
    gauge.now++;
    gauge.max = Math.max(gauge.max, gauge.now);
    try {
      await new Promise((r) => setTimeout(r, 5));
      return await replay(url, req);
    } finally {
      gauge.now--;
    }
  };
  return createFetcher({ transport, timeoutMs: 5000 });
}

interface Answer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A fetcher whose network is one function: for the answers a cassette cannot hold. */
function serving(answer: (url: URL, seen: Seen[]) => Answer, seen: Seen[] = []): Fetcher {
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href, headers: req.headers });
    const { status, body, headers } = answer(url, seen);
    return Promise.resolve({
      status,
      headers: { "content-type": "application/json", ...headers },
      body: Readable.from([
        Buffer.from(typeof body === "string" ? body : JSON.stringify(body ?? {})),
      ]),
    });
  };
  return createFetcher({ transport, timeoutMs: 5000 });
}

const lowerHeaders = (h: Record<string, string>) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

// A store of `count` products, `perPage` to a page however many were asked for.
function store(count: number, perPage: number, variantsOf: (id: number) => unknown[] = oneVariant) {
  const ids = Array.from({ length: count }, (_, i) => 1000 + i);
  return (url: URL): Answer => {
    const path = url.pathname;
    if (path === "/store/products") {
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const page = ids.slice(offset, offset + perPage);
      return {
        status: 200,
        body: {
          code: 200,
          result: page.map((id) => ({ id, external_id: `e${id}`, name: `Item ${id}` })),
          paging: { total: count, offset, limit: perPage },
        },
      };
    }
    const id = Number(path.split("/").pop());
    return {
      status: 200,
      body: {
        code: 200,
        result: {
          sync_product: { id, name: `Item ${id}` },
          sync_variants: variantsOf(id),
        },
      },
    };
  };
}
const oneVariant = (id: number) => [
  { id: id * 10, synced: true, retail_price: "10.00", currency: "USD", sku: `S${id}` },
];

const noSleep = () => Promise.resolve();

describe("retailToMinor: unit", () => {
  it('"24.50" becomes 2450; "24.5" becomes 2450; "" becomes null', () => {
    expect(retailToMinor("24.50")).toBe(2450);
    expect(retailToMinor("24.5")).toBe(2450);
    expect(retailToMinor("")).toBeNull();
  });

  it("whole numbers, zero, thousands and a number sent as a number", () => {
    expect(retailToMinor("28")).toBe(2800);
    expect(retailToMinor("0.00")).toBe(0);
    expect(retailToMinor("1,299.00")).toBe(129900);
    expect(retailToMinor(24.5)).toBe(2450);
  });

  it("anything that is not a plain price is null, never a guess", () => {
    for (const bad of [undefined, null, "  ", "free", "-1", "24.999", "1e3", {}, [], true, NaN])
      expect(retailToMinor(bad), String(bad)).toBeNull();
  });
});

describe("variant mapping: unit", () => {
  it("synced false is preserved and a missing sku is undefined, not an empty string", () => {
    const v = mapPrintfulVariant({
      id: 70022,
      synced: false,
      retail_price: "58.50",
      currency: "USD",
    });
    expect(v).toEqual({ id: "70022", synced: false, retailPrice: 5850, currency: "USD" });
    expect(v.sku).toBeUndefined();
    expect(Object.keys(v)).not.toContain("sku");
    expect(mapPrintfulVariant({ id: 1, synced: true, sku: "", retail_price: "1.00" }).sku).toBe(
      undefined,
    );
  });

  it("keeps a sku, a synced true and a missing price as null", () => {
    expect(
      mapPrintfulVariant({
        id: 7,
        synced: true,
        sku: "RL-TEE-S",
        retail_price: "",
        currency: "EUR",
      }),
    ).toEqual({ id: "7", sku: "RL-TEE-S", synced: true, retailPrice: null, currency: "EUR" });
  });

  it("an id that is a number becomes text, and a variant without an id is refused", () => {
    expect(mapPrintfulVariant({ id: 123456, synced: true }).id).toBe("123456");
    expect(() => mapPrintfulVariant({ synced: true })).toThrow(/no id/);
    expect(() => mapPrintfulVariant("variant")).toThrow(/no id/);
  });

  it("keeps only the fields of the type: no names, files or thumbnails", () => {
    const v = mapPrintfulVariant({
      id: 1,
      name: "Tee / S",
      synced: true,
      retail_price: "1.00",
      currency: "USD",
      files: [{ url: "https://files.example/a.png" }],
    });
    expect(Object.keys(v).sort()).toEqual(["currency", "id", "retailPrice", "synced"]);
  });
});

describe("configured: unit", () => {
  it("needs the token and the store id; only the token is a key", () => {
    expect(printfulConnector.id).toBe("printful");
    expect(printfulConnector.envVars).toEqual([...PRINTFUL_ENV_VARS]);
    expect(printfulConnector.secretEnvVars).toEqual(["PRINTFUL_API_TOKEN"]);
    expect(printfulConnector.configured(ENV)).toBe(true);
    expect(printfulConnector.configured({ PRINTFUL_API_TOKEN: TOKEN })).toBe(false);
    expect(printfulConnector.configured({ PRINTFUL_STORE_ID: STORE })).toBe(false);
    expect(printfulConnector.configured({ ...ENV, PRINTFUL_STORE_ID: "" })).toBe(false);
  });
});

describe("integration: recorded responses", () => {
  it("45 products across three list pages: three list requests and 45 detail requests, never more than 5 in flight", async () => {
    const seen: Seen[] = [];
    const gauge = { now: 0, max: 0 };
    const products = await printfulConnector.read(ENV, recorded("printful-large", seen, gauge));
    expect(products).toHaveLength(45);
    expect(products.map((p) => p.id)).toEqual(Array.from({ length: 45 }, (_, i) => `${9001 + i}`));
    expect(seen.filter(isList).map((s) => new URL(s.url).search)).toEqual([
      "?offset=0&limit=100",
      "?offset=20&limit=100",
      "?offset=40&limit=100",
    ]);
    expect(seen.filter(isDetail)).toHaveLength(45);
    expect(seen).toHaveLength(48);
    expect(gauge.max).toBeGreaterThan(1);
    expect(gauge.max).toBeLessThanOrEqual(5);
  });

  it("the coach's merch: sizes, an unsynced variant, no price, no sku, a draft with none", async () => {
    const products = await printfulConnector.read(ENV, recorded("printful-merch"));
    expect(products.map((p) => [p.id, p.externalId, p.name, p.variants.length])).toEqual([
      ["5001", "ridgeline-tee", "Ridgeline logo tee", 3],
      ["5002", "ridgeline-hoodie", "Training hoodie", 2],
      ["5003", "ridgeline-bottle", "Steel water bottle", 1],
      ["5004", "ridgeline-tote", "Gym tote bag", 1],
      ["5005", undefined, "Programme poster (draft)", 0],
    ]);
    const hoodie = products[1]?.variants ?? [];
    expect(hoodie.map((v) => [v.sku, v.synced, v.retailPrice])).toEqual([
      ["RL-HOOD-M", true, 5400],
      ["RL-HOOD-L", false, 5850],
    ]);
    expect(products[2]?.variants[0]).toEqual({
      id: "70031",
      synced: true,
      retailPrice: null,
      currency: "USD",
    });
    expect(products[3]?.variants[0]?.retailPrice).toBe(2450);
  });

  it("every request is a GET; the token and the store id travel in headers, never in the address", async () => {
    const seen: Seen[] = [];
    await printfulConnector.read(ENV, recorded("printful-merch", seen));
    expect(seen).toHaveLength(6);
    for (const s of seen) {
      const h = lowerHeaders(s.headers);
      expect(s.method).toBe("GET");
      expect(h.authorization).toBe(`Bearer ${TOKEN}`);
      expect(h["x-pf-store-id"]).toBe(STORE);
      expect(s.url).not.toContain(TOKEN);
      expect(s.url).not.toContain(STORE);
      expect(new URL(s.url).host).toBe("api.printful.com");
    }
  });

  it("401: one notice that names the token, and Sanity and Stripe data is still returned", async () => {
    const seen: Seen[] = [];
    const run = await runConnectors(
      [
        fake("sanity", ["SANITY_PROJECT_ID"], async () => [{ id: "tasting-box" }]),
        printfulConnector,
        fake("stripe", ["STRIPE_API_KEY"], async () => [{ id: "prod_1" }, { id: "prod_2" }]),
      ],
      { ...ENV, SANITY_PROJECT_ID: "ember", STRIPE_API_KEY: "placeholder-value" },
      serving(
        () => ({ status: 401, body: { code: 401, error: { message: `bad ${TOKEN}` } } }),
        seen,
      ),
    );
    expect(run.data.get("sanity")).toHaveLength(1);
    expect(run.data.get("stripe")).toHaveLength(2);
    expect(run.data.has("printful")).toBe(false);
    expect(run.notices).toHaveLength(1);
    const n = run.notices[0];
    expect(n?.kind).toBe("refused");
    expect(n?.message).toMatch(/PRINTFUL_API_TOKEN/);
    expect(n?.message).toMatch(/token/i);
    expect(n?.message).toMatch(/401/);
    expect(JSON.stringify(run)).not.toContain(TOKEN);
    expect(seen).toHaveLength(1);
  });

  it("403 or 404 on the store: the notice says the token cannot see that store id, and names the id", async () => {
    for (const status of [403, 404]) {
      const run = await runConnectors(
        [printfulConnector],
        ENV,
        serving(() => ({ status })),
      );
      const n = run.notices[0];
      expect(n?.kind, String(status)).toBe("refused");
      expect(n?.message, String(status)).toMatch(/cannot see store 3141592/);
      expect(n?.message, String(status)).toMatch(/PRINTFUL_STORE_ID/);
      expect(n?.message, String(status)).not.toMatch(/token is wrong|did not accept/);
    }
  });

  it("403 on a product's detail (a token without the scope) is refused with the same advice", async () => {
    const list = store(3, 3);
    const run = await runConnectors(
      [printfulConnector],
      ENV,
      serving((url) =>
        isDetail({ method: "GET", url: url.href, headers: {} }) ? { status: 403 } : list(url),
      ),
    );
    expect(run.notices[0]?.kind).toBe("refused");
    expect(run.notices[0]?.message).toMatch(/cannot see store 3141592/);
  });

  it("429 with Retry-After: 1 on the first detail call: one retry after 1000 ms, then success", async () => {
    const seen: Seen[] = [];
    const waits: number[] = [];
    const base = store(3, 3);
    let limited = false;
    const fetcher = serving((url) => {
      if (isDetail({ method: "GET", url: url.href, headers: {} }) && !limited) {
        limited = true;
        return { status: 429, headers: { "retry-after": "1" } };
      }
      return base(url);
    }, seen);
    const connector = createPrintfulConnector({
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    const products = await connector.read(ENV, fetcher);
    expect(products).toHaveLength(3);
    expect(waits).toEqual([1000]);
    expect(seen.filter(isDetail)).toHaveLength(4);
  });

  it("no PRINTFUL_API_TOKEN: zero requests and a not-configured notice, never a pass", async () => {
    const seen: Seen[] = [];
    const run = await runConnectors(
      [printfulConnector],
      { PRINTFUL_STORE_ID: STORE },
      serving(() => ({ status: 200 }), seen),
    );
    expect(seen).toHaveLength(0);
    expect(run.data.has("printful")).toBe(false);
    expect(run.notices).toEqual([
      {
        connector: "printful",
        kind: "not-configured",
        message: expect.stringContaining("PRINTFUL_API_TOKEN") as string,
      },
    ]);
  });
});

describe("edge cases", () => {
  it("a product with zero variants is returned with an empty array", async () => {
    const products = await printfulConnector.read(
      ENV,
      serving(store(2, 2, (id) => (id === 1000 ? [] : oneVariant(id)))),
    );
    expect(products.map((p) => p.variants.length)).toEqual([0, 1]);
    expect(products[0]?.variants).toEqual([]);
  });

  it(`260 products: ${PRINTFUL_MAX_DETAILS} read, a notice says 60 were skipped`, async () => {
    const seen: Seen[] = [];
    const notes: string[] = [];
    const products = await printfulConnector.read(
      ENV,
      serving(store(260, 100), seen),
      (m) => void notes.push(m),
    );
    expect(products).toHaveLength(200);
    expect(products[0]?.id).toBe("1000");
    expect(products[199]?.id).toBe("1199");
    expect(seen.filter(isList)).toHaveLength(3);
    expect(seen.filter(isDetail)).toHaveLength(200);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/skipped 60/);
    expect(notes[0]).toMatch(/200/);
  });

  it("the same notice reaches the run as one advice notice, with the data", async () => {
    const run = await runConnectors([printfulConnector], ENV, serving(store(205, 100)));
    expect(run.data.get("printful")).toHaveLength(200);
    expect(run.notices.map((n) => n.kind)).toEqual(["advice"]);
    expect(run.notices[0]?.message).toMatch(/skipped 5/);
  });

  it("exactly 200 products: nothing is skipped and nothing is said", async () => {
    const notes: string[] = [];
    const products = await printfulConnector.read(
      ENV,
      serving(store(200, 100)),
      (m) => void notes.push(m),
    );
    expect(products).toHaveLength(200);
    expect(notes).toEqual([]);
  });

  it("the list total changes between pages: stop at the first empty page", async () => {
    const seen: Seen[] = [];
    const base = store(40, 20);
    const fetcher = serving((url) => {
      const a = base(url);
      if (url.pathname === "/store/products") {
        // The shop says 100 products on the first page and 90 on the second, but only holds 40.
        const offset = Number(url.searchParams.get("offset"));
        const body = a.body as { paging: { total: number } };
        body.paging.total = offset === 0 ? 100 : 90;
      }
      return a;
    }, seen);
    const products = await printfulConnector.read(ENV, fetcher);
    expect(products).toHaveLength(40);
    const lists = seen.filter(isList).map((s) => new URL(s.url).searchParams.get("offset"));
    expect(lists).toEqual(["0", "20", "40"]);
  });

  it("a total that shrinks below what was read ends the list without another request", async () => {
    const seen: Seen[] = [];
    const base = store(60, 20);
    const fetcher = serving((url) => {
      const a = base(url);
      if (url.pathname === "/store/products") {
        const body = a.body as { paging: { total: number } };
        if (Number(url.searchParams.get("offset")) === 20) body.paging.total = 30;
      }
      return a;
    }, seen);
    const products = await printfulConnector.read(ENV, fetcher);
    expect(products).toHaveLength(40);
    expect(seen.filter(isList)).toHaveLength(2);
  });

  it("a product listed on two pages (the shop changed while reading) is read once", async () => {
    const seen: Seen[] = [];
    const fetcher = serving((url) => {
      if (url.pathname === "/store/products") {
        const offset = Number(url.searchParams.get("offset"));
        const ids = offset === 0 ? [1, 2] : offset === 2 ? [2, 3] : [];
        return {
          status: 200,
          body: {
            result: ids.map((id) => ({ id, name: `Item ${id}` })),
            paging: { total: 4, offset, limit: 2 },
          },
        };
      }
      return store(3, 3)(url);
    }, seen);
    const products = await printfulConnector.read(ENV, fetcher);
    expect(products.map((p) => p.id)).toEqual(["1", "2", "3"]);
    expect(seen.filter(isDetail)).toHaveLength(3);
  });

  it("no total at all: read until a page comes back empty", async () => {
    const base = store(30, 20);
    const products = await printfulConnector.read(
      ENV,
      serving((url) => {
        const a = base(url);
        if (url.pathname === "/store/products") delete (a.body as { paging?: unknown }).paging;
        return a;
      }),
    );
    expect(products).toHaveLength(30);
  });

  it(`list paging stops at ${PRINTFUL_MAX_LIST_PAGES} pages with a notice`, async () => {
    const seen: Seen[] = [];
    const notes: string[] = [];
    const fetcher = serving((url) => {
      if (url.pathname === "/store/products") {
        const offset = Number(url.searchParams.get("offset"));
        return {
          status: 200,
          body: {
            result: Array.from({ length: 100 }, (_, i) => ({ id: offset + i + 1, name: "x" })),
            paging: { total: 1_000_000, offset, limit: 100 },
          },
        };
      }
      return store(1, 1)(url);
    }, seen);
    const products = await printfulConnector.read(ENV, fetcher, (m) => void notes.push(m));
    expect(products).toHaveLength(200);
    expect(seen.filter(isList)).toHaveLength(PRINTFUL_MAX_LIST_PAGES);
    expect(notes.join(" ")).toMatch(/more products than/);
  });

  it("a product that disappears between the list and its detail is left out, with a notice", async () => {
    const base = store(3, 3);
    const notes: string[] = [];
    const products = await printfulConnector.read(
      ENV,
      serving((url) => (url.pathname.endsWith("/1001") ? { status: 404 } : base(url))),
      (m) => void notes.push(m),
    );
    expect(products.map((p) => p.id)).toEqual(["1000", "1002"]);
    expect(notes.join(" ")).toMatch(/1 product .*left out/);
  });

  it("PRINTFUL_STORE_ID missing with a token set: not configured, the notice names the missing variable", async () => {
    const seen: Seen[] = [];
    const run = await runConnectors(
      [printfulConnector],
      { PRINTFUL_API_TOKEN: TOKEN },
      serving(() => ({ status: 200 }), seen),
    );
    expect(seen).toHaveLength(0);
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]?.kind).toBe("not-configured");
    expect(run.notices[0]?.message).toContain("PRINTFUL_STORE_ID");
    expect(run.notices[0]?.message).not.toContain("PRINTFUL_API_TOKEN");
    expect(JSON.stringify(run)).not.toContain(TOKEN);
  });

  it("a store id that is not a number is unreachable by name, with no request and no header built from it", async () => {
    const seen: Seen[] = [];
    const run = await runConnectors(
      [printfulConnector],
      { ...ENV, PRINTFUL_STORE_ID: "12\r\nX-Evil: 1" },
      serving(() => ({ status: 200 }), seen),
    );
    expect(seen).toHaveLength(0);
    expect(run.notices[0]?.kind).toBe("unreachable");
    expect(run.notices[0]?.message).toMatch(/PRINTFUL_STORE_ID must be the number/);
  });

  it("a second 429 gives up with an unreachable notice that says when to try again, after one wait", async () => {
    const waits: number[] = [];
    const seen: Seen[] = [];
    const base = store(3, 3);
    const connector = createPrintfulConnector({
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    const run = await runConnectors(
      [connector],
      ENV,
      serving(
        (url) =>
          url.pathname.endsWith("/1001")
            ? { status: 429, headers: { "retry-after": "2" } }
            : base(url),
        seen,
      ),
    );
    expect(run.data.has("printful")).toBe(false);
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0]?.kind).toBe("unreachable");
    expect(run.notices[0]?.message).toMatch(/slow down/);
    expect(run.notices[0]?.message).toMatch(/2 seconds/);
    expect(waits).toEqual([2000]);
    expect(seen.filter((s) => s.url.endsWith("/1001"))).toHaveLength(2);
  });

  it("a 429 on the list, with no Retry-After or a very long one, gives up without waiting", async () => {
    for (const headers of [{}, { "retry-after": "3600" }] as Array<Record<string, string>>) {
      const waits: number[] = [];
      const seen: Seen[] = [];
      const run = await runConnectors(
        [
          createPrintfulConnector({
            sleep: (ms) => {
              waits.push(ms);
              return Promise.resolve();
            },
          }),
        ],
        ENV,
        serving(() => ({ status: 429, headers }), seen),
      );
      expect(run.notices[0]?.kind).toBe("unreachable");
      expect(waits).toEqual([]);
      expect(seen).toHaveLength(1);
    }
  });

  it("after a failure no further detail request is started", async () => {
    const seen: Seen[] = [];
    const base = store(100, 100);
    const run = await runConnectors(
      [createPrintfulConnector({ sleep: noSleep })],
      ENV,
      serving((url) => (url.pathname.endsWith("/1000") ? { status: 500 } : base(url)), seen),
    );
    expect(run.notices[0]?.kind).toBe("unreachable");
    // One list request, then at most the first five details were already on their way.
    expect(seen.filter(isDetail).length).toBeLessThanOrEqual(5);
  });

  it("an answer that is not a Printful list is unreachable, with no body in the message", async () => {
    const run = await runConnectors(
      [printfulConnector],
      ENV,
      serving(() => ({ status: 200, body: "<html>maintenance page</html>" })),
    );
    expect(run.notices[0]?.kind).toBe("unreachable");
    expect(run.notices[0]?.message).not.toContain("maintenance");
  });

  it("a detail with no variant list is unreachable, not an empty product", async () => {
    const base = store(1, 1);
    const run = await runConnectors(
      [printfulConnector],
      ENV,
      serving((url) =>
        url.pathname === "/store/products"
          ? base(url)
          : { status: 200, body: { code: 200, result: { sync_product: { id: 1000 } } } },
      ),
    );
    expect(run.notices[0]?.kind).toBe("unreachable");
  });

  it("an empty store is an empty list, not a failure", async () => {
    const products = await printfulConnector.read(ENV, serving(store(0, 20)));
    expect(products).toEqual([]);
  });
});

describe("promise: read only, token nowhere", () => {
  it("every request over a full run is a GET; the token is in no notice, debug line or row", async () => {
    const seen: Seen[] = [];
    const debug: string[] = [];
    const planted = ["pf", "planted", "MustNeverAppear01"].join("-");
    const run = await runConnectors(
      [printfulConnector],
      { ...ENV, PRINTFUL_API_TOKEN: planted },
      recorded("printful-large", seen),
      { debug: (l) => debug.push(l) },
    );
    expect(seen.length).toBe(48);
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(["GET"]));
    const everything = JSON.stringify([run.data.get("printful"), run.notices, debug]);
    expect(everything).not.toContain(planted);
    expect(everything).not.toContain("MustNeverAppear01");
  });

  it("a server that echoes the token in a 500 body leaks nothing into the notice", async () => {
    const run = await runConnectors(
      [printfulConnector],
      ENV,
      serving(() => ({ status: 500, body: `oops ${TOKEN}` })),
    );
    expect(run.notices[0]?.kind).toBe("unreachable");
    expect(JSON.stringify(run)).not.toContain(TOKEN);
  });

  it("the connector never reads a variable it did not declare", () => {
    const touched: string[] = [];
    const spy = new Proxy(ENV as Record<string, string>, {
      get(target, name) {
        touched.push(String(name));
        return target[name as string];
      },
    });
    printfulConnector.configured(spy);
    expect(new Set(touched)).toEqual(new Set(PRINTFUL_ENV_VARS));
  });
});
