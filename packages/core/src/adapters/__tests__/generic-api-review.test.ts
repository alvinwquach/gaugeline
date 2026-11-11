import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFetcher, type Transport } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { adaptersConfigSchema } from "../config.js";
import { allAdapterEnvVars, copyAdapterEnv } from "../registry.js";
import {
  GENERIC_ENV,
  type GenericApiCollection,
  type GenericApiMapping,
} from "../generic-api-config.js";
import { createGenericApiAdapter } from "../generic-api.js";
import { AdapterCouldNotCheck } from "../types.js";

/** The independent review of C-14 (11 Nov 2026): each finding has its test here. */

const json = (body: unknown) =>
  Promise.resolve({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

const mini = (
  over: Partial<GenericApiCollection> = {},
  api: Partial<GenericApiMapping> = {},
): GenericApiMapping => ({
  endpoint: "https://cms.example/api",
  collections: {
    item: {
      path: "/items",
      items: "/data",
      pagination: { style: "none" },
      fields: { id: "/id", updatedAt: "/updated" },
      ...over,
    },
  },
  ...api,
});

function adapterFor(api: GenericApiMapping, transport: Transport) {
  const seen: string[] = [];
  const fetcher = createFetcher({
    transport: (url, req) => {
      seen.push(url.href);
      return transport(url, req);
    },
    timeoutMs: 5000,
  });
  const adapter = createGenericApiAdapter({
    env: { GAUGELINE_API_X_TOKEN: "review-test-value" },
    fetcher,
    sleep: () => Promise.resolve(),
    settings: { id: "generic-api", api },
  });
  return { adapter, seen };
}

const couldNot = async (p: Promise<unknown>): Promise<string> => {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AdapterCouldNotCheck);
  return (err as AdapterCouldNotCheck).reason;
};

const parse = (api: unknown) =>
  adaptersConfigSchema.safeParse({ adapters: [{ id: "generic-api", api }] });
const messages = (api: unknown): string => {
  const r = parse(api);
  return r.success ? "" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
};

const ROW = { id: "a", updated: "2026-01-01T00:00:00Z" };

describe("review 1: a mapping can name only GAUGELINE_API_ variables, never one Gaugeline uses itself", () => {
  const auth = (env: string) => ({ ...mini(), auth: { header: "Authorization", env } });

  it("refuses every variable Gaugeline reads, and accepts a GAUGELINE_API_ one", () => {
    for (const env of [
      "GAUGELINE_SLACK_WEBHOOK",
      "GAUGELINE_GITHUB_TOKEN",
      "GAUGELINE_VERCEL_TOKEN",
      "GAUGELINE_BASIC_AUTH",
      "GAUGELINE_POSTGRES_URL",
      "GAUGELINE_SUPABASE_KEY",
      "GAUGELINE_API",
      "GAUGELINE_API_",
      "GAUGELINE_API_lower",
      "GITHUB_TOKEN",
    ])
      expect(messages(auth(env)), env).toContain("auth.env");
    expect(parse(auth("GAUGELINE_API_SHOP_TOKEN")).success).toBe(true);
  });

  it("no variable the code itself reads can match the pattern (derived from the source, so a new one fails here)", () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const names = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (
          entry === "node_modules" ||
          entry === "dist" ||
          entry === "__tests__" ||
          entry.startsWith("generic-api")
        )
          continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry))
          for (const m of readFileSync(full, "utf8").matchAll(/\bGAUGELINE_[A-Z0-9_]+\b/g))
            names.add(m[0]);
      }
    };
    for (const pkg of readdirSync(root)) walk(join(root, pkg, "src"));
    expect(names.size).toBeGreaterThan(5);
    for (const name of names) expect(GENERIC_ENV.test(name), name).toBe(false);
  });
});

describe("review 2: what comes back as an id, a type or a slug is an identifier, not client text", () => {
  const read = (rows: unknown[], over: Partial<GenericApiCollection> = {}) => {
    const { adapter, seen } = adapterFor(mini(over), () => json({ data: rows }));
    return { adapter, seen };
  };

  it("a slug path that points at a paragraph is could-not-check, and the text is not in the reason", async () => {
    const body = "Our spring offer: book two sessions and the third is free";
    const { adapter } = read([{ ...ROW, body }], {
      fields: { id: "/id", slug: "/body", updatedAt: "/updated" },
    });
    const reason = await couldNot(collectPublished(adapter));
    expect(reason).toContain("slug");
    expect(reason).not.toContain("spring offer");
  });

  it("ids, slugs and types with spaces, markup, unicode or more than 128 characters are refused", async () => {
    for (const value of [
      "two words",
      "<b>x</b>",
      `caf${String.fromCharCode(233)}`,
      "a".repeat(129),
      "line\nbreak",
    ]) {
      for (const field of ["id", "slug", "type"] as const) {
        const { adapter } = read([{ ...ROW, slug: "ok", type: "ok", [field]: value }], {
          fields: { id: "/id", slug: "/slug", type: "/type", updatedAt: "/updated" },
        });
        const reason = await couldNot(collectPublished(adapter));
        expect(reason, `${field}=${JSON.stringify(value)}`).not.toContain(value);
      }
    }
  });

  it("plain identifiers pass, including uuids, dots, colons and 128 characters", async () => {
    const { adapter } = read(
      [
        { id: "5f1c0a10-0000-4000-8000-000000000001", updated: ROW.updated, slug: "a.b_c~d:e@f-g" },
        { id: "x".repeat(128), updated: ROW.updated, slug: "ok" },
      ],
      { fields: { id: "/id", slug: "/slug", updatedAt: "/updated" } },
    );
    expect((await collectPublished(adapter)).docs).toHaveLength(2);
  });

  it("a type from the answer is checked in types() too", async () => {
    const { adapter } = read([{ ...ROW, type: "Not a type!" }], {
      fields: { id: "/id", type: "/type", updatedAt: "/updated" },
    });
    expect(await couldNot(adapter.types())).toContain("type");
  });
});

