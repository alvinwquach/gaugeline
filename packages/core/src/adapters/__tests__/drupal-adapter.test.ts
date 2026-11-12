import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createDrupalAdapter, type DrupalAdapter } from "../drupal.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError, type AdapterSettings } from "../types.js";
import { rateLimited, requestProblems, type Seen } from "./contract.js";
import {
  DRUPAL_MARKERS,
  DRUPAL_SITE,
  FERNLEA,
  manyArticles,
  drupalTransport,
  type DrupalCredential,
  type DrupalFixtureNode,
  type DrupalFixtureOptions,
} from "./drupal-fixture.js";

const KEY = testKey("drupal-unit");
const BEARER: DrupalCredential = { kind: "bearer", token: KEY };
const BASIC: DrupalCredential = { kind: "basic", user: "gaugeline reader", password: KEY };
const SETTINGS: AdapterSettings = {
  id: "drupal",
  urls: { "node--article": "/news/{id}", "node--page": "/pages/{id}" },
  readUnpublished: true,
};

interface World {
  adapter: DrupalAdapter;
  seen: Seen[];
  sleeps: number[];
}

function world(
  content: readonly DrupalFixtureNode[] | (() => readonly DrupalFixtureNode[]) = FERNLEA,
  o: {
    fixture?: DrupalFixtureOptions;
    env?: Record<string, string>;
    settings?: AdapterSettings;
    wrap?: (t: Transport) => Transport;
    pageSize?: number;
    cap?: number;
    unpublishedCap?: number;
  } = {},
): World {
  const seen: Seen[] = [];
  const sleeps: number[] = [];
  const base = drupalTransport(content, { credential: BEARER, ...o.fixture });
  const inner = o.wrap ? o.wrap(base) : base;
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href, headers: req.headers });
    return inner(url, req);
  };
  const adapter = createDrupalAdapter({
    env: { DRUPAL_URL: DRUPAL_SITE, DRUPAL_TOKEN: KEY, ...o.env },
    fetcher: createFetcher({ transport, timeoutMs: 5000 }),
    settings: o.settings ?? SETTINGS,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...(o.pageSize !== undefined ? { pageSize: o.pageSize } : {}),
    ...(o.cap !== undefined ? { maxItemsPerType: o.cap } : {}),
    ...(o.unpublishedCap !== undefined ? { maxUnpublishedPerType: o.unpublishedCap } : {}),
  });
  return { adapter, seen, sleeps };
}

const reason = async (p: Promise<unknown>): Promise<string> => {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  return (err as AdapterCouldNotCheck).reason;
};

const answer = (status: number, body: string, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/vnd.api+json", ...headers },
    body: Readable.from([Buffer.from(body)]),
  }) as ReturnType<Transport>;

/** A transport that answers with a fixed status and body for every request. */
const fixed =
  (
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ): ((t: Transport) => Transport) =>
  () =>
  () =>
    answer(status, body, headers);

const ARTICLES_ONLY: AdapterSettings = { id: "drupal", urls: { "node--article": "/n/{id}" } };

