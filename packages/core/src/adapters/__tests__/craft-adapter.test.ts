import { describe, expect, it } from "vitest";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import {
  CRAFT_LIMITS,
  CRAFT_PAGE_SIZE,
  createCraftAdapter,
  safePath,
  type CraftAdapterOptions,
} from "../craft.js";
import { BUILT_ADAPTERS, PLANNED_ADAPTERS } from "../registry.js";
import { AdapterCouldNotCheck } from "../types.js";
import { recording, requestProblems, type Seen } from "./contract.js";
import {
  CRAFT_CONTENT,
  CRAFT_ENDPOINT,
  CRAFT_MARKERS,
  craftTransport,
  type CraftFixtureOptions,
} from "./craft-fixture.js";

/**
 * What is particular to the Craft CMS adapter. The rules every adapter shares (counts and fingerprints but
 * never a value, no request but GET or HEAD, a refused key is could-not-check, a rate limit is waited out
 * once) are in the contract suite, which runs over this adapter's entry in entries.ts.
 */
const KEY = testKey("craft-unit");
/** Written apart so no line looks like an email address. */
const AT = "@";
const SETTINGS = {
  id: "craft",
  fingerprint: { projects: ["title"], journal: ["title"], team: ["title"] },
};

function over(
  options: {
    env?: Record<string, string>;
    fixture?: CraftFixtureOptions;
    adapter?: Partial<CraftAdapterOptions>;
    transport?: Transport;
  } = {},
) {
  const seen: Seen[] = [];
  const fetcher = createFetcher({
    transport: recording(
      options.transport ?? craftTransport(undefined, { token: KEY, ...options.fixture }),
      seen,
    ),
    timeoutMs: 5000,
  });
  const adapter = createCraftAdapter({
    env: { CRAFT_URL: CRAFT_ENDPOINT, CRAFT_TOKEN: KEY, ...options.env },
    fetcher,
    settings: SETTINGS,
    sleep: () => Promise.resolve(),
    ...options.adapter,
  });
  return { adapter, seen };
}

const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  return (err as AdapterCouldNotCheck).reason;
};

const live = async (adapter: ReturnType<typeof over>["adapter"]) => {
  const out = [];
  for await (const e of adapter.liveEntries()) out.push(e);
  return out;
};

describe("the Craft CMS adapter: what it says about itself", () => {
  it("is built, asks for a read-only schema token, and replaces no planned entry twice", () => {
    expect(BUILT_ADAPTERS.get("craft")?.describe.keyKind).toBe("read-only");
    expect(PLANNED_ADAPTERS.some((p) => p.id === "craft")).toBe(false);
    expect(BUILT_ADAPTERS.get("craft")?.envVars).toEqual(["CRAFT_URL", "CRAFT_TOKEN"]);
  });
});

