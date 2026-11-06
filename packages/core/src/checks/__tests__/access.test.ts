import { describe, expect, it } from "vitest";
import { useCassette } from "../../../../testkit/src/index.js";
import {
  accessConfigSchema,
  resolveAccess,
  type AccessConfig,
  type AccessSettings,
} from "../../access/types.js";
import { classify, probeAccess, type AccessRead } from "../../access/probe.js";
import { ConfigError } from "../../errors.js";
import { createFetcher, type Hop, type Transport } from "../../fetcher.js";
import { createBudget } from "../../limits.js";
import type { CheckContext } from "../../model.js";
import { buildSnapshot } from "../../snapshot.js";
import { accessPublicRead } from "../access-public-read.js";
import { accessRoleScope } from "../access-role-scope.js";

const PROJECT = "https://gaugelinefixture.supabase.co";
const CUSTOMER = "4f9c2e1a-0b7d-4c3e-9a51-6d8e2f0b1c47";
// Placeholder values, read from a test environment: never real keys.
const ENV = {
  FIXTURE_ANON_KEY: "test-anon-key",
  FIXTURE_CUSTOMER_TOKEN: "test-customer-token",
  FIXTURE_CUSTOMER_ID: CUSTOMER,
};

const CONFIG: AccessConfig = accessConfigSchema.parse({
  provider: "supabase",
  url: PROJECT,
  anonKeyEnv: "FIXTURE_ANON_KEY",
  tables: [
    { name: "menu_items", public: true },
    { name: "orders", owner: "customer_id" },
  ],
  users: [
    { role: "customer", tokenEnv: "FIXTURE_CUSTOMER_TOKEN", userIdEnv: "FIXTURE_CUSTOMER_ID" },
  ],
});

const hop = (status: number, headers: Record<string, string> = {}): Hop => ({
  url: `${PROJECT}/rest/v1/orders?select=*`,
  status,
  headers,
  body: "",
  ms: 1,
});