describe("the Drupal adapter: reading what is published", () => {
  it("counts the published nodes of each named type, and nothing else", async () => {
    const { adapter } = world();
    expect(await adapter.types()).toEqual([
      { name: "node--article", count: 2 },
      { name: "node--page", count: 1 },
    ]);
  });

  it("counts the nodes that have each field, and counts a field no node has as 0", async () => {
    const { adapter } = world();
    expect(
      await adapter.fieldCounts("node--article", ["title", "field_subtitle", "field_teaser"]),
    ).toEqual({ title: 2, field_subtitle: 1, field_teaser: 0 });
  });

  it("gives fingerprints: the alias as the address, the times, and hashes of the fields asked for", async () => {
    const { adapter } = world();
    const { docs } = await collectPublished(adapter, {
      types: ["node--article"],
      fields: { "node--article": ["title", "field_subtitle"] },
    });
    expect(docs.map((d) => d.id)).toEqual([
      "5f1c0a10-0000-4000-8000-000000000001",
      "5f1c0a10-0000-4000-8000-000000000002",
    ]);
    const [flu, hours] = docs;
    expect(flu?.url).toBe("/news/flu-jab-clinic");
    expect(flu?.publishedAt).toBe("2026-10-20T10:00:00.000Z");
    expect(flu?.updatedAt).toBe("2026-11-02T10:00:00.000Z");
    expect(Object.keys(flu?.fieldHashes ?? {})).toEqual(["title", "field_subtitle"]);
    // No alias: the pattern in the settings gives the address. No subtitle: no hash, never a hash of empty.
    expect(hours?.url).toBe("/news/5f1c0a10-0000-4000-8000-000000000002");
    expect(Object.keys(hours?.fieldHashes ?? {})).toEqual(["title"]);
    for (const marker of Object.values(DRUPAL_MARKERS))
      expect(JSON.stringify(docs)).not.toContain(marker);
  });

  it("an alias that is not a plain path of the site is not used as an address", async () => {
    for (const alias of [
      "//evil.example/x",
      "/a/../b",
      "/a%2fb",
      "/a?b=1",
      "https://evil.example/x",
      7,
    ]) {
      const nodes: DrupalFixtureNode[] = [{ ...FERNLEA[0]!, alias }];
      const { adapter } = world(nodes, {
        settings: { id: "drupal", fingerprint: { "node--article": ["title"] } },
      });
      const { docs } = await collectPublished(adapter);
      expect(docs[0]?.url).toBeUndefined();
    }
  });

  it("a node saved with a status of false is not counted, even when a server lists it", async () => {
    // A server that ignores the filter and lists every node, unpublished ones included.
    const { adapter } = world(FERNLEA, { fixture: { leaky: true } });
    expect((await adapter.types()).map((t) => t.count)).toEqual([2, 1]);
  });

  it("a status that is missing or not true or false is could-not-check, never a node that is not there", async () => {
    for (const status of [undefined, "1", null, 1]) {
      const { adapter } = world([{ ...FERNLEA[0]!, status }], { fixture: { leaky: true } });
      expect(await reason(adapter.types())).toContain("status");
    }
  });

  it("falls back to the created time when a node has no changed time, and says so when it has neither", async () => {
    const { adapter } = world([{ ...FERNLEA[0]!, changed: null }]);
    expect((await collectPublished(adapter)).docs[0]?.updatedAt).toBe("2026-10-20T10:00:00.000Z");
    const none = world([{ ...FERNLEA[0]!, changed: null, created: null }]);
    expect(await reason(collectPublished(none.adapter))).toContain("update time");
  });

  it("filters by the since time and stops at a limit", async () => {
    const { adapter } = world();
    const since = await collectPublished(adapter, { since: "2026-11-01T00:00:00Z" });
    expect(since.docs.map((d) => d.type)).toEqual(["node--article"]);
    expect((await collectPublished(world().adapter, { limit: 1 })).docs).toHaveLength(1);
  });

  it("an unknown type counts 0 and asks nothing", async () => {
    const w = world();
    expect(await w.adapter.fieldCounts("node--nothing", ["a"])).toEqual({ a: 0 });
    expect(w.seen).toEqual([]);
  });

  it("a resource of another type, or with no usable id, is could-not-check", async () => {
    const other = world([{ ...FERNLEA[0]!, typeOverride: "node--page" }]);
    expect(await reason(other.adapter.types())).toContain("not of the type");
    const noId = world([{ ...FERNLEA[0]!, id: "../x" }]);
    expect(await reason(noId.adapter.types())).toContain("no usable id");
  });
});

