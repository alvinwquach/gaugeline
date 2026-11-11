import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createHygraphAdapter } from "../../adapters/hygraph.js";
import { readHygraph, type HygraphReading } from "../../adapters/hygraph-read.js";
import {
  HYGRAPH_COLLECTIONS,
  HYGRAPH_MARKERS,
  HYGRAPH_SITE,
  HYGRAPH_URL,
  bothTransport,
  hygraphTransport,
  siteTransport,
  type HygraphFixtureOptions,
} from "../../adapters/__tests__/hygraph-fixture.js";
import type { AdapterSettings } from "../../adapters/types.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { HYGRAPH_CHECKS, createHygraphRegistry } from "../hygraph.js";

const KEY = testKey("hygraph-checks");
const SETTINGS = {
  id: "hygraph",
  collections: HYGRAPH_COLLECTIONS,
  readDraftStage: true,
  urls: { pages: "/{slug}", events: "/events/{slug}" },
};

async function reading(
  options: {
    live?: readonly string[];
    broken?: readonly string[];
    fixture?: HygraphFixtureOptions;
    settings?: Partial<AdapterSettings>;
    /** The owner agreed to probing checks. Default here: yes, so each test says when it is not. */
    ownerConsent?: boolean;
    maxPages?: number;
    pageSize?: number;
    wrap?: (t: Transport) => Transport;
  } = {},
): Promise<{ reading: HygraphReading; seen: string[] }> {
  const seen: string[] = [];
  const both = bothTransport(
    hygraphTransport(undefined, { token: KEY, ...options.fixture }),
    siteTransport(options.live ?? [], options.broken ?? [], (path, method) =>
      seen.push(`${method} ${path}`),
    ),
  );
  const fetcher = createFetcher({
    transport: options.wrap ? options.wrap(both) : both,
    timeoutMs: 5000,
  });
  const adapter = createHygraphAdapter({
    env: { HYGRAPH_TOKEN: KEY, HYGRAPH_ENDPOINT: HYGRAPH_URL },
    fetcher,
    settings: { ...SETTINGS, ...options.settings } as AdapterSettings,
    sleep: () => Promise.resolve(),
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
  });
  return {
    reading: await readHygraph({
      adapter,
      fetcher,
      site: HYGRAPH_SITE,
      ownerConsent: options.ownerConsent ?? true,
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    }),
    seen,
  };
}

const run = (r: HygraphReading) => runChecks(r, createHygraphRegistry());
const reasons = (r: Awaited<ReturnType<typeof run>>): string =>
  r.couldNotCheck.map((c) => `${c.id}: ${c.reason}`).join("\n");