describe("review 3: an address from the platform is a path starting with one slash", () => {
  const withUrl = (url: string) =>
    adapterFor(mini({ fields: { id: "/id", url: "/link", updatedAt: "/updated" } }), () =>
      json({ data: [{ ...ROW, link: url }] }),
    ).adapter;

  it("refuses protocol-relative and backslash forms, plain and percent-encoded", async () => {
    for (const bad of [
      "//evil.example/x",
      "/\\evil.example",
      "/%2fevil.example",
      "/%2Fevil.example",
      "/%5cevil.example",
      "/%5Cevil.example",
      "https://a.example//evil.example/x",
      "\\\\evil.example",
      "javascript:alert(1)",
      "/a b",
    ])
      expect(await couldNot(collectPublished(withUrl(bad))), bad).toContain("address");
  });

  it("keeps an ordinary path, with its query", async () => {
    const got = await collectPublished(withUrl("/news/spring/?page=2"));
    expect(got.docs[0]?.url).toBe("/news/spring/?page=2");
  });
});

describe("review 4: drafts and bootstrap cannot be combined with a GraphQL collection", () => {
  const gql = {
    path: undefined,
    graphql:
      "query($first: Int!, $skip: Int!) { posts(first: $first, skip: $skip) { id updated } }",
    items: "/data/posts",
    pagination: { style: "offset", limit: "first", offset: "skip", pageSize: 10 },
  } as const;

  it("drafts on a GraphQL collection is refused at config time", () => {
    const api = {
      ...mini(gql as unknown as Partial<GenericApiCollection>),
      drafts: { collection: "item", query: { status: "draft" } },
    };
    expect(messages(api)).toContain("drafts");
    expect(messages(api)).toContain("REST");
  });

  it("bootstrap with a GraphQL collection is refused at config time", () => {
    const api = {
      ...mini(gql as unknown as Partial<GenericApiCollection>),
      bootstrap: [{ param: "ref", path: "", value: "/ref" }],
    };
    expect(messages(api)).toContain("bootstrap");
  });
});

describe("review 5: the published guard cannot fail silently", () => {
  const guarded = (equals: string | number | boolean, rows: unknown[]) =>
    adapterFor(mini({ published: { path: "/status", equals } }), () => json({ data: rows }))
      .adapter;

  it("a path that matches no item on a page is could-not-check", async () => {
    const adapter = guarded("published", [
      { ...ROW, state: "published" },
      { ...ROW, id: "b", state: "published" },
    ]);
    const reason = await couldNot(collectPublished(adapter));
    expect(reason).toContain("published path matched no item");
  });

  it("is case-sensitive and compares primitives only", async () => {
    const rows = [
      { ...ROW, status: "published" },
      { ...ROW, id: "b", status: "Published" },
      { ...ROW, id: "c", status: ["published"] },
      { ...ROW, id: "d", status: { v: "published" } },
    ];
    expect((await collectPublished(guarded("published", rows))).docs.map((d) => d.id)).toEqual([
      "a",
    ]);
  });

  it("a number or a flag must be the same kind, not the same text", async () => {
    const rows = [
      { ...ROW, status: 1 },
      { ...ROW, id: "b", status: "1" },
    ];
    expect((await collectPublished(guarded(1, rows))).docs.map((d) => d.id)).toEqual(["a"]);
    const flags = [
      { ...ROW, status: true },
      { ...ROW, id: "b", status: "true" },
    ];
    expect((await collectPublished(guarded(true, flags))).docs.map((d) => d.id)).toEqual(["a"]);
  });
});