describe("the Drupal adapter: what it sends", () => {
  it("sends GET only, asks for published nodes in a fixed order, and no key with a published read", async () => {
    const w = world();
    await w.adapter.types();
    await w.adapter.fieldCounts("node--article", ["title"]);
    await collectPublished(w.adapter);
    expect(w.seen.length).toBeGreaterThan(0);
    expect(requestProblems(w.seen)).toEqual([]);
    for (const s of w.seen) {
      const q = new URL(s.url).searchParams;
      expect(q.get("filter[status]")).toBe("1");
      expect(q.get("sort")).toBe("id");
      expect(q.get("page[limit]")).toBe("50");
      expect(s.headers.authorization).toBeUndefined();
      expect(s.headers.cookie).toBeUndefined();
      expect(s.url).not.toContain(KEY);
    }
  });

  it("asks only for the fields it needs (a sparse fieldset), and none of a node's other fields", async () => {
    const w = world();
    await collectPublished(w.adapter, {
      types: ["node--article"],
      fields: { "node--article": ["title"] },
    });
    const q = new URL(w.seen[0]?.url ?? "").searchParams;
    expect(q.get("fields[node--article]")?.split(",").sort()).toEqual(
      ["changed", "created", "path", "status", "title"].sort(),
    );
  });

  it("drops the sparse fieldset once when Drupal answers 400 to it, and still reads", async () => {
    const w = world(FERNLEA, { fixture: { refuseFields: true } });
    expect((await w.adapter.types()).map((t) => t.count)).toEqual([2, 1]);
    expect(w.seen.some((s) => new URL(s.url).searchParams.has("fields[node--article]"))).toBe(true);
    expect(w.seen.some((s) => !new URL(s.url).searchParams.has("fields[node--article]"))).toBe(
      true,
    );
  });

  it("uses a path in DRUPAL_URL as the site's folder, and the Drupal address only", async () => {
    const w = world(FERNLEA, { env: { DRUPAL_URL: `${DRUPAL_SITE}/` } });
    await w.adapter.types();
    expect(new URL(w.seen[0]?.url ?? "").pathname).toBe("/jsonapi/node/article");
  });

  it("refuses a type name that could change the address, before anything is sent", async () => {
    const bad = [
      "node--article/../../user/user",
      "node--article%2f..",
      "node--article?x=1",
      "node--article&x=1",
      "node--art[icle",
      "node--article#x",
      ["user", "evil.example--x"].join("\u0040"),
      "node--article\n",
      "NODE--article",
      "node",
      "--article",
    ];
    for (const type of bad) {
      const w = world(FERNLEA, { settings: { id: "drupal", urls: { [type]: "/x/{id}" } } });
      expect(await reason(w.adapter.types())).toContain("is not a Drupal JSON:API type");
      expect(w.seen).toEqual([]);
    }
  });

  it("refuses a field name that could change the query, before anything is sent", async () => {
    for (const field of ["a,b", "a]", "a&b=1", "a b", "a/b", "../x"]) {
      const w = world();
      expect(
        await reason(collectPublished(w.adapter, { fields: { "node--article": [field] } })),
      ).toContain("not a Drupal field name");
      expect(w.seen).toEqual([]);
    }
  });

  it("refuses an address that is not usable, before anything is sent", async () => {
    for (const url of [
      "",
      "not a url",
      "ftp://x.example",
      ["https://user:pass", "fernlea-clinic.example"].join("\u0040"),
      "https://fernlea-clinic.example/?a=1",
      "https://fernlea-clinic.example/#x",
    ]) {
      const w = world(FERNLEA, { env: { DRUPAL_URL: url } });
      expect(await reason(w.adapter.types())).toContain("DRUPAL_URL");
      expect(w.seen).toEqual([]);
    }
  });
});

