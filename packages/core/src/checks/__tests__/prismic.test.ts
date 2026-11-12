import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createPrismicAdapter } from "../../adapters/prismic.js";
import { readPrismic, type PrismicReading } from "../../adapters/prismic-read.js";
import {
  LARKSPUR,
  MASTER_REF,
  OLD_MASTER_REF,
  PAGES_DRIFT,
  PAGES_HEALTHY,
  PRISMIC_MARKERS,
  PRISMIC_SITE,
  REPOSITORY,
  RELEASE_REF,
  prismicTransport,
  rich,
  type FixtureDoc,
  type PrismicFixtureOptions,
} from "../../adapters/__tests__/prismic-fixture.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { PRISMIC_CHECKS, createPrismicRegistry } from "../prismic.js";

const KEY = testKey("prismic-checks");
const URLS = {
  classes: "/classes/{slug}",
  notices: "/notices/{slug}",
  teachers: "/teachers/{slug}",
};
/** The notices have pages in these tests, so a clean site really is clean. */
const NOTICE_PAGES = { "/notices/closed-last-friday": 200 };

async function reading(
  pages: Readonly<Record<string, number>>,
  options: {
    content?: readonly FixtureDoc[];
    fixture?: PrismicFixtureOptions;
    urls?: Record<string, string>;
    checkReleases?: boolean;
    ownerConsent?: boolean;
    token?: boolean;
    maxPages?: number;
  } = {},
): Promise<{ reading: PrismicReading; seen: string[] }> {
  const seen: string[] = [];
  const fetcher = createFetcher({
    transport: prismicTransport(options.content ?? LARKSPUR, {
      releaseToken: KEY,
      pages: { ...NOTICE_PAGES, ...pages },
      onRequest: (method, url) => seen.push(`${method} ${url.href}`),
      ...options.fixture,
    }),
    timeoutMs: 5000,
  });
  const adapter = createPrismicAdapter({
    env: {
      PRISMIC_REPOSITORY: REPOSITORY,
      ...(options.token === false ? {} : { PRISMIC_ACCESS_TOKEN: KEY }),
    },
    fetcher,
    settings: {
      id: "prismic",
      urls: options.urls ?? URLS,
      ...(options.checkReleases === false ? {} : { checkReleases: true }),
    },
    sleep: () => Promise.resolve(),
  });
  return {
    reading: await readPrismic({
      adapter,
      fetcher,
      site: PRISMIC_SITE,
      ...(options.ownerConsent !== undefined ? { ownerConsent: options.ownerConsent } : {}),
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    }),
    seen,
  };
}

const run = (r: PrismicReading) => runChecks(r, createPrismicRegistry());
const evidence = (r: Awaited<ReturnType<typeof run>>, id: string): string[] =>
  r.findings.filter((f) => f.checkId === id).map((f) => f.evidence);
const reasons = (r: Awaited<ReturnType<typeof run>>): string =>
  r.couldNotCheck.map((c) => c.reason).join("\n");