describe("the Craft CMS adapter: requests", () => {
  it("sends GraphQL queries over GET in the query parameter, with no variables and no mutation", async () => {
    const { adapter, seen } = over();
    await adapter.types();
    await collectPublished(adapter);
    await adapter.draftsReachable();
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.method).toBe("GET");
      expect(new URL(s.url).searchParams.has("query")).toBe(true);
      expect(new URL(s.url).searchParams.has("variables")).toBe(false);
    }
    expect(requestProblems(seen)).toEqual([]);
  });

  it("keeps the parameters the route already has (the action URL), and adds the query to them", async () => {
    const { adapter, seen } = over({
      env: { CRAFT_URL: "https://cms.fernlight.example/api?action=graphql%2Fapi" },
      transport: craftTransport(undefined, { token: KEY }),
    });
    await adapter.types();
    const first = new URL(seen[0]?.url ?? "");
    expect(first.searchParams.get("action")).toBe("graphql/api");
    expect(first.searchParams.get("query")).toContain("__schema");
  });

  it("writes only validated section and site handles and whole numbers into a query", async () => {
    for (const bad of ['projects") { id } mutation x {', "a b", "", "9lives", "x".repeat(80)]) {
      const { adapter, seen } = over({
        adapter: { settings: { id: "craft", fingerprint: { [bad]: [] } } },
      });
      const reason = await reasonOf(adapter.types());
      expect(reason).toMatch(/is not a Craft section handle/);
      expect(reason.length).toBeLessThan(200);
      expect(seen.filter((s) => s.url.includes("entryCount"))).toEqual([]);
    }
    const { adapter } = over();
    await expect(adapter.liveEntries({ site: 'x"} mutation {' }).next()).rejects.toThrow(
      /not a Craft site handle/,
    );
  });

  it("refuses a field that is not a field name, without writing it into a query", async () => {
    const { adapter, seen } = over();
    const reason = await reasonOf(
      adapter.fieldCounts("projects", ["title } } mutation { x", "a.b.c"]),
    );
    expect(reason).toMatch(/is not a Craft field to read/);
    expect(seen.filter((s) => s.url.includes("entryCount"))).toEqual([]);
  });

  it("asks for a custom field inside a fragment on its entry type, and never for one it was not asked for", async () => {
    const { adapter, seen } = over();
    const counts = await adapter.fieldCounts("projects", ["title", "project_Entry.summary"]);
    expect(counts).toEqual({ title: 3, "project_Entry.summary": 1 });
    const asked = decodeURIComponent(
      seen
        .map((s) => s.url)
        .join("\n")
        .replace(/\+/g, " "),
    );
    expect(asked).toContain("... on project_Entry { f1: summary }");
    expect(asked).not.toContain("bio");
  });

  it("an https endpoint only: a plain http one is refused and nothing is sent", async () => {
    const { adapter, seen } = over({ env: { CRAFT_URL: "http://cms.fernlight.example/api" } });
    expect(await reasonOf(adapter.types())).toMatch(/must be an https address/);
    expect(seen).toEqual([]);
    const withUser = over({ env: { CRAFT_URL: `https://user:pw${AT}cms.fernlight.example/api` } });
    expect(await reasonOf(withUser.adapter.types())).toMatch(/no user name/);
    expect(over({ env: { CRAFT_URL: "" } }).seen).toEqual([]);
    expect(await reasonOf(over({ env: { CRAFT_URL: "" } }).adapter.types())).toContain("CRAFT_URL");
    expect(await reasonOf(over({ env: { CRAFT_URL: "not an address" } }).adapter.types())).toMatch(
      /is not an address/,
    );
  });

  it("with no token the request is a visitor's: no Authorization header, the public schema answers", async () => {
    const seen: Seen[] = [];
    const adapter = createCraftAdapter({
      env: { CRAFT_URL: CRAFT_ENDPOINT },
      fetcher: createFetcher({
        transport: recording(craftTransport(), seen),
        timeoutMs: 5000,
      }),
      settings: SETTINGS,
      sleep: () => Promise.resolve(),
    });
    expect(await adapter.types()).toHaveLength(3);
    for (const s of seen)
      expect(Object.keys(s.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
  });

  it("the token goes in a header to the route's origin, once per request, never in an address", async () => {
    const { adapter, seen } = over();
    await adapter.types();
    for (const s of seen) {
      expect(new URL(s.url).origin).toBe(new URL(CRAFT_ENDPOINT).origin);
      expect(s.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(s.url).not.toContain(KEY);
    }
  });

  it("a token Craft answers 400 for is could-not-check and names the token and the route, not the answer", async () => {
    const { adapter } = over({ env: { CRAFT_TOKEN: testKey("craft-wrong") } });
    const reason = await reasonOf(adapter.types());
    expect(reason).toMatch(/HTTP 400/);
    expect(reason).toContain("CRAFT_TOKEN");
    expect(reason).not.toContain("Invalid authorization token");
  });
});

describe("the Craft CMS adapter: review fixes", () => {
  it("accepts only the action parameter on the route, and never echoes what else was there", async () => {
    for (const url of [
      "https://cms.fernlight.example/api?token=SECRETX",
      "https://cms.fernlight.example/api?action=graphql%2Fapi&x=1",
      "https://cms.fernlight.example/api?query=%7Bping%7D",
      "https://cms.fernlight.example/api?action=other",
    ]) {
      const { adapter, seen } = over({ env: { CRAFT_URL: url } });
      const reason = await reasonOf(adapter.types());
      expect(reason).toMatch(/no query string except action=graphql\/api/);
      expect(reason).not.toContain("SECRETX");
      expect(seen).toEqual([]);
    }
  });

  it("a section handle that is the word subscription or mutation is not mistaken for a write", async () => {
    for (const word of ["subscription", "mutation"]) {
      const { adapter } = over({
        adapter: { settings: { id: "craft", fingerprint: { [word]: [] } } },
      });
      expect(await adapter.types()).toEqual([{ name: word, count: 0 }]);
    }
  });

  it("a document that is not exactly one query is never sent", async () => {
    const { adapter, seen } = over({
      adapter: { settings: { id: "craft", fingerprint: { x: ["title"] } } },
    });
    // The only documents built are queries; a field name cannot add a second operation.
    await expect(adapter.fieldCounts("x", ["title } query B { a"])).rejects.toBeInstanceOf(
      AdapterCouldNotCheck,
    );
    expect(seen.filter((s) => s.url.includes("entryCount"))).toEqual([]);
  });

  it("a query too long for a GET is a could-not-check that says so, and is not blamed on the token", async () => {
    const { adapter, seen } = over();
    const fields = Array.from(
      { length: 20 },
      (_, i) => `${"T".repeat(100)}${i}_Entry.${"f".repeat(100)}${i}`,
    );
    const reason = await reasonOf(adapter.fieldCounts("projects", fields));
    expect(reason).toMatch(/too long for a GET request/);
    expect(reason).not.toContain("CRAFT_TOKEN");
    expect(seen.filter((s) => s.url.includes("entryCount"))).toEqual([]);
  });

  it("more than 20 fields is refused with a message that names the limit", async () => {
    const { adapter } = over();
    const reason = await reasonOf(
      adapter.fieldCounts(
        "projects",
        Array.from({ length: 21 }, (_, i) => `f${i}`),
      ),
    );
    expect(reason).toMatch(/at most 20 fields/);
  });

  it("an answer that came from another origin or from plain http is not taken as Craft's", async () => {
    const inner = craftTransport(undefined, { token: KEY });
    for (const target of ["https://elsewhere.example/api", "http://cms.fernlight.example/api"]) {
      const redirecting: Transport = (url, req) => {
        if (url.host === "cms.fernlight.example" && url.protocol === "https:")
          return Promise.resolve({
            status: 302,
            headers: { location: `${target}${url.search}` },
            body: (async function* () {})() as never,
          });
        const answered = inner(
          new URL(url.href.replace(url.origin, "https://cms.fernlight.example")),
          req,
        );
        return answered;
      };
      const { adapter } = over({ transport: redirecting });
      expect(await reasonOf(adapter.types())).toMatch(/redirect/);
    }
  });
});

describe("the Craft CMS adapter: a key that can write", () => {
  it("is refused when the schema shows a mutation type, before any entry is asked for", async () => {
    const { adapter, seen } = over({ fixture: { mutationType: true } });
    const reason = await reasonOf(adapter.types());
    expect(reason).toMatch(/allows mutations/);
    expect(reason).not.toContain(KEY);
    await expect(collectPublished(adapter)).rejects.toThrow(/allows mutations/);
    await expect(adapter.draftsReachable()).rejects.toThrow(AdapterCouldNotCheck);
    // The introspection query was asked once; the refusal is remembered.
    expect(seen).toHaveLength(1);
  });

  it("goes on when introspection is off: nothing it sends can write, and the page says to check the schema", async () => {
    const { adapter } = over({ fixture: { noIntrospection: true } });
    expect(await adapter.types()).toHaveLength(3);
  });
});

describe("the Craft CMS adapter: answers", () => {
  it("GraphQL errors in a 200 answer are could-not-check, never an empty list, and their text is not repeated", async () => {
    const { adapter } = over({ fixture: { forbidden: ["projects"] } });
    const reason = await reasonOf(adapter.fieldCounts("projects", ["title"]));
    expect(reason).toMatch(/refused the query \(1 GraphQL error\)/);
    expect(reason).not.toContain("Cannot query field");
    await expect(adapter.types()).rejects.toBeInstanceOf(AdapterCouldNotCheck);
  });

  it("an entry with an id that is not an id, or no site, is could-not-check", async () => {
    for (const patch of [
      (n: Record<string, unknown>) => ({ ...n, id: "bad id!" }),
      (n: Record<string, unknown>) => ({ ...n, id: "../etc" }),
      (n: Record<string, unknown>) => ({ ...n, siteHandle: "x y" }),
      (n: Record<string, unknown>) => ({ ...n, dateUpdated: "not a time", postDate: null }),
    ]) {
      const { adapter } = over({ fixture: { patch } });
      expect(await reasonOf(live(adapter))).toMatch(/no usable id, site or update time/);
    }
  });

  it("a hostile uri or url gives the entry no address and never throws", async () => {
    const hostile = [
      "//evil.example/x",
      "https://evil.example/x",
      "../x",
      "a/../x",
      "%2e%2e/x",
      "a%2fb",
      "a\\b",
      "a//b",
      "/leading",
      "a\ud800b",
      "x".repeat(600),
      "a?b",
      "a\u0000b",
    ];
    for (const uri of hostile) {
      const { adapter } = over({
        fixture: { patch: (n) => ({ ...n, uri, url: null }) },
      });
      const entries = await live(adapter);
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) expect(e.url).toBeUndefined();
    }
    for (const url of [
      "https://cms.example//x",
      "javascript:alert(1)",
      `https://u:p${AT}cms.example/x`,
      "ftp://cms.example/x",
      "https://cms.example/a%2Fb",
    ]) {
      const { adapter } = over({ fixture: { patch: (n) => ({ ...n, url }) } });
      for (const e of await live(adapter)) expect(e.url).toBeUndefined();
    }
  });

  it("a url with dot segments is the plain path the address parser makes of it, never a traversal", async () => {
    const { adapter } = over({
      fixture: { patch: (n) => ({ ...n, url: "https://cms.fernlight.example/%2e%2e/x" }) },
    });
    for (const e of await live(adapter)) expect(e.url).toBe("https://cms.fernlight.example/x");
  });

  it("a good uri becomes one path with a single leading slash, and __home__ is the front page", async () => {
    const { adapter } = over({
      fixture: {
        patch: (n) => ({
          ...n,
          url: null,
          uri: n.slug === "ana" ? "__home__" : "team/caf\u00E9 x",
        }),
      },
    });
    const urls = (await live(adapter)).map((e) => e.url);
    expect(urls).toContain("/");
    expect(urls).toContain("/team/caf%C3%A9%20x");
    expect(safePath("/a/b")).toBe("/a/b");
    expect(safePath("//a")).toBeUndefined();
  });

  it("a slug with a separator is left out, not repaired", async () => {
    const { adapter } = over({ fixture: { patch: (n) => ({ ...n, slug: "a/b" }) } });
    for (const e of await live(adapter)) expect(e.slug).toBeUndefined();
  });

  it("one entry on two sites is two items, and an entry switched off for a site is not live there", async () => {
    const { adapter } = over();
    const ids = (await live(adapter)).filter((e) => e.section === "projects").map((e) => e.id);
    expect(ids).toEqual(["101.studio", "101.atelier", "102.studio"]);
  });

  it("the settings' pattern for a section wins over Craft's own address, and is marked as a pattern", async () => {
    const { adapter } = over({
      adapter: { settings: { id: "craft", urls: { team: "/people/{slug}" } } },
    });
    const team = (await live(adapter)).filter((e) => e.section === "team");
    expect(team.map((e) => [e.url, e.patterned])).toEqual([
      ["/people/ana", true],
      ["/people/ben", true],
    ]);
  });

  it("no section named: nothing is asked and the lists are empty, never an invented section", async () => {
    const { adapter, seen } = over({ adapter: { settings: { id: "craft" } } });
    expect(await adapter.types()).toEqual([]);
    expect(adapter.sections()).toEqual([]);
    expect((await collectPublished(adapter)).docs).toEqual([]);
    expect(await adapter.draftsReachable()).toBe(false);
    expect(seen.every((s) => s.url.includes("__schema"))).toBe(true);
  });
});

