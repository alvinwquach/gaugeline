import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../../fetcher.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { adapterHeader, collectPublished } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import { KONTENT_LIMITS, createKontentAdapter, type KontentAdapterOptions } from "../kontent-ai.js";
import { BUILT_ADAPTERS, PLANNED_ADAPTERS, createAdapters, resolveAdapters } from "../registry.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError } from "../types.js";
import { recording, requestProblems, type Seen } from "./contract.js";
import {
  DELIVERY_HOST,
  ENVIRONMENT_ID,
  FERNHILL,
  FERNHILL_SETTLED,
  FERNHILL_URLS,
  KONTENT_MARKERS,
  PREVIEW_HOST,
  kontentTransport,
  type KontentFixtureItem,
  type KontentFixtureOptions,
} from "./kontent-ai-fixture.js";

const SECURE = testKey("kontent-secure");
const PREVIEW = testKey("kontent-preview");
const ENV = { KONTENT_ENVIRONMENT_ID: ENVIRONMENT_ID };
const SETTINGS = { id: "kontent-ai", urls: { ...FERNHILL_URLS }, readPreview: true };

function over(
  options: {
    items?: readonly KontentFixtureItem[];
    fixture?: KontentFixtureOptions;
    env?: Record<string, string>;
    adapter?: Partial<KontentAdapterOptions>;
    transport?: Transport;
  } = {},
) {
  const seen: Seen[] = [];
  const fetcher = createFetcher({
    transport: recording(
      options.transport ?? kontentTransport(options.items ?? FERNHILL, options.fixture),
      seen,
    ),
    timeoutMs: 5000,
  });
  const adapter = createKontentAdapter({
    env: options.env ?? ENV,
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

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  }) as ReturnType<Transport>;

const tamper = (
  fn: (body: Record<string, unknown>, skip: number) => unknown,
): KontentFixtureOptions => ({
  tamper: (body, call) => fn(body, call.skip),
});

const pagination = (body: Record<string, unknown>): Record<string, unknown> =>
  body.pagination as Record<string, unknown>;

describe("Kontent.ai: published reads over the Delivery API", () => {
  it("counts the published items of each type, sorted by name", async () => {
    const { adapter } = over();
    expect(await adapter.types()).toEqual([
      { name: "article", count: 2 },
      { name: "offer", count: 1 },
    ]);
  });

  it("counts the items that have each field, and an empty element is not a value", async () => {
    const { adapter } = over();
    expect(await adapter.fieldCounts("article", ["title", "summary", "subtitle"])).toEqual({
      title: 2,
      summary: 1,
      subtitle: 0,
    });
    expect(await adapter.fieldCounts("no_such_type", ["title"])).toEqual({ title: 0 });
  });

  it("gives published items as fingerprints in codename order, with no draft and no text", async () => {
    const { adapter } = over({
      adapter: { settings: { ...SETTINGS, fingerprint: { article: ["title", "summary"] } } },
    });
    const got = (await collectPublished(adapter)).docs;
    expect(got.map((d) => d.id)).toEqual([
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
    expect(got[1]).toMatchObject({
      type: "article",
      slug: "spring-service",
      url: "/journal/spring-service",
      updatedAt: "2026-11-02T10:00:00.123Z",
    });
    expect(Object.keys(got[1]?.fieldHashes ?? {}).sort()).toEqual(["summary", "title"]);
    // An empty summary is a field the item does not have.
    expect(Object.keys(got[2]?.fieldHashes ?? {})).toEqual(["title"]);
    const text = JSON.stringify(got);
    for (const v of Object.values(KONTENT_MARKERS)) expect(text).not.toContain(v);
  });

  it("filters by type, by since and by limit", async () => {
    const { adapter } = over();
    expect((await collectPublished(adapter, { types: ["offer"] })).docs.map((d) => d.type)).toEqual(
      ["offer"],
    );
    expect((await collectPublished(adapter, { since: "2026-11-01T00:00:00Z" })).docs).toHaveLength(
      2,
    );
    expect((await collectPublished(adapter, { limit: 1 })).docs).toHaveLength(1);
    expect((await collectPublished(adapter, { limit: 0 })).docs).toHaveLength(0);
  });

  it("asks only the Delivery host, only with GET, in a fixed order, with the total, and no language", async () => {
    const { adapter, seen } = over({ adapter: { pageSize: 2 } });
    await adapter.types();
    expect(seen.length).toBe(2);
    for (const s of seen) {
      const url = new URL(s.url);
      expect(s.method).toBe("GET");
      expect(url.host).toBe(DELIVERY_HOST);
      expect(url.pathname).toBe(`/${ENVIRONMENT_ID}/items`);
      expect(url.searchParams.get("order")).toBe("system.codename[asc]");
      expect(url.searchParams.get("includeTotalCount")).toBe("true");
      expect(url.searchParams.get("limit")).toBe("2");
      expect(url.searchParams.has("language")).toBe(false);
      expect(s.headers.authorization).toBeUndefined();
    }
    expect(seen.map((s) => new URL(s.url).searchParams.get("skip"))).toEqual(["0", "2"]);
    expect(requestProblems(seen)).toEqual([]);
  });

  it("asks for the elements it needs and no others", async () => {
    const { adapter, seen } = over();
    await adapter.fieldCounts("article", ["title", "summary.value"]);
    expect(new URL(seen[0]?.url ?? "").searchParams.get("elements")).toBe("title,summary");
    const w = over({ adapter: { settings: { ...SETTINGS, slugElement: "slug" } } });
    await w.adapter.types();
    expect(new URL(w.seen[0]?.url ?? "").searchParams.get("elements")).toBe("slug");
  });

  it("the secure access key travels in an Authorization header and nowhere else", async () => {
    const w = over({
      fixture: { secureKey: SECURE },
      env: { ...ENV, KONTENT_SECURE_ACCESS_KEY: SECURE, KONTENT_PREVIEW_API_KEY: PREVIEW },
    });
    await w.adapter.types();
    await collectPublished(w.adapter);
    expect(w.seen.length).toBeGreaterThan(0);
    for (const s of w.seen) {
      expect(s.headers.authorization).toBe(`Bearer ${SECURE}`);
      expect(s.url).not.toContain(SECURE);
      expect(s.url).not.toContain(PREVIEW);
      expect(new URL(s.url).host).toBe(DELIVERY_HOST);
    }
  });

  it("a project with secure access and no key set is could-not-check and says what to set", async () => {
    const { adapter } = over({ fixture: { secureKey: SECURE } });
    const reason = await reasonOf(adapter.types());
    expect(reason).toContain("KONTENT_SECURE_ACCESS_KEY");
    expect(reason).toContain("HTTP 401");
  });

  it("a wrong key is could-not-check and never repeats the key", async () => {
    const wrong = testKey("kontent-wrong");
    const { adapter } = over({
      fixture: { secureKey: SECURE },
      env: { ...ENV, KONTENT_SECURE_ACCESS_KEY: wrong },
    });
    const reason = await reasonOf(collectPublished(adapter));
    expect(reason).not.toContain(wrong);
    expect(reason).toContain("KONTENT_SECURE_ACCESS_KEY");
  });

  it("describes itself as read-only with an optional key, and its header says so", () => {
    const d = over().adapter.describe();
    expect(d).toMatchObject({ name: "Kontent.ai", keyKind: "read-only", optionalKey: true });
    expect(adapterHeader(d)).toContain("Kontent.ai");
    expect(over().adapter.id).toBe("kontent-ai");
  });
});

describe("Kontent.ai: what is never sent", () => {
  const bad = [
    ["", "not set"],
    ["..", "not an environment id"],
    ["%2f..%2f", "not an environment id"],
    [`${ENVIRONMENT_ID}?x=1`, "not an environment id"],
    [`${ENVIRONMENT_ID}&limit=1`, "not an environment id"],
    [`${ENVIRONMENT_ID}[0]`, "not an environment id"],
    [`user:pass@${ENVIRONMENT_ID}`, "not an environment id"],
    [`${ENVIRONMENT_ID}/../x`, "not an environment id"],
    [`${ENVIRONMENT_ID}\nHost: evil.example`, "not an environment id"],
    ["5f1d2c7e-3b8a-4c1e-9d46-7a2b8e0f1c3", "not an environment id"],
  ] as const;

  it.each(bad)("an environment id of %j asks nothing", async (id, words) => {
    const { adapter, seen } = over({ env: { KONTENT_ENVIRONMENT_ID: id } });
    expect(await reasonOf(adapter.types())).toContain(words);
    expect(await reasonOf(collectPublished(adapter))).toContain(words);
    expect(seen).toEqual([]);
  });

  it.each(["abc def", "abc\r\nX-Evil: 1", "caf\u00E9", "abc\tdef"])(
    "a secure access key of %j asks nothing",
    async (key) => {
      const { adapter, seen } = over({ env: { ...ENV, KONTENT_SECURE_ACCESS_KEY: key } });
      const reason = await reasonOf(adapter.types());
      expect(reason).toContain("KONTENT_SECURE_ACCESS_KEY");
      expect(seen).toEqual([]);
    },
  );

  it.each(["Title", "a;b", "a,b", "a b", "", "x".repeat(51), "a/b", "a&b=1"])(
    "a field named %j is never put in an address",
    async (field) => {
      const { adapter, seen } = over();
      await reasonOf(adapter.fieldCounts("article", [field]));
      await reasonOf(
        collectPublished(adapter, { types: ["article"], fields: { article: [field] } }),
      );
      expect(seen).toEqual([]);
    },
  );

  it("an item id or type that is not text is could-not-check, never skipped", async () => {
    for (const mutate of [
      (i: Record<string, unknown>) => ((i.system as Record<string, unknown>).id = 7),
      (i: Record<string, unknown>) => ((i.system as Record<string, unknown>).type = null),
      (i: Record<string, unknown>) => delete i.system,
    ]) {
      const { adapter } = over({
        fixture: tamper((b) => {
          mutate((b.items as Record<string, unknown>[])[0] ?? {});
          return b;
        }),
      });
      expect(await reasonOf(adapter.types())).toContain("no id or no type");
    }
  });

  it("an item with no readable last_modified is could-not-check for published()", async () => {
    const { adapter } = over({
      fixture: tamper((b) => {
        const first = (b.items as { system: Record<string, unknown> }[])[0];
        if (first) first.system.last_modified = 12;
        return b;
      }),
    });
    expect(await reasonOf(collectPublished(adapter))).toContain("last_modified");
    // A count does not need the time.
    expect((await adapter.types()).length).toBe(2);
  });

  it("a redirect is not followed, so a key goes only where it was sent", async () => {
    const seen: Seen[] = [];
    const fetcher = createFetcher({
      transport: recording(
        (url) =>
          url.host === DELIVERY_HOST
            ? json(302, {}, { location: "https://elsewhere.example/steal" })
            : json(200, {}),
        seen,
      ),
      timeoutMs: 5000,
    });
    const adapter = createKontentAdapter({
      env: { ...ENV, KONTENT_SECURE_ACCESS_KEY: SECURE },
      fetcher,
      settings: SETTINGS,
      sleep: () => Promise.resolve(),
    });
    expect(await reasonOf(adapter.types())).toContain("redirect");
    expect(seen.map((s) => new URL(s.url).host)).toEqual([DELIVERY_HOST]);
  });
});

describe("Kontent.ai: a paginated read is checked against its total", () => {
  const many: KontentFixtureItem[] = Array.from({ length: 7 }, (_v, n) => ({
    id: `00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`,
    type: "article",
    codename: `post_${n}`,
    step: "published",
    published: true,
    modified: "2026-10-01T09:00:00Z",
    elements: { url: { type: "url_slug", value: `post-${n}` } },
  }));

  it("reads every page and stops at the total", async () => {
    const { adapter, seen } = over({ items: many, adapter: { pageSize: 3 } });
    expect(await adapter.types()).toEqual([{ name: "article", count: 7 }]);
    expect(seen.map((s) => new URL(s.url).searchParams.get("skip"))).toEqual(["0", "3", "6"]);
  });

  it("a total that moves between pages is could-not-check", async () => {
    const { adapter } = over({
      items: many,
      adapter: { pageSize: 3 },
      fixture: tamper((b, skip) => {
        if (skip > 0) pagination(b).total_count = 8;
        return b;
      }),
    });
    expect(await reasonOf(adapter.types())).toContain("changed while it was read");
  });

  it("a page that echoes another skip is could-not-check", async () => {
    const { adapter } = over({
      items: many,
      adapter: { pageSize: 3 },
      fixture: tamper((b, skip) => {
        if (skip > 0) pagination(b).skip = 0;
        return b;
      }),
    });
    expect(await reasonOf(adapter.types())).toContain("is not reliable");
  });

  it("a server that ignores skip repeats an item and is could-not-check", async () => {
    const { adapter } = over({
      items: many,
      adapter: { pageSize: 3 },
      transport: kontentTransport(many, {
        tamper: (b, call) => {
          if (call.skip > 0) {
            const first = kontentTransportRows(many, 3);
            b.items = first;
            pagination(b).skip = call.skip;
            pagination(b).count = first.length;
          }
          return b;
        },
      }),
    });
    expect(await reasonOf(adapter.types())).toContain("same item twice");
  });

  it("a count that is not the number of items in the page is could-not-check", async () => {
    const { adapter } = over({
      fixture: tamper((b) => {
        pagination(b).count = 99;
        return b;
      }),
    });
    expect(await reasonOf(adapter.types())).toContain("counted 99");
  });

  it("a list that stops before its total, an empty page, or no total at all is could-not-check", async () => {
    const stops = over({
      items: many,
      adapter: { pageSize: 3 },
      fixture: tamper((b, skip) => {
        if (skip > 0) {
          b.items = [];
          pagination(b).count = 0;
        }
        return b;
      }),
    });
    expect(await reasonOf(stops.adapter.types())).toContain("stopped after 3 of 7");
    const noTotal = over({
      fixture: tamper((b) => {
        delete pagination(b).total_count;
        return b;
      }),
    });
    expect(await reasonOf(noTotal.adapter.types())).toContain("total_count");
    const noPagination = over({
      fixture: tamper((b) => {
        delete b.pagination;
        return b;
      }),
    });
    expect(await reasonOf(noPagination.adapter.types())).toContain("pagination");
    const notList = over({
      fixture: tamper((b) => {
        b.items = {};
        return b;
      }),
    });
    expect(await reasonOf(notList.adapter.types())).toContain("not a list");
  });

  it("a next page after the last item, more items than asked for, or a total over the cap is could-not-check", async () => {
    const next = over({
      fixture: tamper((b) => {
        pagination(b).next_page = "https://example.invalid/more";
        return b;
      }),
    });
    expect(await reasonOf(next.adapter.types())).toContain("another page");
    const more = over({
      items: many,
      adapter: { pageSize: 3 },
      fixture: tamper((b) => {
        const rows = b.items as unknown[];
        b.items = [...rows, ...rows];
        pagination(b).count = (b.items as unknown[]).length;
        return b;
      }),
    });
    expect(await reasonOf(more.adapter.types())).toContain("asked for");
    const big = over({ items: many, adapter: { maxItems: 5 } });
    expect(await reasonOf(big.adapter.types())).toContain("more than 5");
    expect(KONTENT_LIMITS.items).toBe(10_000);
  });

  it("a refusal after the first page is could-not-check, never a count of what was read", async () => {
    const { adapter } = over({
      items: many,
      adapter: { pageSize: 3 },
      fixture: { respond: (c) => (c.n >= 1 ? { status: 401 } : undefined) },
    });
    expect(await reasonOf(adapter.types())).toContain("visitor with no key");
    const again = over({
      items: many,
      adapter: { pageSize: 3 },
      fixture: { respond: (c) => (c.n >= 1 ? { status: 500 } : undefined) },
    });
    expect(await reasonOf(collectPublished(again.adapter))).toContain("HTTP 500");
  });

  it("a rate limit that stays carries what was read; a short one is waited out", async () => {
    const waits: number[] = [];
    const limited = over({
      items: many,
      adapter: { pageSize: 3, sleep: (ms) => (waits.push(ms), Promise.resolve()) },
      fixture: {
        respond: (c) =>
          c.n === 0
            ? { status: 429, headers: { "retry-after": "2" } }
            : c.n >= 2
              ? { status: 429, headers: { "retry-after": "2" } }
              : undefined,
      },
    });
    const got = await collectPublished(limited.adapter);
    expect(got.partial?.reason).toBe("rate-limited");
    expect(got.docs).toHaveLength(3);
    expect(waits[0]).toBe(2000);
    const err: unknown = await limited.adapter.types().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterRateLimitedError);
  });

  it("an answer over the size limit is asked again with a smaller page", async () => {
    const sizes: number[] = [];
    const { adapter } = over({
      items: many,
      fixture: {
        respond: (c) => {
          sizes.push(c.limit);
          return c.limit > 50
            ? {
                status: 200,
                body: { items: [], padding: "x".repeat(6 * 1024 * 1024), pagination: {} },
              }
            : undefined;
        },
      },
    });
    expect(await adapter.types()).toEqual([{ name: "article", count: 7 }]);
    expect(sizes.slice(0, 2)).toEqual([100, 50]);
  });

  it("a 404 names the environment id; a status it does not know names only the status", async () => {
    const lost = over({ fixture: { respond: () => ({ status: 404 }) } });
    expect(await reasonOf(lost.adapter.types())).toContain("KONTENT_ENVIRONMENT_ID");
    const down = over({
      fixture: { respond: () => ({ status: 503, body: { message: KONTENT_MARKERS.sale } }) },
    });
    const reason = await reasonOf(down.adapter.types());
    expect(reason).toContain("HTTP 503");
    expect(reason).not.toContain(KONTENT_MARKERS.sale);
  });
});

/** The first rows of an ordered list, as the Delivery API shapes them (a server that ignores `skip` gives these every time). */
function kontentTransportRows(items: readonly KontentFixtureItem[], n: number): unknown[] {
  return [...items]
    .sort((a, b) => (a.codename < b.codename ? -1 : 1))
    .slice(0, n)
    .map((i) => ({
      system: { id: i.id, type: i.type, codename: i.codename, last_modified: i.modified },
      elements: i.elements,
    }));
}

describe("Kontent.ai: the preview read (a probing read)", () => {
  const WITH_KEYS = { ...ENV, KONTENT_SECURE_ACCESS_KEY: SECURE, KONTENT_PREVIEW_API_KEY: PREVIEW };
  const fixture = { secureKey: SECURE, previewKey: PREVIEW };

  it("asks nothing unless the settings say readPreview", async () => {
    const { adapter, seen } = over({
      env: WITH_KEYS,
      fixture,
      adapter: { settings: { id: "kontent-ai", urls: { ...FERNHILL_URLS } } },
    });
    expect(adapter.readPreviewAllowed()).toBe(false);
    expect(await reasonOf(adapter.unpublishedReading())).toContain("readPreview");
    expect(seen).toEqual([]);
  });

  it("lists the items the Preview API has and the Delivery API does not, by step", async () => {
    const { adapter, seen } = over({ env: WITH_KEYS, fixture });
    const got = await adapter.unpublishedReading();
    expect(got.state).toBe("read");
    expect(got.published).toBe(3);
    expect(got.entries.map((e) => [e.type, e.slug, e.step])).toEqual([
      ["article", "closing-sale", "draft"],
      ["article", "price-list-2025", "archived"],
      ["offer", "spring-ride-out", "scheduled"],
    ]);
    // A newer version in review is not unpublished: the Delivery API still lists the published one.
    expect(got.entries.map((e) => e.slug)).not.toContain("spring-service");
    expect(got.unclear).toBe(0);
    expect(JSON.stringify(got)).not.toContain(KONTENT_MARKERS.sale);
    expect(requestProblems(seen)).toEqual([]);
  });

  it("sends each key to its own host only, in a header, and never follows a redirect", async () => {
    const { adapter, seen } = over({ env: WITH_KEYS, fixture });
    await adapter.unpublishedReading();
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const s of seen) {
      const host = new URL(s.url).host;
      expect(s.headers.authorization).toBe(`Bearer ${host === PREVIEW_HOST ? PREVIEW : SECURE}`);
      expect(s.url).not.toContain(SECURE);
      expect(s.url).not.toContain(PREVIEW);
      expect([DELIVERY_HOST, PREVIEW_HOST]).toContain(host);
    }
    expect(seen.filter((s) => new URL(s.url).host === PREVIEW_HOST).length).toBe(1);
  });

  it.each([["published"], ["Draft Step"], [7], [null], [undefined]])(
    "an item whose step is %j and that only the Preview list has is never reported",
    async (step) => {
      const { adapter } = over({
        env: WITH_KEYS,
        fixture: {
          ...fixture,
          tamper: (b, call) => {
            if (call.host === PREVIEW_HOST)
              for (const r of b.items as { system: Record<string, unknown> }[])
                if (r.system.codename === "closing_sale") {
                  if (step === undefined) delete r.system.workflow_step;
                  else r.system.workflow_step = step;
                }
            return b;
          },
        },
      });
      const got = await adapter.unpublishedReading();
      expect(got.state).toBe("read");
      expect(got.entries.map((e) => e.slug)).toEqual(["price-list-2025", "spring-ride-out"]);
      expect(got.unclear).toBe(1);
    },
  );

  it("an item published between the reads is not a finding, and a list that changed is could-not-check", async () => {
    let deliveryCalls = 0;
    const racing = over({
      env: WITH_KEYS,
      fixture: {
        ...fixture,
        itemsFor: (host, all) => {
          if (host === PREVIEW_HOST) return all;
          deliveryCalls++;
          // The first Delivery read is before the publish and the second is after it.
          return all.filter(
            (i) => i.published || (deliveryCalls > 1 && i.codename === "closing_sale"),
          );
        },
      },
    });
    const got = await racing.adapter.unpublishedReading();
    expect(got.state).toBe("unread");
    expect(got.entries).toEqual([]);
    expect(got.reason).toContain("changed");
  });

  it("a Preview list that lacks a published item is not the Preview list", async () => {
    const { adapter } = over({
      env: WITH_KEYS,
      fixture: {
        ...fixture,
        itemsFor: (host, all) =>
          host === PREVIEW_HOST ? all.filter((i) => !i.published) : all.filter((i) => i.published),
      },
    });
    const got = await adapter.unpublishedReading();
    expect(got.state).toBe("unread");
    expect(got.reason).toContain("missing from the Preview API");
    expect(got.entries).toEqual([]);
  });

  it("a refused Preview key, or none, is never a pass", async () => {
    const other = testKey("kontent-other");
    const refused = over({ env: { ...WITH_KEYS, KONTENT_PREVIEW_API_KEY: other }, fixture });
    const got = await refused.adapter.unpublishedReading();
    expect(got.state).toBe("refused");
    expect(got.entries).toEqual([]);
    expect(got.reason).not.toContain(other);
    const none = over({ env: { ...ENV, KONTENT_SECURE_ACCESS_KEY: SECURE }, fixture });
    const noKey = await none.adapter.unpublishedReading();
    expect(noKey.state).toBe("unread");
    expect(noKey.reason).toContain("KONTENT_PREVIEW_API_KEY");
    expect(none.seen.every((s) => new URL(s.url).host === DELIVERY_HOST)).toBe(true);
  });

  it("a Delivery list that cannot be read is could-not-check for the whole read", async () => {
    const { adapter } = over({
      env: WITH_KEYS,
      fixture: {
        ...fixture,
        respond: (c) => (c.host === DELIVERY_HOST ? { status: 500 } : undefined),
      },
    });
    const got = await adapter.unpublishedReading();
    expect(got.state).toBe("unread");
    expect(got.reason).toContain("HTTP 500");
  });

  it("a rate limit is thrown with what was read, not turned into a pass", async () => {
    const { adapter } = over({
      env: WITH_KEYS,
      fixture: {
        ...fixture,
        respond: (c) => (c.host === PREVIEW_HOST ? { status: 429 } : undefined),
      },
    });
    const err: unknown = await adapter.unpublishedReading().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterRateLimitedError);
  });

  it("nothing waiting: the lists agree and nothing is left to ask a page about", async () => {
    const { adapter } = over({ env: WITH_KEYS, fixture, items: FERNHILL_SETTLED });
    const got = await adapter.unpublishedReading();
    expect(got).toMatchObject({
      state: "read",
      published: 6,
      entries: [],
      unlisted: 0,
      unclear: 0,
    });
  });

  it("a type with no address pattern is counted, not asked about; more than the page budget is counted too", async () => {
    const few = over({
      env: WITH_KEYS,
      fixture,
      adapter: { settings: { ...SETTINGS, urls: { article: "/journal/{slug}" } }, maxPages: 1 },
    });
    const got = await few.adapter.unpublishedReading();
    expect(got.entries).toHaveLength(1);
    expect(got.unlisted).toBe(1);
    expect(got.withoutPattern).toEqual([{ type: "offer", count: 1 }]);
  });

  it("a slug that is not plain, or a type that is not a codename, never reaches a finding", async () => {
    const odd = FERNHILL.map((i) =>
      i.codename === "closing_sale"
        ? {
            ...i,
            elements: { ...i.elements, url: { type: "url_slug", value: "sale\u001b[2J\nrow" } },
          }
        : i.codename === "old_price_list"
          ? { ...i, type: "Odd Type\n" }
          : i,
    );
    const got = await over({ env: WITH_KEYS, fixture, items: odd }).adapter.unpublishedReading();
    expect(got.state).toBe("read");
    expect(got.entries.find((e) => e.id.endsWith("0004"))?.slug).toBeUndefined();
    expect(got.unclear).toBe(1);
    const text = JSON.stringify(got);
    expect([...text].some((c) => c.charCodeAt(0) < 0x20)).toBe(false);
    expect(text).not.toContain("Odd Type");
  });

  it("a slug a published item of the same type also has is recorded as shared", async () => {
    const items = FERNHILL.map((i) =>
      i.codename === "closing_sale"
        ? { ...i, elements: { ...i.elements, url: { type: "url_slug", value: "spring-service" } } }
        : i,
    );
    const got = await over({ env: WITH_KEYS, fixture, items }).adapter.unpublishedReading();
    expect(got.sharedSlugs).toEqual([{ type: "article", slug: "spring-service" }]);
  });
});

