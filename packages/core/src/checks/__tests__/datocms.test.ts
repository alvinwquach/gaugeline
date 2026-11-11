import { describe, expect, it } from "vitest";
import { createDatocmsAdapter } from "../../adapters/datocms.js";
import { readDatocms, type DatocmsReading } from "../../adapters/datocms-read.js";
import {
  DATOCMS_COLLECTIONS,
  DATOCMS_MARKERS,
  datocmsTransport,
  type DatocmsFixtureOptions,
} from "../../adapters/__tests__/datocms-fixture.js";
import { rateLimited } from "../../adapters/__tests__/contract.js";
import type { AdapterSettings } from "../../adapters/types.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { DATOCMS_CHECKS, createDatocmsRegistry } from "../datocms.js";

const KEY = testKey("datocms-checks");

async function reading(
  options: {
    fixture?: DatocmsFixtureOptions;
    settings?: Partial<AdapterSettings>;
    wrap?: (t: ReturnType<typeof datocmsTransport>) => ReturnType<typeof datocmsTransport>;
  } = {},
): Promise<{ reading: DatocmsReading; seen: string[] }> {
  const seen: string[] = [];
  const base = datocmsTransport(undefined, {
    token: KEY,
    onRequest: (r) =>
      seen.push(`${r.method} ${r.url.pathname} drafts=${r.headers["x-include-drafts"] === "true"}`),
    ...options.fixture,
  });
  const fetcher = createFetcher({
    transport: options.wrap ? options.wrap(base) : base,
    timeoutMs: 5000,
  });
  const adapter = createDatocmsAdapter({
    env: { DATOCMS_TOKEN: KEY },
    fetcher,
    settings: {
      id: "datocms",
      collections: DATOCMS_COLLECTIONS,
      expectPublishedOnly: true,
      ...options.settings,
    },
    sleep: () => Promise.resolve(),
  });
  return { reading: await readDatocms({ adapter }), seen };
}

const run = (r: DatocmsReading) => runChecks(r, createDatocmsRegistry());
const evidence = (r: Awaited<ReturnType<typeof run>>): string[] =>
  r.findings.filter((f) => f.checkId === "datocms-drafts-reachable").map((f) => f.evidence);
const reasons = (r: Awaited<ReturnType<typeof run>>): string =>
  r.couldNotCheck.map((c) => `${c.id}: ${c.reason}`).join("\n");

