import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createDirectusAdapter } from "../../adapters/directus.js";
import { readDirectus, type DirectusReading } from "../../adapters/directus-read.js";
import {
  CMS_URL,
  DIRECTUS_MARKERS,
  DIRECTUS_SITE,
  LARKSPUR,
  LARKSPUR_SETTLED,
  PAGES_DRIFT,
  PAGES_HEALTHY,
  directusTransport,
  type DirectusFixtureCollection,
  type DirectusFixtureOptions,
} from "../../adapters/__tests__/directus-fixture.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { DIRECTUS_CHECKS, createDirectusRegistry } from "../directus.js";

const KEY = testKey("directus-checks");
const URLS = {
  classes: "/classes/{slug}",
  notices: "/notices/{slug}",
  teachers: "/teachers/{slug}",
};
/** The notices have pages in these tests, so a clean site really is clean. */
const NOTICE_PAGES = { "/notices/closed-last-friday": 200 };

async function reading(
  content: readonly DirectusFixtureCollection[],
  pages: Readonly<Record<string, number>>,
  options: {
    fixture?: DirectusFixtureOptions;
    urls?: Record<string, string>;
    privateCollections?: string[];
    ownerConsent?: boolean;
  } = {},
): Promise<{ reading: DirectusReading; seen: string[] }> {
  const seen: string[] = [];
  const fetcher = createFetcher({
    transport: directusTransport(content, {
      token: KEY,
      pages: { ...NOTICE_PAGES, ...pages },
      onRequest: (method, url) => seen.push(`${method} ${url.href}`),
      ...options.fixture,
    }),
    timeoutMs: 5000,
  });
  const adapter = createDirectusAdapter({
    env: { DIRECTUS_URL: CMS_URL, DIRECTUS_TOKEN: KEY },
    fetcher,
    settings: {
      id: "directus",
      urls: options.urls ?? URLS,
      privateCollections: options.privateCollections ?? ["appointments"],
    },
    sleep: () => Promise.resolve(),
  });
  return {
    reading: await readDirectus({
      adapter,
      fetcher,
      site: DIRECTUS_SITE,
      ...(options.ownerConsent !== undefined ? { ownerConsent: options.ownerConsent } : {}),
    }),
    seen,
  };
}

const run = (r: DirectusReading) => runChecks(r, createDirectusRegistry());
const evidence = (r: Awaited<ReturnType<typeof run>>, id: string): string[] =>
  r.findings.filter((f) => f.checkId === id).map((f) => f.evidence);

describe("Directus checks: a studio whose CMS and front end have drifted", () => {
  it("finds the published class with no page, and nothing else", async () => {
    const { reading: r } = await reading(LARKSPUR, PAGES_DRIFT, { ownerConsent: true });
    const out = await run(r);
    expect(evidence(out, "directus-entry-no-page")).toEqual([
      "classes: evening-stretch is published in Directus and /classes/evening-stretch answers 404",
    ]);
    expect(out.passed).toContain("directus-collection-public");
    expect(JSON.stringify(out)).not.toContain(DIRECTUS_MARKERS.retreat);
  });

  it("a healthy studio passes both checks, and a draft with no page is not a finding", async () => {
    const { reading: r } = await reading(LARKSPUR, PAGES_HEALTHY, { ownerConsent: true });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.couldNotCheck).toEqual([]);
    expect(out.passed.sort()).toEqual(["directus-collection-public", "directus-entry-no-page"]);
  });

  it("a settled studio reads the same", async () => {
    const { reading: r } = await reading(LARKSPUR_SETTLED, {
      ...PAGES_HEALTHY,
      "/classes/autumn-retreat": 200,
    });
    expect((await run(r)).findings).toEqual([]);
  });

  it("a 5xx or a timeout on a page is could-not-check for that page, not a finding or a pass", async () => {
    const { reading: r } = await reading(LARKSPUR, { ...PAGES_HEALTHY, "/teachers/ana": 503 });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(
      /the page was not read \(the site answered 503\)/,
    );
    expect(out.passed).not.toContain("directus-entry-no-page");
  });
});