describe("review 6: request shapes that could write are refused in the mapping", () => {
  const withPath = (path: string) => mini({ path });
  const withQuery = (query: Record<string, string>) => mini({ query });

  it("a path with a write verb in it", () => {
    for (const verb of [
      "delete",
      "remove",
      "update",
      "create",
      "publish",
      "unpublish",
      "destroy",
      "purge",
      "archive",
      "restore",
      "import",
      "send",
      "submit",
    ]) {
      expect(messages(withPath(`/posts/${verb}`)), verb).toContain("collections.item.path");
      expect(messages(withPath(`/posts/${verb.toUpperCase()}`)), verb).toContain("path");
      expect(messages(withPath(`/posts/${verb}-all`)), `${verb}-all`).toContain("path");
    }
    expect(parse(withPath("/posts/published-items")).success).toBe(true);
    expect(
      messages({
        ...mini(),
        bootstrap: [{ param: "ref", path: "/api/delete", value: "/ref" }],
      }),
    ).toContain("bootstrap");
  });

  it("a method override, in a name or in a value", () => {
    for (const q of <Record<string, string>[]>[
      { method: "DELETE" },
      { _method: "PUT" },
      { "x-http-method-override": "DELETE" },
      { "X-Method-Override": "x" },
      { action: "delete" },
      { op: "PATCH" },
      { x: "post" },
    ])
      expect(messages(withQuery(q)), JSON.stringify(q)).not.toBe("");
    expect(parse(withQuery({ status: "published", depth: "0" })).success).toBe(true);
  });

  it("headers the transport or a proxy would act on", () => {
    for (const header of [
      "X-HTTP-Method-Override",
      "X-Method-Override",
      "Proxy-Authorization",
      "Range",
      "Accept-Encoding",
      "X-Forwarded-For",
      "X-Forwarded-Host",
      "Cookie",
      "Host",
    ])
      expect(
        messages({ ...mini(), auth: { header, env: "GAUGELINE_API_X_TOKEN" } }),
        header,
      ).toContain("auth.header");
  });

  it("a name that looks like a key is refused wherever a name goes", () => {
    for (const name of ["jwt", "bearer", "pat", "privateKey", "private_key", "myJwt", "x-pat"]) {
      expect(messages(withQuery({ [name]: "x" })), name).toContain("looks like a key");
      expect(
        messages(
          mini({
            pagination: { style: "offset", limit: name, offset: "offset", pageSize: 10 },
          }),
        ),
        `pagination ${name}`,
      ).not.toBe("");
      expect(
        messages(mini({ select: { param: name, always: ["id"] } })),
        `select ${name}`,
      ).not.toBe("");
      expect(
        messages({ ...mini(), bootstrap: [{ param: name, path: "", value: "/ref" }] }),
        `bootstrap ${name}`,
      ).not.toBe("");
    }
    expect(parse(withQuery({ path: "x", pattern: "y", patch_level: "1" })).success).toBe(true);
  });
});

describe("review 7: smaller bounds", () => {
  it("an endpoint with an encoded or plain dot segment is refused", () => {
    for (const endpoint of [
      "https://cms.example/api/%2e%2e/admin",
      "https://cms.example/api/%2E/x",
      "https://cms.example/api/..%2fadmin",
      "https://cms.example/api/../admin",
      "https://cms.example/a%5cb",
      "https://cms.example/a\\b",
    ])
      expect(messages({ ...mini(), endpoint }), endpoint).toContain("endpoint");
  });

  it("a page with more items than a page can hold is could-not-check", async () => {
    const rows = Array.from({ length: 1001 }, (_, n) => ({ id: `i${n}`, updated: ROW.updated }));
    const { adapter } = adapterFor(mini(), () => json({ data: rows }));
    expect(await couldNot(collectPublished(adapter))).toContain("more items than a page");
  });

  it("a cursor that is too long or not plain text is could-not-check", async () => {
    const api = mini({
      items: "/data/rows",
      pagination: { style: "cursor", cursor: "cursor", pageSize: 1, next: "/data/next" },
    });
    for (const next of ["c".repeat(501), "a b\nc"]) {
      const { adapter } = adapterFor(api, () => json({ data: { rows: [ROW], next } }));
      expect(await couldNot(collectPublished(adapter)), next.slice(0, 5)).toContain("cursor");
    }
  });
});

describe("the key reaches the adapter from the CLI's environment", () => {
  it("copies the variables a mapping may name and the adapters' own, and nothing else", () => {
    const own = allAdapterEnvVars();
    expect(own.length).toBeGreaterThan(0);
    // The adapters' own variables come from the registry, so a new adapter's variable needs no change here.
    const source: Record<string, string> = {
      GAUGELINE_API_HERON_TOKEN: "heron-value",
      GAUGELINE_SLACK_WEBHOOK: "slack-value",
      HOME: "/home/someone",
      SOME_OTHER_SECRET: "other-value",
    };
    for (const name of own) source[name] = `${name}-value`;
    const copied = Object.keys(copyAdapterEnv(source)).sort();
    expect(copied).toEqual([...new Set([...own, "GAUGELINE_API_HERON_TOKEN"])].sort());
    for (const name of ["GAUGELINE_SLACK_WEBHOOK", "HOME", "SOME_OTHER_SECRET"])
      expect(copied, name).not.toContain(name);
  });
});