describe("Hygraph checks: an entry that is not published has a live page", () => {
  it("an unpublished entry whose page answers 200 is a finding with the model, the slug, the path and the status", async () => {
    const { reading: r } = await reading({ live: ["/winter-supper-club"] });
    const out = await run(r);
    expect(out.findings.map((f) => f.evidence)).toEqual([
      "pages: winter-supper-club is not published in Hygraph and /winter-supper-club answers 200 on the live site",
    ]);
    expect(out.findings[0]?.url).toBe(`${HYGRAPH_SITE}/winter-supper-club`);
    expect(out.findings[0]?.severity).toBe("high");
    expect(out.passed).toEqual([]);
  });

  it("an unpublished entry whose page answers 404 is no finding, and the check passes", async () => {
    const { reading: r } = await reading({ live: ["/menu", "/home"] });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.couldNotCheck).toEqual([]);
    expect(out.passed).toEqual(["hygraph-draft-live"]);
  });

  it("asks the live page with a GET on the site's own host and nothing else", async () => {
    const { seen } = await reading({ live: ["/winter-supper-club"] });
    expect(seen).toEqual(["GET /winter-supper-club"]);
  });

  it("a page that answers 500 is could-not-check for that page, never a pass and never a finding", async () => {
    const { reading: r } = await reading({ broken: ["/winter-supper-club"] });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toMatch(/the page was not read \(the site answered 500\)/);
  });

  it("a published entry's live page is not asked about: only unpublished entries are", async () => {
    const { seen } = await reading({ live: ["/home", "/menu", "/events/saturday-market"] });
    expect(seen).toEqual(["GET /winter-supper-club"]);
  });

  it("without --owner-consent nothing is asked of Hygraph or the site, and it says so", async () => {
    const seen: string[] = [];
    const { reading: r } = await reading({
      ownerConsent: false,
      fixture: { onRequest: (q) => seen.push(q.url.href) },
    });
    expect(seen).toEqual([]);
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toContain("--owner-consent");
    expect(reasons(out)).toContain("only on sites you own or have permission to test");
  });

  it("without readDraftStage in the settings nothing is asked, even with consent", async () => {
    const seen: string[] = [];
    const { reading: r } = await reading({
      settings: { readDraftStage: false },
      fixture: { onRequest: (q) => seen.push(q.url.href) },
    });
    expect(seen).toEqual([]);
    const out = await run(r);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toContain("readDraftStage");
  });

  it("a token limited to PUBLISHED is could-not-check, never a pass: the unpublished entries are not known", async () => {
    const { reading: r, seen } = await reading({ fixture: { draftStage: "refused-errors" } });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toMatch(/pages: the token cannot read the DRAFT stage/);
    expect(reasons(out)).toMatch(/events: the token cannot read the DRAFT stage/);
    expect(seen).toEqual([]);
  });

  it("an HTTP 403 on the first DRAFT page is the same", async () => {
    const { reading: r } = await reading({ fixture: { draftStage: "refused-http" } });
    const out = await run(r);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toContain("cannot read the DRAFT stage");
  });

  it("a refusal after the first DRAFT page is could-not-check for that model, never 'the token cannot read DRAFT'", async () => {
    const { reading: r } = await reading({
      pageSize: 1,
      fixture: { draftStage: "refused-after-first-page" },
    });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toContain("after answering its first page");
    expect(reasons(out)).not.toContain("cannot read the DRAFT stage");
  });

  it("a model Hygraph will not give is could-not-check and the others are still read", async () => {
    const { reading: r } = await reading({
      live: ["/winter-supper-club"],
      settings: {
        collections: {
          pages: { collection: "pages", slug: "slug" },
          events: { collection: "nope", slug: "slug" },
        },
      },
    });
    const out = await run(r);
    expect(out.findings).toHaveLength(1);
    expect(reasons(out)).toMatch(/events: Hygraph would not give this model/);
  });

  it("an unpublished entry with no urls pattern for its type, or no slug, is could-not-check for that entry", async () => {
    const { reading: r, seen } = await reading({ settings: { urls: {} } });
    const out = await run(r);
    expect(seen).toEqual([]);
    expect(reasons(out)).toMatch(
      /pages: unpublished entry cm1page000000000supp003 was not checked, because the settings give no urls pattern for its type/,
    );
    expect(out.passed).toEqual([]);
  });

  it("an address pattern on another site's host is could-not-check, and that site is never asked", async () => {
    const { reading: r, seen } = await reading({
      settings: { urls: { pages: "https://other-site.example/{slug}" } },
    });
    const out = await run(r);
    expect(seen).toEqual([]);
    expect(reasons(out)).toContain("points to another site (other-site.example)");
  });

  it("an address with a dot segment is not a plain path and is not asked", async () => {
    const { reading: r, seen } = await reading({ settings: { urls: { pages: "/a/../{slug}" } } });
    expect(seen).toEqual([]);
    expect(reasons(await run(r))).toContain("not a plain path");
  });

  it("an unpublished entry that shares its slug with a published one is not asked: a live page there proves nothing", async () => {
    const { reading: r, seen } = await reading({
      live: ["/menu"],
      fixture: {},
      settings: { urls: { pages: "/{slug}" } },
    });
    expect(seen).toEqual(["GET /winter-supper-club"]);
    expect(r.unaddressed).toEqual([]);
  });

  it("only as many pages as the budget are asked, and the rest are could-not-check", async () => {
    const { reading: r, seen } = await reading({
      maxPages: 0,
      live: ["/winter-supper-club"],
    });
    const out = await run(r);
    expect(seen).toEqual([]);
    expect(out.findings).toEqual([]);
    expect(reasons(out)).toMatch(/1 page was not asked for, because a run asks for at most 0/);
  });

  it("a rate limit that stays is could-not-check, and no page is asked from a partial read as if it were whole", async () => {
    let n = 0;
    const { reading: r } = await reading({
      live: ["/winter-supper-club"],
      wrap: (t) => (url, req) => {
        if (url.host.endsWith("hygraph.com") && ++n > 3)
          return Promise.resolve({
            status: 429,
            headers: { "retry-after": "3600" },
            body: Readable.from([Buffer.from("{}")]),
          });
        return t(url, req);
      },
    });
    expect(r.partial?.reason).toBe("rate-limited");
    const out = await run(r);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toMatch(/asked Gaugeline to slow down/);
  });

  it("the finding and the report show no text from the client's content", async () => {
    const { reading: r } = await reading({ live: ["/winter-supper-club"] });
    const out = await run(r);
    const text = JSON.stringify([out.findings, out.couldNotCheck, r]);
    for (const marker of Object.values(HYGRAPH_MARKERS)) expect(text).not.toContain(marker);
    expect(text).not.toContain(KEY);
  });

  it("is deterministic: the same project gives the same findings", async () => {
    const a = await run((await reading({ live: ["/winter-supper-club"] })).reading);
    const b = await run((await reading({ live: ["/winter-supper-club"] })).reading);
    expect(a).toEqual(b);
  });

  it("reads nothing at all when no model is named, and says so", async () => {
    const { reading: r } = await reading({ settings: { collections: undefined } });
    const out = await run(r);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toContain("No model is named");
  });
});

describe("the Hygraph check's text", () => {
  it("has plain done and estimateChanges sentences", () => {
    for (const c of HYGRAPH_CHECKS) {
      for (const text of [c.done, c.estimateChanges]) {
        expect(text).not.toMatch(/[`<>\n]/);
        expect(text.endsWith(".")).toBe(true);
      }
    }
  });

  it("says it is a probing check that needs consent and a site you own", () => {
    const check = HYGRAPH_CHECKS[0];
    expect(check.tech).toContain("--owner-consent");
    expect(check.tech).toContain("run only on sites you own or have permission to test");
  });
});