describe("Prismic checks: a studio whose CMS and front end have drifted", () => {
  it("finds the published class with no page, and nothing else", async () => {
    const { reading: r } = await reading(PAGES_DRIFT);
    const out = await run(r);
    expect(evidence(out, "prismic-document-no-page")).toEqual([
      "classes: evening-stretch is published in Prismic and /classes/evening-stretch answers 404",
    ]);
    expect(out.passed).toContain("prismic-master-ref-stale");
    expect(JSON.stringify(out)).not.toContain(PRISMIC_MARKERS.retreat);
  });

  it("a healthy studio passes the page and master ref checks; the release check is not asked without consent", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY);
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed.sort()).toEqual(["prismic-document-no-page", "prismic-master-ref-stale"]);
    expect(reasons(out)).toMatch(/not asked: .*--owner-consent/);
  });

  it("a 5xx on a page is could-not-check for that page, not a finding or a pass", async () => {
    const { reading: r } = await reading({ ...PAGES_HEALTHY, "/teachers/ana": 503 });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(reasons(out)).toMatch(/the page was not read \(the site answered 503\)/);
    expect(out.passed).not.toContain("prismic-document-no-page");
  });

  it("a document in another language is could-not-check by id, never a missing page", async () => {
    const fr: FixtureDoc = {
      id: "c-morning-fr",
      uid: "morning-flow",
      type: "classes",
      lang: "fr-fr",
      first: "2026-10-02T09:00:00.000Z",
      last: "2026-10-21T09:00:00.000Z",
      data: { name: rich("Flux du matin") },
    };
    const { reading: r } = await reading(PAGES_HEALTHY, { content: [...LARKSPUR, fr] });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(reasons(out)).toMatch(/classes: document c-morning-fr was not checked/);
  });

  it("a type with documents and no pattern, and settings with no pattern at all, are could-not-check", async () => {
    const { reading: a } = await reading(PAGES_HEALTHY, { urls: { classes: "/classes/{slug}" } });
    const out = await run(a);
    expect(reasons(out)).toMatch(/teachers: its pages were not checked/);
    const { reading: b, seen } = await reading({}, { urls: {} });
    const none = await run(b);
    expect(reasons(none)).toMatch(/No document type has an address pattern/);
    expect(none.passed).not.toContain("prismic-document-no-page");
    expect(seen.filter((s) => s.includes("larkspur-yoga.example"))).toEqual([]);
  });

  it("a page budget that is used up is said, not skipped quietly", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY, { maxPages: 2 });
    const out = await run(r);
    expect(reasons(out)).toMatch(/3 pages were not asked for, because a run asks for at most 2/);
  });

  it("a repository that cannot be listed is could-not-check, not a clean page check", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY, { fixture: { expired: [MASTER_REF] } });
    const out = await run(r);
    expect(out.passed).not.toContain("prismic-document-no-page");
    expect(reasons(out)).toMatch(/expired|410/);
  });

  it("an address pattern that points to another site is never asked", async () => {
    const { reading: r, seen } = await reading(PAGES_HEALTHY, {
      urls: { classes: "https://elsewhere.example/classes/{slug}" },
    });
    const out = await run(r);
    expect(seen.some((s) => s.includes("elsewhere.example"))).toBe(false);
    expect(reasons(out)).toMatch(/points to another site/);
  });
});

describe("Prismic checks: the master ref", () => {
  it("a cache that stays behind is a finding that quotes two times and an id, never a field", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY, {
      fixture: { masterRef: (h) => (h === "cache" ? OLD_MASTER_REF : MASTER_REF) },
    });
    const out = await run(r);
    expect(evidence(out, "prismic-master-ref-stale")).toEqual([
      "the cache's master ref shows its newest publication at 2026-10-20T08:30:00.000Z, and the origin's shows document n-closed published at 2026-11-03T12:00:00.000Z",
    ]);
    expect(JSON.stringify(out)).not.toContain(PRISMIC_MARKERS.notice);
  });

  it("a publication in flight (the cache catches up) is a pass", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY, {
      fixture: { masterRef: (h, n) => (h === "cache" && n === 0 ? OLD_MASTER_REF : MASTER_REF) },
    });
    // Reads 0 happen for types() on the cache first, so the first masterRefs round may see either; the end state is the same.
    const out = await run(r);
    expect(out.findings.filter((f) => f.checkId === "prismic-master-ref-stale")).toEqual([]);
  });

  it("refs that cannot be judged are could-not-check", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY, {
      fixture: {
        masterRef: (h) => (h === "cache" ? OLD_MASTER_REF : MASTER_REF),
        snapshots: { [MASTER_REF]: LARKSPUR, [OLD_MASTER_REF]: LARKSPUR },
      },
    });
    const out = await run(r);
    expect(out.passed).not.toContain("prismic-master-ref-stale");
    expect(reasons(out)).toMatch(/could not be judged/);
  });

  it("an origin that does not answer is could-not-check", async () => {
    const seen: string[] = [];
    const base = prismicTransport(LARKSPUR, { pages: { ...PAGES_HEALTHY, ...NOTICE_PAGES } });
    const fetcher = createFetcher({
      transport: (url, req) => {
        seen.push(url.host);
        return url.host === "larkspur-yoga.prismic.io"
          ? Promise.resolve({ status: 503, headers: {}, body: Readable.from([]) })
          : base(url, req);
      },
      timeoutMs: 5000,
    });
    const adapter = createPrismicAdapter({
      env: { PRISMIC_REPOSITORY: REPOSITORY },
      fetcher,
      settings: { id: "prismic", urls: URLS },
      sleep: () => Promise.resolve(),
    });
    const out = await run(await readPrismic({ adapter, fetcher, site: PRISMIC_SITE }));
    expect(out.passed).not.toContain("prismic-master-ref-stale");
    expect(reasons(out)).toMatch(/master ref was not read/);
  });
});

