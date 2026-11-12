import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createPayloadAdapter } from "../../adapters/payload.js";
import { readPayload, type PayloadReading } from "../../adapters/payload-read.js";
import {
  API_URL,
  PAYLOAD_MARKERS,
  QUILLON,
  QUILLON_URLS,
  payloadTransport,
  type PayloadFixtureCollection,
  type PayloadFixtureOptions,
} from "../../adapters/__tests__/payload-fixture.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { PAYLOAD_CHECKS, createPayloadRegistry } from "../payload.js";

const KEY = testKey("payload-checks");

async function reading(
  content: readonly PayloadFixtureCollection[],
  options: {
    fixture?: PayloadFixtureOptions;
    privateCollections?: string[];
    ownerConsent?: boolean;
    transport?: Transport;
  } = {},
): Promise<{ reading: PayloadReading; seen: string[] }> {
  const seen: string[] = [];
  const fetcher = createFetcher({
    transport:
      options.transport ??
      payloadTransport(content, {
        key: KEY,
        onRequest: (method, url) => seen.push(`${method} ${url.href}`),
        ...options.fixture,
      }),
    timeoutMs: 5000,
  });
  const adapter = createPayloadAdapter({
    env: { PAYLOAD_URL: API_URL, PAYLOAD_API_KEY: KEY },
    fetcher,
    settings: {
      id: "payload",
      urls: QUILLON_URLS,
      privateCollections: options.privateCollections ?? ["wholesale-orders"],
    },
    sleep: () => Promise.resolve(),
  });
  return {
    reading: await readPayload({
      adapter,
      site: API_URL,
      ...(options.ownerConsent !== undefined ? { ownerConsent: options.ownerConsent } : {}),
    }),
    seen,
  };
}

const run = (r: PayloadReading) => runChecks(r, createPayloadRegistry());
const evidence = (r: Awaited<ReturnType<typeof run>>): string[] =>
  r.findings.filter((f) => f.checkId === "payload-collection-public").map((f) => f.evidence);
const reasons = (r: Awaited<ReturnType<typeof run>>): string =>
  r.couldNotCheck.map((c) => c.reason).join("\n");

const json = (status: number, body: unknown) =>
  Promise.resolve({
    status,
    headers: { "content-type": "application/json" },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
  });

