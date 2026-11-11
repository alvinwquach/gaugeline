import { afterEach, describe, expect, it, vi } from "vitest";
import { collectPublished } from "../collect.js";
import { BUILT_ADAPTERS } from "../registry.js";
import { AdapterCouldNotCheck, AdapterRateLimitedError, KEY_KINDS } from "../types.js";
import type { PublishedDoc } from "../types.js";
import { isVerified } from "../../fetch/read-only-query.js";
import {
  allowlistProblems,
  rateLimited,
  rateLimitedAs403,
  refusing,
  requestProblems,
  world,
  type ContractEntry,
  type Seen,
} from "./contract.js";
import { ENTRIES } from "./entries.js";

afterEach(() => vi.restoreAllMocks());

const HEX = /^[0-9a-f]{16}$/;
const DOC_KEYS = new Set(["id", "type", "url", "slug", "publishedAt", "updatedAt", "fieldHashes"]);

/** Everything an adapter says in one run, as text: results and the messages of what it throws. */
async function everything(
  entry: ContractEntry,
): Promise<{ text: string; seen: string[]; requests: Seen[] }> {
  const { adapter, seen } = world(entry);
  const parts: unknown[] = [adapter.describe(), await adapter.types()];
  const fields = entry.expected.fields;
  if (fields) parts.push(await adapter.fieldCounts(fields.type, [fields.missing]));
  else
    parts.push(
      await adapter.fieldCounts("any", ["a"]).then(
        () => "answered",
        (e: unknown) => (e instanceof AdapterCouldNotCheck ? e.reason : "failed"),
      ),
    );
  parts.push((await collectPublished(adapter, entry.expected.published.options)).docs);
  parts.push((await collectPublished(adapter)).docs);
  parts.push(await adapter.draftsReachable());
  return {
    text: JSON.stringify(parts),
    seen: seen.map((s) => `${s.method} ${s.url}`),
    requests: seen,
  };
}