describe("the Craft CMS adapter: paging against a server that lies", () => {
  const ids = async (opts: Parameters<typeof over>[0]) =>
    (await collectPublished(over(opts).adapter, { types: ["projects"] })).docs.map((d) => d.id);
  const everyone = ["101.studio", "101.atelier", "102.studio"];

  it("pages of one give the same entries as one big page", async () => {
    expect(await ids({ adapter: { pageSize: 1 } })).toEqual(everyone);
    expect(await ids({})).toEqual(everyone);
  });

  it("a server that clamps its page is read to the end, never reported complete early", async () => {
    expect(await ids({ fixture: { clamp: 2 } })).toEqual(everyone);
    expect(await ids({ fixture: { clamp: 1 }, adapter: { pageSize: 100 } })).toEqual(everyone);
  });

  it("the same page forever is could-not-check, not a loop", async () => {
    const { adapter, seen } = over({ fixture: { samePage: true, clamp: 1, claimTotal: 3 } });
    const reason = await reasonOf(collectPublished(adapter, { types: ["projects"] }));
    expect(reason).toMatch(/same entry twice/);
    expect(seen.length).toBeLessThan(10);
  });

  it("a total over the bound is could-not-check before anything is counted", async () => {
    const { adapter } = over({ fixture: { claimTotal: CRAFT_LIMITS.itemsPerType + 1 } });
    expect(await reasonOf(adapter.fieldCounts("projects", ["title"]))).toMatch(/more than 10000/);
    const small = over({ adapter: { maxItemsPerType: 1 } });
    expect(await reasonOf(small.adapter.fieldCounts("projects", ["title"]))).toMatch(
      /more than 1,/,
    );
  });

  it("a total that claims more than there are, with a list that runs out, is could-not-check", async () => {
    const { adapter } = over({ fixture: { claimTotal: 9 } });
    expect(await reasonOf(collectPublished(adapter, { types: ["projects"] }))).toMatch(
      /stopped after 3 of 9 entries/,
    );
  });

  it("a list longer than the bound is could-not-check whatever total it reports", async () => {
    const { adapter } = over({ fixture: { claimTotal: 2 }, adapter: { maxItemsPerType: 2 } });
    expect(await reasonOf(collectPublished(adapter, { types: ["projects"] }))).toMatch(
      /listed more entries than the 2/,
    );
  });

  it("an answer too big for one page is asked again with fewer, down to ten, then could-not-check", async () => {
    let calls = 0;
    const inner = craftTransport(undefined, { token: KEY });
    const big: Transport = (url, req) => {
      if (
        decodeURIComponent(url.search.replace(/\+/g, " ")).includes("nodes: entries") &&
        calls++ < 2
      )
        return Promise.resolve({
          status: 200,
          headers: { "content-type": "application/json" },
          body: (async function* () {
            yield Buffer.alloc(6 * 1024 * 1024, 32);
          })() as never,
        });
      return inner(url, req);
    };
    const { adapter, seen } = over({ transport: big });
    expect((await collectPublished(adapter, { types: ["projects"] })).docs).toHaveLength(3);
    const sizes = seen
      .map((s) => /limit: (\d+)/.exec(decodeURIComponent(s.url.replace(/\+/g, " ")))?.[1])
      .filter(Boolean);
    expect(sizes).toEqual(["100", "50", "25"]);
    expect(CRAFT_PAGE_SIZE).toBe(100);
  });
});

describe("the Craft CMS adapter: what never leaves", () => {
  it("no client text reaches an error, a document or a request", async () => {
    const { adapter, seen } = over({ fixture: { forbidden: ["journal"] } });
    const errors = [await reasonOf(collectPublished(adapter, { types: ["journal"] }))];
    const text = JSON.stringify([
      errors,
      (await collectPublished(adapter, { types: ["projects"] })).docs,
      seen.map((s) => decodeURIComponent(s.url)),
    ]);
    for (const m of Object.values(CRAFT_MARKERS)) expect(text).not.toContain(m);
    expect(CRAFT_CONTENT.length).toBeGreaterThan(0);
  });
});