describe("payload-collection-public: a probing check", () => {
  it("without consent nothing is asked as a visitor and the check says so", async () => {
    const { reading: r, seen } = await reading(QUILLON, {
      fixture: { publicRead: ["wholesale-orders"] },
    });
    expect(seen).toEqual([]);
    const out = await run(r);
    expect(evidence(out)).toEqual([]);
    expect(out.passed).not.toContain("payload-collection-public");
    expect(reasons(out)).toMatch(/--owner-consent/);
    expect(reasons(out)).toMatch(/sites you own or have permission to test/);
  });

  it("with consent, a marked collection a visitor can read is a finding with a count and no document", async () => {
    const { reading: r } = await reading(QUILLON, {
      ownerConsent: true,
      fixture: { publicRead: ["wholesale-orders"] },
    });
    const out = await run(r);
    expect(evidence(out)).toEqual([
      "wholesale-orders: a request with no key listed 2 documents, and gaugeline.adapters.json marks the collection private",
    ]);
    expect(out.findings[0]?.severity).toBe("high");
    expect(JSON.stringify(out)).not.toContain(PAYLOAD_MARKERS.order);
  });

  it("with consent, a closed collection passes", async () => {
    const { reading: r } = await reading(QUILLON, { ownerConsent: true });
    const out = await run(r);
    expect(out.passed).toContain("payload-collection-public");
    expect(out.findings).toEqual([]);
  });

  it("one document is said in the singular, and 'at least' when no count was reported", async () => {
    const one = QUILLON.map((c) =>
      c.slug === "wholesale-orders" ? { ...c, docs: c.docs.slice(0, 1) } : c,
    );
    const { reading: a } = await reading(one, {
      ownerConsent: true,
      fixture: { publicRead: ["wholesale-orders"] },
    });
    expect(evidence(await run(a))[0]).toMatch(/listed 1 document,/);
    const noCount: Transport = () => json(200, { docs: [{ id: "x" }] });
    const { reading: b } = await reading(QUILLON, { ownerConsent: true, transport: noCount });
    expect(evidence(await run(b))[0]).toMatch(/listed at least 1 document,/);
  });

  it("a public collection that is not marked private is never asked", async () => {
    const { reading: r, seen } = await reading(QUILLON, {
      ownerConsent: true,
      fixture: { publicRead: ["posts", "wholesale-orders"] },
    });
    expect(seen.every((s) => s.includes("/api/wholesale-orders"))).toBe(true);
    expect((await run(r)).findings.map((f) => f.evidence.split(":")[0])).toEqual([
      "wholesale-orders",
    ]);
  });

  it("with consent and nothing marked private it is could-not-check, never a pass", async () => {
    const { reading: r, seen } = await reading(QUILLON, {
      ownerConsent: true,
      privateCollections: [],
    });
    const out = await run(r);
    expect(seen).toEqual([]);
    expect(out.passed).not.toContain("payload-collection-public");
    expect(reasons(out)).toMatch(/no collection is marked private/);
  });

  it("an empty answer, a missing collection and a server error are could-not-check by name, each for its own collection", async () => {
    const empty = QUILLON.map((c) => (c.slug === "wholesale-orders" ? { ...c, docs: [] } : c));
    const { reading: a } = await reading(empty, {
      ownerConsent: true,
      fixture: { publicRead: ["wholesale-orders"] },
    });
    const outA = await run(a);
    expect(reasons(outA)).toMatch(/wholesale-orders: Payload answered a visitor with no documents/);
    expect(outA.passed).not.toContain("payload-collection-public");

    const { reading: b } = await reading(QUILLON, {
      ownerConsent: true,
      fixture: { publicRead: ["wholesale-orders"] },
      privateCollections: ["wholesale-orders", "wholesale-ordres"],
    });
    const outB = await run(b);
    expect(evidence(outB)).toHaveLength(1);
    expect(reasons(outB)).toMatch(
      /wholesale-ordres: not read \(HTTP 404.*spelling in privateCollections/,
    );

    const down: Transport = () => json(500, {});
    const { reading: c } = await reading(QUILLON, { ownerConsent: true, transport: down });
    const outC = await run(c);
    expect(reasons(outC)).toMatch(/wholesale-orders: not read \(Payload answered HTTP 500/);
    expect(outC.passed).not.toContain("payload-collection-public");
  });

  it("a firewall's 403 to the visitor is could-not-check with its reason, never a pass", async () => {
    const waf: Transport = () =>
      Promise.resolve({
        status: 403,
        headers: { "content-type": "text/html" },
        body: Readable.from([Buffer.from("<html>Attention Required</html>")]),
      });
    const { reading: r } = await reading(QUILLON, { ownerConsent: true, transport: waf });
    const out = await run(r);
    expect(out.passed).not.toContain("payload-collection-public");
    expect(reasons(out)).toMatch(/not Payload's refusal/);
  });

  it("a rate limit that stays marks the read partial and is could-not-check, with what was read kept", async () => {
    const real = payloadTransport(QUILLON, { publicRead: ["wholesale-orders"] });
    let n = 0;
    const limited: Transport = (url, req) =>
      ++n > 1
        ? Promise.resolve({
            status: 429,
            headers: { "retry-after": "600", "content-type": "application/json" },
            body: Readable.from([Buffer.from("{}")]),
          })
        : real(url, req);
    const { reading: r } = await reading(QUILLON, {
      ownerConsent: true,
      transport: limited,
      privateCollections: ["wholesale-orders", "events"],
    });
    expect(r.partial).toMatchObject({ reason: "rate-limited", delivered: 1 });
    const out = await run(r);
    expect(evidence(out)).toHaveLength(1);
    expect(reasons(out)).toMatch(/slow down/);
    expect(out.passed).not.toContain("payload-collection-public");
  });

  it("with consent, every request is a GET and carries no Authorization header", async () => {
    const headers: Array<string | undefined> = [];
    await reading(QUILLON, {
      ownerConsent: true,
      fixture: {
        publicRead: ["wholesale-orders"],
        onRequest: (method, url, h) => {
          expect(method).toBe("GET");
          if (url.pathname === "/api/wholesale-orders") headers.push(h.authorization);
        },
      },
    });
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.every((h) => h === undefined)).toBe(true);
  });

  it("is declared a probing check in its text, and the registry has it", () => {
    expect(PAYLOAD_CHECKS.map((c) => c.id)).toEqual(["payload-collection-public"]);
    const check = PAYLOAD_CHECKS[0];
    expect(check.tech).toMatch(/^probing check, off without --owner-consent/);
    expect(check.tech).toMatch(/sites you own or have permission to test/);
    for (const text of [check.done, check.estimateChanges]) {
      expect(text).not.toMatch(/[`<>\n]/);
      expect(text.endsWith(".")).toBe(true);
    }
    expect(
      createPayloadRegistry()
        .all()
        .map((c) => c.id),
    ).toEqual(["payload-collection-public"]);
  });
});