interface Logged {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** The recorded project answers, with every request logged (method, address and header names). */
function recorded(log: Logged[] = []): Transport {
  const replay = useCassette("supabase-access", { mode: "replay" });
  return (url, req) => {
    log.push({ method: req.method, url: url.href, headers: req.headers });
    return replay(url, req);
  };
}

async function read(settings: AccessSettings, log: Logged[] = []): Promise<AccessRead> {
  return probeAccess({
    fetcher: createFetcher({ transport: recorded(log) }),
    budget: createBudget(),
    settings,
  });
}

const page = buildSnapshot([
  {
    url: "https://pop.example/",
    status: 200,
    headers: { "content-type": "text/html" },
    body: "<html></html>",
    ms: 1,
  },
]);
const ctxOf = (r: AccessRead): CheckContext => ({ warn: () => undefined, access: async () => r });

describe("access: unit (classifying each kind of response)", () => {
  it.each([
    [
      "200 with 42 rows",
      hop(200, { "content-range": "0-41/42" }),
      { state: "readable", count: 42 },
    ],
    ["206 partial", hop(206, { "content-range": "0-0/42" }), { state: "readable", count: 42 }],
    ["200 with 0 rows", hop(200, { "content-range": "*/0" }), { state: "empty", count: 0 }],
    ["401", hop(401), { state: "refused" }],
    ["403", hop(403), { state: "refused" }],
    ["404", hop(404), { state: "missing" }],
    ["200 with no count", hop(200), { state: "unknown" }],
    ["500", hop(500), { state: "unknown" }],
    ["no answer", undefined, { state: "unknown" }],
  ])("%s", (_name, h, want) => {
    expect(classify(h)).toEqual(want);
  });

  it("the config takes a project, the public key's variable, tables and test users; write probes are refused", () => {
    expect(CONFIG.tables).toHaveLength(2);
    const writes = accessConfigSchema.safeParse({
      provider: "supabase",
      url: PROJECT,
      anonKeyEnv: "FIXTURE_ANON_KEY",
      probeWrites: true,
    });
    expect(writes.error?.issues[0]?.message).toBe(
      "Gaugeline is read-only: it never inserts rows, so write probes are not supported",
    );
    expect(
      accessConfigSchema.safeParse({ provider: "supabase", url: PROJECT, anonKeyEnv: "anon key" })
        .success,
    ).toBe(false);
  });

  it("keys come from the environment; a missing one stops the run naming the variable, not a value", () => {
    const s = resolveAccess(CONFIG, ENV);
    expect(s.anonKey).toBe("test-anon-key");
    expect(s.users).toEqual([{ role: "customer", token: "test-customer-token", userId: CUSTOMER }]);
    const missing = () => resolveAccess(CONFIG, { ...ENV, FIXTURE_CUSTOMER_TOKEN: "" });
    expect(missing).toThrow(ConfigError);
    expect(missing).toThrow(
      "gaugeline.access.json: users.0.tokenEnv names FIXTURE_CUSTOMER_TOKEN, which is not set.",
    );
  });
});

describe("access: integration (recorded responses)", () => {
  it("an open table, a protected table and a signed-in user: columns and counts, never row values", async () => {
    const log: Logged[] = [];
    const r = await read(resolveAccess(CONFIG, ENV), log);
    expect(r.tables.map((t) => [t.name, t.kind, t.anon.state, t.anon.count])).toEqual([
      ["menu_items", "table", "readable", 12],
      ["newsletter", "table", "empty", 0],
      ["order_totals", "view", "readable", 7],
      ["orders", "table", "readable", 42],
      ["profiles", "table", "refused", undefined],
    ]);
    expect(r.roles).toEqual(["anonymous", "customer"]);

    const open = await accessPublicRead.run(page, ctxOf(r));
    expect(open.map((f) => [f.severity, f.evidence])).toEqual([
      [
        "high",
        "order_totals (a view): 7 rows readable without signing in; columns: day, orders, revenue",
      ],
      [
        "high",
        "orders: 42 rows readable without signing in; columns: id, created_at, customer_id, customer_email, total",
      ],
    ]);
    const scoped = await accessRoleScope.run(page, ctxOf(r));
    expect(scoped.map((f) => [f.severity, f.evidence])).toEqual([
      [
        "high",
        "as customer, orders: 3 rows whose customer_id is someone else's are readable; columns: id, created_at, customer_id, customer_email, total",
      ],
    ]);

    // Read-only, counts only: every request is a HEAD for a count or the GET of the schema.
    expect([...new Set(log.map((l) => l.method))].sort()).toEqual(["GET", "HEAD"]);
    for (const l of log.filter((x) => x.method === "HEAD"))
      expect(l.headers.prefer).toBe("count=exact");
    // The keys go in headers, never in an address, a finding or the read.
    for (const l of log) expect(l.url).not.toMatch(/test-anon-key|test-customer-token/);
    expect(JSON.stringify([open, scoped, r])).not.toMatch(/test-anon-key|test-customer-token/);
  });
});

describe("access: edge cases", () => {
  it("a table that is open but empty is no finding: it can't be told from one whose rules hide every row", async () => {
    const r = await read(resolveAccess(CONFIG, ENV));
    expect(r.tables.find((t) => t.name === "newsletter")?.anon.state).toBe("empty");
    const open = await accessPublicRead.run(page, ctxOf(r));
    expect(open.map((f) => f.evidence).join(" ")).not.toContain("newsletter");
  });

  it("a view is probed like a table and named as a view", async () => {
    const r = await read(resolveAccess(CONFIG, ENV));
    expect(r.tables.find((t) => t.name === "order_totals")).toMatchObject({
      kind: "view",
      columns: ["day", "orders", "revenue"],
    });
  });

  it("a project that exposes no tables: nothing probed, nothing found", async () => {
    const config = accessConfigSchema.parse({
      provider: "supabase",
      url: "https://gaugelinequiet.supabase.co",
      anonKeyEnv: "FIXTURE_ANON_KEY",
    });
    const log: Logged[] = [];
    const r = await read(resolveAccess(config, ENV), log);
    expect(r.tables).toEqual([]);
    expect(log.map((l) => l.method)).toEqual(["GET"]);
    expect(await accessPublicRead.run(page, ctxOf(r))).toEqual([]);
    expect(await accessRoleScope.run(page, ctxOf(r))).toEqual([]);
  });

  it("with no access settings, nothing is requested", async () => {
    expect(await accessPublicRead.run(page, { warn: () => undefined })).toEqual([]);
    expect(await accessRoleScope.run(page, { warn: () => undefined })).toEqual([]);
  });
});