describe("DatoCMS checks: drafts reachable with the published-only token", () => {
  it("a token that cannot read drafts has no finding, and the check passes", async () => {
    const { reading: r } = await reading({ fixture: { drafts: "refused" } });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.couldNotCheck).toEqual([]);
    expect(out.passed).toEqual(["datocms-drafts-reachable"]);
  });

  it("a draft the published token can read is a finding, naming the collection, the count and the id", async () => {
    const { reading: r } = await reading();
    const out = await run(r);
    expect(evidence(out)).toEqual([
      "classes: a request that asks for drafts returned 1 record that the published list does not have (id 1003)",
    ]);
    expect(out.passed).toEqual([]);
    // Collections that were accepted with nothing extra are could-not-check, never a pass.
    expect(reasons(out)).toMatch(/notices: .*no record that is not published/);
    expect(reasons(out)).toMatch(/teachers: .*no record that is not published/);
  });

  it("shows no text from the content: no field, no name, no summary", async () => {
    const { reading: r } = await reading();
    const printed = JSON.stringify([r, await run(r)]);
    for (const marker of Object.values(DATOCMS_MARKERS)) expect(printed).not.toContain(marker);
  });

  it("asks nothing and says so when the settings do not say the token is meant for published content only", async () => {
    const { reading: r, seen } = await reading({ settings: { expectPublishedOnly: undefined } });
    const out = await run(r);
    expect(seen).toEqual([]);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toMatch(/expectPublishedOnly/);
  });

  it("a draft read is only ever a POSTed query to the one endpoint, with ids only", async () => {
    const bodies: string[] = [];
    await reading({
      fixture: { onRequest: (r) => void bodies.push(`${r.method} ${r.url.href} ${r.body}`) },
    });
    for (const b of bodies) {
      expect(b.startsWith("POST https://graphql.datocms.com/ ")).toBe(true);
      expect(b).not.toMatch(/mutation|subscription/);
      expect(b).toContain("{ id }");
    }
  });

  it("a token that is accepted with nothing unpublished is could-not-check, not a pass", async () => {
    const { reading: r } = await reading({ fixture: { drafts: "ignored" } });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck.length).toBeGreaterThan(0);
  });

  it("a collection DatoCMS will not read is could-not-check for that part only; the others are still judged", async () => {
    const { reading: r } = await reading({
      fixture: { drafts: "refused" },
      settings: {
        collections: { ...DATOCMS_COLLECTIONS, events: { collection: "allEvents" } },
      },
    });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toMatch(/events: DatoCMS would not give this collection/);
    expect(reasons(out)).not.toMatch(/classes|notices|teachers/);
    expect(r.drafts.filter((d) => d.state === "refused")).toHaveLength(3);
  });

  it("a key that is not accepted at all is could-not-check for every collection and no finding", async () => {
    const fetcher = createFetcher({
      transport: datocmsTransport(undefined, { token: KEY }),
      timeoutMs: 5000,
    });
    const adapter = createDatocmsAdapter({
      env: { DATOCMS_TOKEN: "some-other-token-0123456789" },
      fetcher,
      settings: { id: "datocms", collections: DATOCMS_COLLECTIONS, expectPublishedOnly: true },
      sleep: () => Promise.resolve(),
    });
    const out = await run(await readDatocms({ adapter }));
    expect(out.findings).toEqual([]);
    expect(out.couldNotCheck.length).toBeGreaterThan(0);
    expect(reasons(out)).not.toContain("some-other-token-0123456789");
  });

  it("no collection named: could-not-check, and nothing is asked", async () => {
    const { reading: r, seen } = await reading({ settings: { collections: undefined } });
    const out = await run(r);
    expect(seen).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toMatch(/No collection is named/);
  });

  it("a rate limit that stays ends the read: what was read is judged and the rest is could-not-check", async () => {
    const { reading: r } = await reading({
      wrap: (t) => rateLimited(t, { after: 4, times: 1000 }),
    });
    const out = await run(r);
    expect(r.partial?.reason).toBe("rate-limited");
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toMatch(/slow down/);
  });

  it("a lot of draft records are counted whole and their ids are cut to five", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: String(5000 + i),
      slug: `s-${i}`,
      published: false,
      updatedAt: "2026-11-09T10:00:00.000Z",
      fields: {},
    }));
    const base = datocmsTransport([{ type: "classes", collection: "allClasses", records: many }], {
      token: KEY,
    });
    const adapter = createDatocmsAdapter({
      env: { DATOCMS_TOKEN: KEY },
      fetcher: createFetcher({ transport: base, timeoutMs: 5000 }),
      settings: {
        id: "datocms",
        collections: { classes: { collection: "allClasses" } },
        expectPublishedOnly: true,
      },
      sleep: () => Promise.resolve(),
    });
    const r = await readDatocms({ adapter });
    expect(r.drafts[0]).toMatchObject({ extra: 12 });
    expect(r.drafts[0]?.extraIds).toHaveLength(5);
    expect(evidence(await run(r))[0]).toContain("12 records");
  });

  it("the check is described in plain words", () => {
    for (const c of DATOCMS_CHECKS) {
      for (const text of [c.done, c.estimateChanges]) {
        expect(text).not.toMatch(/[`<>\n]/);
        expect(text.endsWith(".")).toBe(true);
      }
      expect(c.tech).toMatch(/POST/);
    }
  });
});