describe.each(ENTRIES)("the adapter contract: $id", (entry) => {
  it("describes itself: a name, a docs page and one of the three key kinds", () => {
    const d = world(entry).adapter.describe();
    expect(d.name.trim()).not.toBe("");
    expect(d.docsUrl).toMatch(/^https:\/\//);
    expect(KEY_KINDS).toContain(d.keyKind);
    expect(world(entry).adapter.id).toBe(entry.id);
    expect(entry.id).toMatch(/^[a-z][a-z0-9-]{0,30}$/);
  });

  it("is registered, so a settings file can name it", () => {
    expect(BUILT_ADAPTERS.has(entry.id)).toBe(true);
    expect(BUILT_ADAPTERS.get(entry.id)?.describe).toEqual(world(entry).adapter.describe());
  });

  it("types() returns counts and names: whole numbers, nothing else", async () => {
    const got = await world(entry).adapter.types();
    expect(got).toEqual(entry.expected.types);
    for (const t of got) {
      expect(Object.keys(t).sort()).toEqual(["count", "name"]);
      expect(Number.isSafeInteger(t.count) && t.count >= 0).toBe(true);
    }
  });

  describe.runIf(entry.expected.fields !== undefined)("fields", () => {
    it("fieldCounts() counts the items that have each field", async () => {
      const { type, counts } = entry.expected.fields ?? { type: "", counts: {} };
      expect(await world(entry).adapter.fieldCounts(type, Object.keys(counts))).toEqual(counts);
    });

    it("a missing field counts 0, not an error", async () => {
      const { type, missing } = entry.expected.fields ?? { type: "", missing: "" };
      expect(await world(entry).adapter.fieldCounts(type, [missing])).toEqual({ [missing]: 0 });
    });

    it.runIf(entry.unknownType === undefined)(
      "a type with no items counts 0 for every field",
      async () => {
        const got = await world(entry).adapter.fieldCounts("nothing-of-this-type", ["a", "b"]);
        expect(got).toEqual({ a: 0, b: 0 });
      },
    );

    it.runIf(entry.unknownType === "could-not-check")(
      "a type the platform does not have is could-not-check and names the type, never zeros",
      async () => {
        const err: unknown = await world(entry)
          .adapter.fieldCounts("nothing-of-this-type", ["a", "b"])
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(err).toBeInstanceOf(AdapterCouldNotCheck);
        expect((err as AdapterCouldNotCheck).reason).toContain("nothing-of-this-type");
      },
    );
  });

  it.runIf(entry.expected.fields === undefined)(
    "a platform with no fields: fieldCounts() is could-not-check, not applicable, and asks for nothing",
    async () => {
      const w = world(entry);
      const err: unknown = await w.adapter.fieldCounts("any", ["a"]).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AdapterCouldNotCheck);
      expect((err as AdapterCouldNotCheck).reason).toMatch(/^Not applicable/);
      expect(w.seen).toEqual([]);
    },
  );

  it("published() gives fingerprints: ids, times and hashes, in a stable order", async () => {
    const { options, ids } = entry.expected.published;
    const docs = (await collectPublished(world(entry).adapter, options)).docs;
    expect(docs.map((d) => d.id)).toEqual(ids);
    for (const d of docs) {
      expect(Object.keys(d).every((k) => DOC_KEYS.has(k))).toBe(true);
      // A platform that does not say when an item changed (a sitemap with no lastmod) leaves it out.
      if (d.updatedAt !== undefined) expect(Number.isNaN(Date.parse(d.updatedAt))).toBe(false);
      else expect(entry.expected.fields).toBeUndefined();
      for (const [field, hash] of Object.entries(d.fieldHashes)) {
        expect(hash).toMatch(HEX);
        expect(Object.values(options.fields ?? {}).flat()).toContain(field);
      }
    }
  });

  it("the same content gives the same hashes on a second run", async () => {
    const { options } = entry.expected.published;
    const a = (await collectPublished(world(entry).adapter, options)).docs;
    const b = (await collectPublished(world(entry).adapter, options)).docs;
    expect(b).toEqual(a);
  });

  it("a field the item does not have is left out of fieldHashes, never hashed as empty", async () => {
    const { options } = entry.expected.published;
    const docs = (await collectPublished(world(entry).adapter, options)).docs;
    const sizes = new Set(docs.map((d) => Object.keys(d.fieldHashes).length));
    // A platform with fields: some item lacks a configured field in every recorded dataset, so the
    // sizes differ. A platform with none: every fieldHashes is empty, even when fields are asked for.
    if (entry.expected.fields === undefined) {
      const asked = Object.fromEntries(
        (await world(entry).adapter.types()).map((t) => [t.name, ["title"]]),
      );
      const again = (await collectPublished(world(entry).adapter, { ...options, fields: asked }))
        .docs;
      for (const d of [...docs, ...again]) expect(d.fieldHashes).toEqual({});
    } else expect(sizes.size).toBeGreaterThan(1);
  });

  it("with no fields configured, no field value is asked for at all", async () => {
    const { adapter, seen } = world(entry);
    const types = (await adapter.types()).map((t) => t.name);
    await collectPublished(adapter, { types });
    const asked = decodeURIComponent(seen.map((s) => s.url).join("\n"));
    for (const secret of entry.secrets) expect(asked).not.toContain(secret);
    expect(asked).not.toMatch(/"h0"/);
  });

  it("never returns or sends a field value, a draft, or the key", async () => {
    const { text, seen } = await everything(entry);
    for (const secret of entry.secrets) expect(text).not.toContain(secret);
    if (entry.key !== undefined) {
      expect(text).not.toContain(entry.key);
      for (const line of seen) expect(line).not.toContain(entry.key);
    }
  });

  it.runIf(entry.key !== undefined)(
    "the key travels in a header, never in an address",
    async () => {
      const { adapter, seen } = world(entry);
      await adapter.types();
      expect(seen.length).toBeGreaterThan(0);
      for (const s of seen) {
        expect(s.url).not.toContain(entry.key ?? "");
        if (entry.keyHeaders) {
          expect(s.headers.authorization ?? "").toBe("");
          for (const [name, value] of Object.entries(entry.keyHeaders))
            expect(s.headers[name]).toBe(value);
          for (const value of Object.values(entry.keyHeaders)) expect(s.url).not.toContain(value);
        } else
          expect(s.headers.authorization ?? "").toBe(entry.keyHeader ? "" : `Bearer ${entry.key}`);
      }
      if (!entry.keyHeader) return;
      // The key is sent, in this header and only here, for what needs it.
      const before = seen.length;
      await adapter.draftsReachable();
      const keyed = seen.slice(before);
      expect(keyed.length).toBeGreaterThan(0);
      for (const s of keyed) {
        expect(s.url).not.toContain(entry.key ?? "");
        expect(s.headers.authorization).toBe(entry.keyHeader.value);
      }
    },
  );

  it.runIf(entry.key === undefined)(
    "an adapter with no key says so, and sends no Authorization header and no cookie",
    async () => {
      expect(world(entry).adapter.describe().noKey).toBe(true);
      const { adapter, seen } = world(entry);
      await adapter.types();
      await collectPublished(adapter);
      expect(seen.length).toBeGreaterThan(0);
      for (const s of seen) {
        expect(Object.keys(s.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
        expect(Object.keys(s.headers).map((h) => h.toLowerCase())).not.toContain("cookie");
      }
    },
  );

  it.runIf(entry.key !== undefined)(
    "an adapter that takes a key does not claim to have none",
    () => {
      expect(world(entry).adapter.describe().noKey).toBeUndefined();
    },
  );

  it("draftsReachable() says whether the key can reach unpublished work", async () => {
    expect(await world(entry).adapter.draftsReachable()).toBe(entry.expected.draftsReachable);
  });

  it("declares an allowlist that is well formed and documented (none is fine for a GET-only adapter)", () => {
    const allows = entry.queryAllow ?? [];
    expect(allowlistProblems(allows)).toEqual([]);
    for (const a of allows) {
      expect(new URL(a.docs.url).protocol).toBe("https:");
      // An entry the vendor's page was not read for is allowed, and says so (docs.checked: null).
      expect(isVerified(a)).toBe(a.docs.checked !== null);
    }
  });

  it("builds no request but GET or HEAD, a POST only to its allowlist, and no GraphQL mutation, whatever it is asked", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("an adapter must use the fetcher"));
    const { seen, requests } = await everything(entry);
    expect(seen.length).toBeGreaterThan(0);
    expect(requestProblems(requests, entry.queryAllow, entry.queryHosts)).toEqual([]);
    const w = world(entry);
    await w.adapter.types();
    expect(requestProblems(w.seen, entry.queryAllow, entry.queryHosts)).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("a key the platform refuses is could-not-check with a reason, never a pass or a leak", async () => {
    const { adapter } = world(entry, () => refusing(401));
    const calls: Array<() => Promise<unknown>> = [
      () => adapter.types(),
      () => adapter.fieldCounts(entry.expected.fields?.type ?? "any", ["a"]),
      () => collectPublished(adapter, entry.expected.published.options),
    ];
    // "not-applicable" is answered without asking anything, so a refusal never reaches it.
    if (entry.expected.draftsReachable !== "not-applicable")
      calls.push(() => adapter.draftsReachable());
    for (const call of calls) {
      const err: unknown = await call().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AdapterCouldNotCheck);
      const reason = (err as AdapterCouldNotCheck).reason;
      expect(reason.trim()).not.toBe("");
      if (entry.key !== undefined) expect(reason).not.toContain(entry.key);
    }
  });

  describe("rate limits", () => {
    it("a short Retry-After is waited out once and the read goes on", async () => {
      const { options } = entry.expected.published;
      const healthy = (await collectPublished(world(entry).adapter, options)).docs;
      const w = world(entry, (t) => rateLimited(t, { after: 0, times: 1, retryAfter: "2" }));
      const got = await collectPublished(w.adapter, options);
      expect(got.partial).toBeUndefined();
      expect(got.docs).toEqual(healthy);
      expect(w.sleeps).toEqual([2000]);
    });

    it("a limit that stays reports what was read, and where it stopped", async () => {
      const { options, succeedFirst, atLeast } = entry.rateLimit;
      const w = world(entry, (t) => rateLimited(t, { after: succeedFirst, times: 1000 }));
      const got = await collectPublished(w.adapter, options);
      expect(got.partial?.reason).toBe("rate-limited");
      expect(got.partial?.delivered).toBe(got.docs.length);
      expect(got.docs.length).toBeGreaterThanOrEqual(atLeast);
      expect(w.sleeps).toEqual([2000]);
    });

    it.runIf(entry.rateLimit.alsoAs403 === true)(
      "a limit sent as a 403 with x-ratelimit-remaining 0 is a rate limit with what was read, not a refused key",
      async () => {
        const { options, succeedFirst, atLeast } = entry.rateLimit;
        const w = world(entry, (t) => rateLimitedAs403(t, succeedFirst));
        const got = await collectPublished(w.adapter, options);
        expect(got.partial?.reason).toBe("rate-limited");
        expect(got.partial?.retry).toMatch(/^in \d+ seconds$/);
        expect(got.docs.length).toBeGreaterThanOrEqual(atLeast);
        const err: unknown = await world(entry, (t) => rateLimitedAs403(t, 1))
          .adapter.types()
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(err).toBeInstanceOf(AdapterRateLimitedError);
      },
    );

    it("types() and fieldCounts() throw the rate limit with what they had", async () => {
      const w = world(entry, (t) => rateLimited(t, { after: 1, times: 1000 }));
      const err: unknown = await w.adapter.types().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AdapterRateLimitedError);
      expect(Array.isArray((err as AdapterRateLimitedError).partial)).toBe(true);
    });

    it("a Retry-After longer than a minute is not waited for", async () => {
      const w = world(entry, (t) => rateLimited(t, { after: 0, times: 1000, retryAfter: "3600" }));
      const got = await collectPublished(w.adapter, entry.rateLimit.options);
      expect(got.partial?.reason).toBe("rate-limited");
      expect(got.docs).toEqual([]);
      expect(w.sleeps).toEqual([]);
    });
  });

  it.runIf(entry.members !== undefined)(
    "members() shows masked addresses and roles only",
    async () => {
      const members = entry.members;
      if (!members) return;
      const w = world(entry, () => members.transport());
      const got = await w.adapter.members?.();
      expect(got).toEqual(members.expected);
      const text = JSON.stringify(got);
      for (const address of members.addresses) expect(text).not.toContain(address);
      expect(requestProblems(w.seen, entry.queryAllow, entry.queryHosts)).toEqual([]);
    },
  );
});