describe("Kontent.ai: registry, settings and docs wiring", () => {
  it("is a built adapter with its describe and its docs page", () => {
    const built = BUILT_ADAPTERS.get("kontent-ai");
    expect(built?.describe.name).toBe("Kontent.ai");
    expect(built?.describe.docsUrl).toBe("https://gaugeline.dev/docs/integrations/kontent-ai");
    expect(PLANNED_ADAPTERS.some((p) => p.id === "kontent-ai")).toBe(false);
  });

  it("reads its three variables, and nothing else, from the environment", async () => {
    const seen: Seen[] = [];
    const fetcher = createFetcher({
      transport: recording(kontentTransport(FERNHILL, {}), seen),
      timeoutMs: 5000,
    });
    const config = adaptersConfigSchema.parse({
      adapters: [{ id: "kontent-ai", urls: { ...FERNHILL_URLS } }],
    });
    expect(resolveAdapters(config).map((b) => b.id)).toEqual(["kontent-ai"]);
    const [adapter] = await createAdapters(config, { env: ENV, fetcher });
    expect(adapter?.id).toBe("kontent-ai");
    expect(await adapter?.types()).toHaveLength(2);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("accepts readPreview and slugElement for this adapter only, and only an element codename", () => {
    const ok = adaptersConfigSchema.safeParse({
      adapters: [
        {
          id: "kontent-ai",
          readPreview: true,
          slugElement: "slug_url",
          urls: { article: "/a/{slug}" },
        },
      ],
    });
    expect(ok.success).toBe(true);
    for (const bad of ["Slug", "a/b", "a,b", "a b", "", "x".repeat(51), "a?b"]) {
      expect(
        adaptersConfigSchema.safeParse({ adapters: [{ id: "kontent-ai", slugElement: bad }] })
          .success,
      ).toBe(false);
    }
    expect(
      adaptersConfigSchema.safeParse({ adapters: [{ id: "payload", readPreview: true }] }).success,
    ).toBe(false);
    expect(
      adaptersConfigSchema.safeParse({ adapters: [{ id: "hygraph", slugElement: "url" }] }).success,
    ).toBe(false);
  });
});