describe("directus-entry-no-page: every part that cannot be checked is named", () => {
  it("no collection named: nothing is read and the check is could-not-check, never a pass", async () => {
    const { reading: r, seen } = await reading(LARKSPUR, {}, { urls: {}, ownerConsent: false });
    const out = await run(r);
    expect(seen).toEqual([]);
    expect(out.passed).not.toContain("directus-entry-no-page");
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(/No collection is named/);
  });

  it("a collection the token may not read is named, and the others are still checked", async () => {
    const { reading: r } = await reading(LARKSPUR, PAGES_DRIFT, {
      fixture: { denied: ["teachers"] },
    });
    const out = await run(r);
    expect(evidence(out, "directus-entry-no-page")).toHaveLength(1);
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(
      /teachers: Directus would not give/,
    );
    expect(out.passed).not.toContain("directus-entry-no-page");
  });

  it("a collection with published items and no address pattern is named and not asked", async () => {
    const { reading: r, seen } = await reading(LARKSPUR, PAGES_HEALTHY, {
      urls: { classes: "/classes/{slug}", teachers: "/teachers/{slug}", notices: "" },
    });
    expect(seen.some((s) => s.includes("larkspur-yoga.example/notices"))).toBe(false);
    const out = await run(r);
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(
      /notices: its pages were not checked/,
    );
  });

  it("an item with no slug that the pattern needs is named", async () => {
    const content = LARKSPUR.map((c) =>
      c.name === "teachers"
        ? { ...c, items: c.items.map((i) => ({ ...i, fields: { name: "x" } })) }
        : c,
    );
    const { reading: r } = await reading(content, PAGES_HEALTHY);
    const out = await run(r);
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(
      /item t-ana was not checked, because it has no slug/,
    );
  });

  it("a pattern that points to another site is not asked", async () => {
    const { reading: r, seen } = await reading(LARKSPUR, PAGES_HEALTHY, {
      urls: { ...URLS, classes: "https://elsewhere.example/c/{slug}" },
    });
    expect(seen.some((s) => s.includes("elsewhere.example"))).toBe(false);
    expect((await run(r)).couldNotCheck.map((c) => c.reason).join("\n")).toMatch(/another site/);
  });

  it("a page budget that runs out is said, not skipped quietly", async () => {
    const fetcher = createFetcher({
      transport: directusTransport(LARKSPUR, {
        token: KEY,
        pages: { ...NOTICE_PAGES, ...PAGES_HEALTHY },
      }),
      timeoutMs: 5000,
    });
    const adapter = createDirectusAdapter({
      env: { DIRECTUS_URL: CMS_URL, DIRECTUS_TOKEN: KEY },
      fetcher,
      settings: { id: "directus", urls: URLS },
      sleep: () => Promise.resolve(),
    });
    const r = await readDirectus({ adapter, fetcher, site: DIRECTUS_SITE, maxPages: 2 });
    const out = await run(r);
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(
      /3 pages were not asked for, because a run asks for at most 2/,
    );
    expect(out.passed).not.toContain("directus-entry-no-page");
  });

  it("a rate limit that stays marks the read partial and is could-not-check for both checks", async () => {
    const real = directusTransport(LARKSPUR, { token: KEY, pages: PAGES_HEALTHY });
    let n = 0;
    const fetcher = createFetcher({
      transport: (url, req) =>
        url.host === "cms.larkspur-yoga.example" && ++n > 1
          ? Promise.resolve({
              status: 429,
              headers: { "retry-after": "600" },
              body: (async function* () {})() as never,
            })
          : real(url, req),
      timeoutMs: 5000,
    });
    const adapter = createDirectusAdapter({
      env: { DIRECTUS_URL: CMS_URL, DIRECTUS_TOKEN: KEY },
      fetcher,
      settings: { id: "directus", urls: URLS, privateCollections: ["appointments"] },
      sleep: () => Promise.resolve(),
    });
    const r = await readDirectus({ adapter, fetcher, site: DIRECTUS_SITE, ownerConsent: true });
    expect(r.partial).toBeDefined();
    const out = await run(r);
    expect(out.passed).not.toContain("directus-entry-no-page");
    expect(out.passed).not.toContain("directus-collection-public");
  });
});