describe("Prismic checks: the release check is a probing check", () => {
  it("without --owner-consent no release is read: not one request carries the release ref", async () => {
    const { reading: r, seen } = await reading(PAGES_HEALTHY);
    const out = await run(r);
    expect(evidence(out, "prismic-release-document-live")).toEqual([]);
    expect(out.passed).not.toContain("prismic-release-document-live");
    expect(seen.filter((s) => s.includes(encodeURIComponent(RELEASE_REF)))).toEqual([]);
  });

  it("with consent but without checkReleases in the settings no release is read either", async () => {
    const { reading: r, seen } = await reading(PAGES_HEALTHY, {
      ownerConsent: true,
      checkReleases: false,
    });
    const out = await run(r);
    expect(reasons(out)).toMatch(/asks only when gaugeline.adapters.json says checkReleases: true/);
    expect(seen.filter((s) => s.includes(encodeURIComponent(RELEASE_REF)))).toEqual([]);
  });

  it("with both, a release that holds an older copy of a live document is a finding by id and type", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY, { ownerConsent: true });
    const out = await run(r);
    expect(evidence(out, "prismic-release-document-live")).toEqual([
      "release Autumn retreat lists 1 document last published before the live copy (classes c-evening); if the release holds that copy, publishing it may put the older copy back",
    ]);
    expect(JSON.stringify(out)).not.toContain(PRISMIC_MARKERS.evening);
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("with both and no token it is could-not-check and nothing is sent", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY, { ownerConsent: true, token: false });
    const out = await run(r);
    expect(reasons(out)).toMatch(/PRISMIC_ACCESS_TOKEN is not set/);
    expect(out.passed).not.toContain("prismic-release-document-live");
  });

  it("a repository with no release says there was nothing to compare, not a pass", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY, {
      ownerConsent: true,
      fixture: { releases: [] },
    });
    const out = await run(r);
    expect(out.passed).not.toContain("prismic-release-document-live");
    expect(reasons(out)).toMatch(/lists no release/);
  });

  it("a release that shows nothing different from the live repository is could-not-check, never a pass", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY, {
      ownerConsent: true,
      fixture: {
        snapshots: { [MASTER_REF]: LARKSPUR, [RELEASE_REF]: LARKSPUR, [OLD_MASTER_REF]: LARKSPUR },
      },
    });
    const out = await run(r);
    expect(out.passed).not.toContain("prismic-release-document-live");
    expect(reasons(out)).toMatch(/cannot tell what the release holds/);
  });

  it("a release that could not be listed is could-not-check by name", async () => {
    const { reading: r } = await reading(PAGES_HEALTHY, {
      ownerConsent: true,
      fixture: { releases: [{ id: "rel-gone", label: "Gone", ref: "Zgone~x" }] },
    });
    const out = await run(r);
    expect(reasons(out)).toMatch(/release Gone: not read/);
    expect(out.passed).not.toContain("prismic-release-document-live");
  });
});

describe("Prismic checks: the registry", () => {
  it("has the three checks, each with a plain one-line done sentence", () => {
    expect(PRISMIC_CHECKS.map((c) => c.id)).toEqual([
      "prismic-document-no-page",
      "prismic-master-ref-stale",
      "prismic-release-document-live",
    ]);
    for (const c of PRISMIC_CHECKS) {
      for (const text of [c.done, c.estimateChanges]) {
        expect(text).not.toMatch(/[`<>\n]/);
        expect(text.endsWith(".")).toBe(true);
      }
    }
  });
});