describe("the Drupal adapter: pages", () => {
  const big = manyArticles(120);

  it("reads every page, stepping the offset by the page size asked, and counts all of them", async () => {
    const w = world(big, { settings: { id: "drupal", urls: { "node--article": "/n/{id}" } } });
    expect(await w.adapter.types()).toEqual([{ name: "node--article", count: 120 }]);
    const offsets = w.seen.map((s) => new URL(s.url).searchParams.get("page[offset]"));
    // Three pages, then the first page again to check the list did not change.
    expect(offsets).toEqual(["0", "50", "100", "0"]);
  });

  it("a page that holds fewer resources than the size (resources the user may not see) does not end or break the list", async () => {
    const w = world(big, {
      fixture: { omitPerPage: 5 },
      settings: { id: "drupal", urls: { "node--article": "/n/{id}" } },
    });
    expect(await w.adapter.types()).toEqual([{ name: "node--article", count: 105 }]);
  });

  it("never requests the next link: it asks from its own address, and the link is only read", async () => {
    const w = world(big, { settings: { id: "drupal", urls: { "node--article": "/n/{id}" } } });
    await w.adapter.types();
    for (const s of w.seen) expect(new URL(s.url).host).toBe("fernlea-clinic.example");
  });

  it("a next link to another host is could-not-check, and is never requested", async () => {
    const w = world(big, { fixture: { nextHost: "evil.example" } });
    expect(await reason(w.adapter.types())).toContain("another host or path");
    expect(w.seen.every((s) => new URL(s.url).host === "fernlea-clinic.example")).toBe(true);
    expect(w.seen).toHaveLength(1);
  });

  it("a next link to another path is could-not-check", async () => {
    const w = world(big, { fixture: { nextPath: "/jsonapi/user/user" } });
    expect(await reason(w.adapter.types())).toContain("another host or path");
  });

  it("a next link whose offset is not where the list should go is could-not-check", async () => {
    const w = world(big, { fixture: { nextOffset: 80 } });
    expect(await reason(w.adapter.types())).toContain("does not continue the list");
  });

  it("a next link on every page is bounded by the page count, never an endless read", async () => {
    const few = manyArticles(10);
    const w = world(few, { fixture: { nextAlways: true }, cap: 100 });
    const why = await reason(w.adapter.types());
    expect(why.length).toBeGreaterThan(0);
    expect(w.seen.length).toBeLessThanOrEqual(30);
  });

  it("the same resource twice (a server that ignores the offset) is could-not-check", async () => {
    const w = world(big, {
      wrap: (t) => (url, req) => {
        url.searchParams.set("page[offset]", "0");
        return t(url, req);
      },
    });
    expect(await reason(w.adapter.types())).toMatch(/same resource twice|next link does not/);
  });

  it("a total that moves, or that is not what came back, is could-not-check", async () => {
    expect(await reason(world(big, { fixture: { count: "moving" } }).adapter.types())).toContain(
      "changed while it was read",
    );
    expect(await reason(world(big, { fixture: { count: "wrong" } }).adapter.types())).toContain(
      "changed while it was read",
    );
  });

  it("a total that agrees is accepted", async () => {
    expect(
      await world(big, { fixture: { count: true }, settings: ARTICLES_ONLY }).adapter.types(),
    ).toEqual([{ name: "node--article", count: 120 }]);
  });

  it("a list that changed under the read (the first page is not the same at the end) is could-not-check", async () => {
    let live: readonly DrupalFixtureNode[] = big;
    const w = world(() => live, {
      fixture: {
        onRequest: (_m, _u, _h, n) => {
          // Before the last request, the one that reads the first page again, an earlier node is deleted.
          if (n === 3) live = big.slice(1);
        },
      },
    });
    expect(await reason(w.adapter.types())).toContain("first page is not the same");
  });

  it("a list longer than the bound is could-not-check, never a count of part of it", async () => {
    const w = world(big, { cap: 100 });
    expect(await reason(w.adapter.types())).toContain("more resources than the 100");
  });

  it("a total over the bound is could-not-check on the first page", async () => {
    const w = world(big, { cap: 100, fixture: { count: true } });
    expect(await reason(w.adapter.types())).toContain("more than 100");
    expect(w.seen).toHaveLength(1);
  });

  it("a server that holds the page size below what was asked is followed by the size it states", async () => {
    const w = world(big, { fixture: { maxLimit: 30 }, settings: ARTICLES_ONLY });
    expect(await w.adapter.types()).toEqual([{ name: "node--article", count: 120 }]);
    const offsets = w.seen.map((s) => new URL(s.url).searchParams.get("page[offset]"));
    expect(offsets).toEqual(["0", "30", "60", "90", "0"]);
  });
});