describe("directus-collection-public: a probing check", () => {
  it("without consent nothing is asked as a visitor and the check says so", async () => {
    const { reading: r, seen } = await reading(LARKSPUR, PAGES_HEALTHY, {
      fixture: { publicRead: ["appointments"] },
    });
    expect(seen.some((s) => s.includes("/items/appointments"))).toBe(false);
    const out = await run(r);
    expect(evidence(out, "directus-collection-public")).toEqual([]);
    expect(out.passed).not.toContain("directus-collection-public");
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(/--owner-consent/);
  });

  it("with consent, a marked collection the Public role can read is a finding with a count and no item", async () => {
    const { reading: r } = await reading(LARKSPUR, PAGES_HEALTHY, {
      ownerConsent: true,
      fixture: { publicRead: ["appointments"] },
    });
    const out = await run(r);
    expect(evidence(out, "directus-collection-public")).toEqual([
      "appointments: a request with no token listed 2 items, and gaugeline.adapters.json marks the collection private",
    ]);
    expect(JSON.stringify(out)).not.toContain(DIRECTUS_MARKERS.booking);
  });

  it("with consent, a closed collection passes", async () => {
    const { reading: r } = await reading(LARKSPUR, PAGES_HEALTHY, { ownerConsent: true });
    const out = await run(r);
    expect(out.passed).toContain("directus-collection-public");
  });

  it("a public collection that is not marked private is never asked", async () => {
    const { reading: r, seen } = await reading(LARKSPUR, PAGES_HEALTHY, {
      ownerConsent: true,
      fixture: { publicRead: ["classes", "appointments"] },
    });
    expect(
      seen
        .filter((s) => s.includes("limit=1&fields=id"))
        .every((s) => s.includes("/items/appointments")),
    ).toBe(true);
    expect((await run(r)).findings.map((f) => f.evidence.split(":")[0])).toEqual(["appointments"]);
  });

  it("with consent and nothing marked private it is could-not-check, never a pass", async () => {
    const { reading: r, seen } = await reading(LARKSPUR, PAGES_HEALTHY, {
      ownerConsent: true,
      privateCollections: [],
    });
    const out = await run(r);
    expect(seen.some((s) => s.includes("/items/appointments"))).toBe(false);
    expect(out.passed).not.toContain("directus-collection-public");
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(
      /no collection is marked private/,
    );
  });

  it("an empty answer, a missing collection and a server error are could-not-check by name", async () => {
    const empty = LARKSPUR.map((c) => (c.name === "appointments" ? { ...c, items: [] } : c));
    const { reading: a } = await reading(empty, PAGES_HEALTHY, {
      ownerConsent: true,
      fixture: { publicRead: ["appointments"] },
    });
    const outA = await run(a);
    expect(outA.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(
      /appointments: Directus answered a visitor with no items/,
    );
    expect(outA.passed).not.toContain("directus-collection-public");
    const { reading: b } = await reading(LARKSPUR, PAGES_HEALTHY, {
      ownerConsent: true,
      fixture: { publicRead: ["appointments"] },
      privateCollections: ["appointments", "gone"],
    });
    // "gone" is not a collection: Directus answers a visitor 403, which looks closed; the finding for appointments stands.
    expect(evidence(await run(b), "directus-collection-public")).toHaveLength(1);
  });

  it("with consent, every request is a GET and the visitor requests carry no token", async () => {
    const headers: Array<string | undefined> = [];
    await reading(LARKSPUR, PAGES_HEALTHY, {
      ownerConsent: true,
      fixture: {
        publicRead: ["appointments"],
        onRequest: (method, url, h) => {
          expect(method).toBe("GET");
          if (url.pathname === "/items/appointments") headers.push(h.authorization);
        },
      },
    });
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.every((h) => h === undefined)).toBe(true);
  });

  it("is declared a probing check in its text, and both checks are registered in order", () => {
    expect(DIRECTUS_CHECKS[1].tech).toMatch(/^probing check, off without --owner-consent/);
    expect(DIRECTUS_CHECKS.map((c) => c.id)).toEqual([
      "directus-entry-no-page",
      "directus-collection-public",
    ]);
    for (const c of DIRECTUS_CHECKS) {
      for (const text of [c.done, c.estimateChanges]) {
        expect(text).not.toMatch(/[`<>\n]/);
        expect(text.endsWith(".")).toBe(true);
      }
    }
  });
});

describe("review fixes: nothing checked is not a pass", () => {
  it("items that are all 'live' or 'Published' (none exactly published) leave the page check could-not-check", async () => {
    const content = LARKSPUR.map((c) => ({
      ...c,
      items: c.items.map((i) => ({ ...i, status: "live" })),
    }));
    const { reading: r } = await reading(content, PAGES_HEALTHY, { ownerConsent: true });
    const out = await run(r);
    expect(out.passed).not.toContain("directus-entry-no-page");
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(/no item read as published/);
  });

  it("a closed collection whose spelling the token could not confirm is could-not-check by name, a confirmed one passes", async () => {
    const { reading: a } = await reading(LARKSPUR, PAGES_HEALTHY, {
      ownerConsent: true,
      privateCollections: ["appointments", "apointments"],
    });
    const outA = await run(a);
    expect(outA.passed).not.toContain("directus-collection-public");
    expect(outA.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(
      /apointments: .*403.*missing collection.*spelling/,
    );
    const { reading: b } = await reading(LARKSPUR, PAGES_HEALTHY, { ownerConsent: true });
    expect((await run(b)).passed).toContain("directus-collection-public");
  });

  it("a firewall's 403 to the visitor is could-not-check with its reason, never a pass", async () => {
    const real = directusTransport(LARKSPUR, { token: KEY, pages: PAGES_HEALTHY });
    const fetcher = createFetcher({
      transport: (url, req) =>
        url.host === "cms.larkspur-yoga.example" && req.headers.authorization === undefined
          ? Promise.resolve({
              status: 403,
              headers: { "content-type": "text/html" },
              body: Readable.from([Buffer.from("<html>Attention Required</html>")]),
            })
          : real(url, req),
      timeoutMs: 5000,
    });
    const adapter = createDirectusAdapter({
      env: { DIRECTUS_URL: CMS_URL, DIRECTUS_TOKEN: KEY },
      fetcher,
      settings: { id: "directus", urls: URLS, privateCollections: ["appointments"] },
      sleep: () => Promise.resolve(),
    });
    const r = await readDirectus({ adapter, fetcher, site: DIRECTUS_SITE, ownerConsent: true });
    const out = await run(r);
    expect(out.passed).not.toContain("directus-collection-public");
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(/not a Directus answer/);
  });

  it("when the token was rejected the note names DIRECTUS_TOKEN, and the check says what a pass means", async () => {
    const real = directusTransport(LARKSPUR, { token: KEY, pages: PAGES_HEALTHY });
    const fetcher = createFetcher({
      transport: (url, req) =>
        url.host === "cms.larkspur-yoga.example" &&
        url.pathname === "/items/appointments" &&
        req.headers.authorization !== undefined
          ? Promise.resolve({
              status: 401,
              headers: { "content-type": "application/json" },
              body: Readable.from([
                Buffer.from(
                  JSON.stringify({ errors: [{ extensions: { code: "INVALID_CREDENTIALS" } }] }),
                ),
              ]),
            })
          : real(url, req),
      timeoutMs: 5000,
    });
    const adapter = createDirectusAdapter({
      env: { DIRECTUS_URL: CMS_URL, DIRECTUS_TOKEN: KEY },
      fetcher,
      settings: { id: "directus", urls: URLS, privateCollections: ["appointments"] },
      sleep: () => Promise.resolve(),
    });
    const out = await run(
      await readDirectus({ adapter, fetcher, site: DIRECTUS_SITE, ownerConsent: true }),
    );
    expect(out.couldNotCheck.map((c) => c.reason).join("\n")).toMatch(/DIRECTUS_TOKEN.*401/);
    expect(DIRECTUS_CHECKS[1].tech).toContain(
      "a pass means no public read of id was seen, not that nothing is public",
    );
  });
});