describe("the suite itself", () => {
  it("every built adapter has an entry, so none skips the contract", () => {
    expect([...BUILT_ADAPTERS.keys()].sort()).toEqual(ENTRIES.map((e) => e.id).sort());
  });

  it("refuses a POST, a PUT and a GraphQL mutation or subscription", () => {
    const seen = (method: string, url: string) => ({ method, url, headers: {} });
    expect(
      requestProblems([seen("GET", "https://x.example/a"), seen("HEAD", "https://x.example/b")]),
    ).toEqual([]);
    expect(requestProblems([seen("POST", "https://x.example/a")])).toHaveLength(1);
    expect(requestProblems([seen("PUT", "https://x.example/a")])).toHaveLength(1);
    const gql = (q: string) => `https://x.example/graphql?query=${encodeURIComponent(q)}`;
    expect(requestProblems([seen("GET", gql("{ posts { id } }"))])).toEqual([]);
    expect(requestProblems([seen("GET", gql("query Posts { posts { id } }"))])).toEqual([]);
    expect(
      requestProblems([seen("GET", gql("mutation { deletePost(id: 1) { id } }"))]),
    ).toHaveLength(1);
    expect(requestProblems([seen("GET", gql("  Mutation Delete { x }"))])).toHaveLength(1);
    expect(requestProblems([seen("GET", gql("subscription { posts { id } }"))])).toHaveLength(1);
  });

  it("a document is a plain record of strings and a map of hashes", () => {
    const doc: PublishedDoc = {
      id: "a",
      type: "t",
      updatedAt: "2026-01-01T00:00:00.000Z",
      fieldHashes: {},
    };
    expect(Object.keys(doc).sort()).toEqual(["fieldHashes", "id", "type", "updatedAt"]);
  });
});