describe("the Drupal adapter: answers that are not a list", () => {
  it("a refusal is could-not-check and names no credential", async () => {
    for (const status of [401, 403]) {
      const w = world(FERNLEA, { wrap: fixed(status, "{}") });
      const why = await reason(w.adapter.types());
      expect(why).toContain(`HTTP ${status}`);
      expect(why).not.toContain(KEY);
    }
  });

  it("anonymous reads switched off is could-not-check, with a reason a freelancer can act on", async () => {
    const w = world(FERNLEA, { fixture: { anonymousRead: false } });
    expect(await reason(w.adapter.types())).toContain("does not show this to a visitor");
  });

  it("a 404, a 5xx, a redirect, text and a list that is not a list are could-not-check", async () => {
    expect(await reason(world(FERNLEA, { wrap: fixed(404, "{}") }).adapter.types())).toContain(
      "404",
    );
    expect(await reason(world(FERNLEA, { wrap: fixed(503, "{}") }).adapter.types())).toContain(
      "503",
    );
    expect(
      await reason(
        world(FERNLEA, {
          wrap: fixed(302, "", { location: "https://elsewhere.example/" }),
        }).adapter.types(),
      ),
    ).toContain("redirect");
    expect(
      await reason(world(FERNLEA, { wrap: fixed(200, "not json") }).adapter.types()),
    ).toContain("not JSON");
    expect(await reason(world(FERNLEA, { wrap: fixed(200, "[]") }).adapter.types())).toContain(
      "not an object",
    );
    expect(
      await reason(world(FERNLEA, { wrap: fixed(200, '{"data":{}}') }).adapter.types()),
    ).toContain("not a list");
  });

  it("an empty list is an empty type (count 0), not an error", async () => {
    const w = world([], { settings: { id: "drupal", urls: { "node--article": "/n/{id}" } } });
    expect(await w.adapter.types()).toEqual([{ name: "node--article", count: 0 }]);
  });

  it("a short Retry-After is waited out once; a long one, or a second, throws what was read", async () => {
    const w = world(FERNLEA, {
      wrap: (t) => rateLimited(t, { after: 0, times: 1, retryAfter: "2" }),
    });
    expect((await w.adapter.types()).length).toBe(2);
    expect(w.sleeps).toEqual([2000]);
    const slow = world(FERNLEA, {
      wrap: (t) => rateLimited(t, { after: 1, times: 1000, retryAfter: "3600" }),
    });
    const err: unknown = await slow.adapter.types().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterRateLimitedError);
    expect((err as AdapterRateLimitedError<{ name: string }[]>).partial.map((t) => t.name)).toEqual(
      ["node--article"],
    );
    expect(slow.sleeps).toEqual([]);
  });
});

describe("the Drupal adapter: the credential", () => {
  it("is never sent for a published read, and a published read needs none", async () => {
    const w = world(FERNLEA, { env: { DRUPAL_TOKEN: "" } });
    await w.adapter.types();
    expect(w.seen.every((s) => s.headers.authorization === undefined)).toBe(true);
    expect(await w.adapter.draftsReachable()).toBe("not-applicable");
  });

  it("a bearer token is sent in an Authorization header for the unpublished read, and only there", async () => {
    const w = world();
    expect(await w.adapter.draftsReachable()).toBe(true);
    expect(w.seen.length).toBeGreaterThan(0);
    for (const s of w.seen) {
      expect(s.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(s.url).not.toContain(KEY);
      expect(new URL(s.url).searchParams.get("filter[status]")).toBe("0");
    }
  });

  it("a user name and password are sent as Basic authentication, in the header only", async () => {
    const w = world(FERNLEA, {
      fixture: { credential: BASIC },
      env: { DRUPAL_TOKEN: "", DRUPAL_USER: BASIC.user, DRUPAL_PASSWORD: BASIC.password },
    });
    expect(await w.adapter.draftsReachable()).toBe(true);
    const want = `Basic ${Buffer.from(`${BASIC.user}:${BASIC.password}`).toString("base64")}`;
    for (const s of w.seen) {
      expect(s.headers.authorization).toBe(want);
      expect(s.url).not.toContain(KEY);
      expect(s.url).not.toContain(encodeURIComponent(BASIC.user));
    }
  });

  it("a token that Drupal does not accept is could-not-check and is blanked from the message", async () => {
    const w = world(FERNLEA, {
      fixture: { credential: { kind: "bearer", token: "another_token_value_123" } },
    });
    const why = await reason(w.adapter.draftsReachable());
    expect(why).toContain("DRUPAL_TOKEN");
    expect(why).not.toContain(KEY);
  });

  it("a token with a space, a line break or a non-ASCII character is never sent", async () => {
    for (const token of [
      `${KEY} x`,
      `${KEY}\nX-Evil: 1`,
      `${KEY}\u00e9`,
      `${KEY.slice(0, 6)}\r${KEY.slice(6)}`,
    ]) {
      const w = world(FERNLEA, { env: { DRUPAL_TOKEN: token } });
      const why = await reason(w.adapter.draftsReachable());
      expect(why).toContain("not a token");
      expect(w.seen).toEqual([]);
    }
  });

  it("a user name with a colon, or a password with a line break, is never sent", async () => {
    for (const [user, password] of [
      ["a:b", "pw"],
      ["a", "pw\nX-Evil: 1"],
      ["a", "p\u00E9"],
    ]) {
      const w = world(FERNLEA, {
        env: { DRUPAL_TOKEN: "", DRUPAL_USER: user!, DRUPAL_PASSWORD: password! },
      });
      expect(await reason(w.adapter.draftsReachable())).toContain("cannot be sent as Basic");
      expect(w.seen).toEqual([]);
    }
  });

  it("a token and a user name together, or a user name without a password, is could-not-check", async () => {
    const both = world(FERNLEA, { env: { DRUPAL_USER: "a", DRUPAL_PASSWORD: "b" } });
    expect(await reason(both.adapter.draftsReachable())).toContain("Set one credential");
    const half = world(FERNLEA, { env: { DRUPAL_TOKEN: "", DRUPAL_USER: "a" } });
    expect(await reason(half.adapter.draftsReachable())).toContain("must both be set");
  });

  it("is not sent over plain http", async () => {
    const w = world(FERNLEA, { env: { DRUPAL_URL: "http://fernlea-clinic.example" } });
    expect(await reason(w.adapter.draftsReachable())).toContain("not sent over plain http");
    expect(w.seen).toEqual([]);
  });

  it("is not sent anywhere after a redirect: a redirect is not followed, with or without it", async () => {
    const w = world(FERNLEA, {
      wrap: fixed(301, "", { location: "https://evil.example/jsonapi" }),
    });
    expect(await reason(w.adapter.draftsReachable())).toContain("redirect");
    // One request for each named type, all to the address in DRUPAL_URL: the Location was never asked for.
    expect(w.seen).toHaveLength(2);
    for (const s of w.seen) expect(new URL(s.url).host).toBe("fernlea-clinic.example");
  });

  it("draftsReachable needs the settings entry: a credential alone does not read unpublished nodes", async () => {
    const w = world(FERNLEA, { settings: { id: "drupal", urls: { "node--article": "/n/{id}" } } });
    expect(await reason(w.adapter.draftsReachable())).toContain("readUnpublished");
    expect(w.seen).toEqual([]);
  });

  it("a credential that lists no unpublished node is could-not-check, never a no", async () => {
    const w = world(FERNLEA, { fixture: { seesUnpublished: false } });
    expect(await reason(w.adapter.draftsReachable())).toContain("lists no unpublished node");
  });

  it("an unpublished node found under a published filter, or the reverse, is could-not-check", async () => {
    const w = world(FERNLEA, {
      wrap: (t) => (url, req) => {
        url.searchParams.set("filter[status]", "1");
        return t(url, req);
      },
    });
    expect(await reason(w.adapter.draftsReachable())).toContain(
      "published resource under the unpublished",
    );
  });
});

describe("the Drupal adapter: the unpublished nodes", () => {
  it("lists their ids and node numbers, per node type, and nothing else", async () => {
    const w = world();
    const got = await w.adapter.unpublishedReading();
    expect(got.map((g) => [g.type, g.state, g.nodes.map((n) => n.nid)])).toEqual([
      ["node--article", "read", ["3", "4"]],
      ["node--page", "read", ["6"]],
    ]);
    expect(got[0]?.nodes[0]).toEqual({
      id: "5f1c0a10-0000-4000-8000-000000000003",
      nid: "3",
      alias: "/news/staff-changes",
    });
    for (const marker of Object.values(DRUPAL_MARKERS))
      expect(JSON.stringify(got)).not.toContain(marker);
    for (const s of w.seen) {
      expect(
        new URL(s.url).searchParams.get(
          "fields[" + (s.url.includes("/page") ? "node--page" : "node--article") + "]",
        ),
      ).toBe("status,drupal_internal__nid,path");
    }
  });

  it("is not asked without the settings entry or without a credential", async () => {
    const off = world(FERNLEA, {
      settings: { id: "drupal", urls: { "node--article": "/n/{id}" } },
    });
    expect(await reason(off.adapter.unpublishedReading())).toContain("readUnpublished");
    const none = world(FERNLEA, { env: { DRUPAL_TOKEN: "" } });
    expect(await reason(none.adapter.unpublishedReading())).toContain("No credential is set");
    expect(off.seen).toEqual([]);
    expect(none.seen).toEqual([]);
  });

  it("a type that is not a node type is recorded as unsupported and is not asked", async () => {
    const w = world(FERNLEA, {
      settings: {
        ...SETTINGS,
        urls: { "taxonomy_term--tags": "/t/{id}", "node--page": "/p/{id}" },
      },
    });
    const got = await w.adapter.unpublishedReading();
    expect(got.map((g) => [g.type, g.state])).toEqual([
      ["node--page", "read"],
      ["taxonomy_term--tags", "unsupported"],
    ]);
  });

  it("a type the credential cannot read is recorded with its reason and the others are still read", async () => {
    const w = world(FERNLEA, {
      wrap: (t) => (url, req) => (url.pathname.endsWith("/page") ? answer(403, "{}") : t(url, req)),
    });
    const got = await w.adapter.unpublishedReading();
    expect(got.map((g) => g.state)).toEqual(["read", "unread"]);
    expect(got[1]?.reason).toContain("HTTP 403");
  });

  it("lists at most the cap of unpublished nodes a type and says there were more", async () => {
    const w = world(FERNLEA, { unpublishedCap: 1 });
    const got = await w.adapter.unpublishedReading();
    expect(got[0]?.nodes).toHaveLength(1);
    expect(got[0]?.more).toBe(true);
    expect(got[1]?.more).toBe(false);
  });

  it("an unpublished node with a node number that is not a number is could-not-check for its type", async () => {
    const w = world(FERNLEA, {
      wrap: (t) => async (url, req) => {
        const res = await t(url, req);
        const chunks: Buffer[] = [];
        for await (const c of res.body) chunks.push(Buffer.from(c as Buffer));
        const text = Buffer.concat(chunks)
          .toString()
          .replace(/"drupal_internal__nid":3\b/, '"drupal_internal__nid":"3/../4"');
        return { ...res, body: Readable.from([Buffer.from(text)]) };
      },
    });
    const got = await w.adapter.unpublishedReading();
    expect(got[0]?.state).toBe("unread");
    expect(got[0]?.reason).toContain("no node number");
  });

  it("a node address is made from a node number only", () => {
    const { adapter } = world();
    expect(adapter.nodeAddress("42")).toBe(`${DRUPAL_SITE}/node/42`);
    for (const bad of ["", "0", "4a", "../x", "4/5", "-1", "4?x", "1".repeat(13)]) {
      expect(() => adapter.nodeAddress(bad)).toThrow(AdapterCouldNotCheck);
    }
  });

  it("looks at one node again with the credential: unpublished stays true, published turns false", async () => {
    const w = world();
    expect(
      await w.adapter.stillUnpublished("node--article", "5f1c0a10-0000-4000-8000-000000000003"),
    ).toBe(true);
    expect(
      await w.adapter.stillUnpublished("node--article", "5f1c0a10-0000-4000-8000-000000000001"),
    ).toBe(false);
    for (const s of w.seen) expect(s.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(await reason(w.adapter.stillUnpublished("node--article", "../x"))).toContain(
      "not a Drupal resource id",
    );
    expect(
      await reason(
        w.adapter.stillUnpublished("node--article", "5f1c0a10-0000-4000-8000-0000000000ff"),
      ),
    ).toContain("404");
  });
});
