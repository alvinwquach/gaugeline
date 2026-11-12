import { describe, expect, it } from "vitest";
import { createKontentAdapter } from "../../adapters/kontent-ai.js";
import { readKontent, type KontentReading } from "../../adapters/kontent-ai-read.js";
import {
  ENVIRONMENT_ID,
  FERNHILL,
  FERNHILL_SETTLED,
  FERNHILL_URLS,
  KONTENT_MARKERS,
  KONTENT_SITE,
  bothTransport,
  kontentTransport,
  siteTransport,
  type KontentFixtureItem,
  type KontentFixtureOptions,
} from "../../adapters/__tests__/kontent-ai-fixture.js";
import type { AdapterSettings } from "../../adapters/types.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher, type Transport } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { KONTENT_AI_CHECKS, createKontentAiRegistry } from "../kontent-ai.js";

const SECURE = testKey("kontent-check-secure");
const PREVIEW = testKey("kontent-check-preview");
const SETTINGS = { id: "kontent-ai", urls: { ...FERNHILL_URLS }, readPreview: true };

async function reading(
  options: {
    items?: readonly KontentFixtureItem[];
    live?: readonly string[];
    broken?: readonly string[];
    fixture?: KontentFixtureOptions;
    settings?: Partial<AdapterSettings>;
    env?: Record<string, string>;
    /** The owner agreed to probing checks. Default here: yes, so each test says when it is not. */
    ownerConsent?: boolean;
    maxPages?: number;
    redirects?: Readonly<Record<string, string>>;
    wrap?: (t: Transport) => Transport;
  } = {},
): Promise<{ reading: KontentReading; seen: string[]; cms: string[] }> {
  const seen: string[] = [];
  const cms: string[] = [];
  const both = bothTransport(
    (url, req) => {
      cms.push(`${req.method} ${url.host}`);
      return kontentTransport(options.items ?? FERNHILL, {
        secureKey: SECURE,
        previewKey: PREVIEW,
        ...options.fixture,
      })(url, req);
    },
    siteTransport(
      options.live ?? [],
      options.broken ?? [],
      (path, method) => seen.push(`${method} ${path}`),
      options.redirects,
    ),
  );
  const fetcher = createFetcher({
    transport: options.wrap ? options.wrap(both) : both,
    timeoutMs: 5000,
  });
  const adapter = createKontentAdapter({
    env: options.env ?? {
      KONTENT_ENVIRONMENT_ID: ENVIRONMENT_ID,
      KONTENT_SECURE_ACCESS_KEY: SECURE,
      KONTENT_PREVIEW_API_KEY: PREVIEW,
    },
    fetcher,
    settings: { ...SETTINGS, ...options.settings } as AdapterSettings,
    sleep: () => Promise.resolve(),
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
  });
  return {
    reading: await readKontent({
      adapter,
      fetcher,
      site: KONTENT_SITE,
      ownerConsent: options.ownerConsent ?? true,
    }),
    seen,
    cms,
  };
}

const run = (r: KontentReading) => runChecks(r, createKontentAiRegistry());
const reasons = (r: Awaited<ReturnType<typeof run>>): string =>
  r.couldNotCheck.map((c) => `${c.id}: ${c.reason}`).join("\n");

describe("Kontent.ai check: an item that is not published has a live page", () => {
  it("an unpublished item whose page answers 200 is a finding with the type, the slug, the step, the path and the status", async () => {
    const { reading: r } = await reading({ live: ["/journal/closing-sale"] });
    const out = await run(r);
    expect(out.findings.map((f) => f.evidence)).toEqual([
      "article: closing-sale is in the workflow step draft in Kontent.ai, not published, and /journal/closing-sale answers 200 on the live site",
    ]);
    expect(out.findings[0]?.url).toBe(`${KONTENT_SITE}/journal/closing-sale`);
    expect(out.findings[0]?.severity).toBe("high");
    expect(out.passed).toEqual([]);
  });

  it("archived and scheduled items are found the same way", async () => {
    const { reading: r } = await reading({
      live: ["/journal/price-list-2025", "/offers/spring-ride-out"],
    });
    const out = await run(r);
    expect(out.findings.map((f) => f.evidence.split(", and ")[0])).toEqual([
      "article: price-list-2025 is in the workflow step archived in Kontent.ai, not published",
      "offer: spring-ride-out is in the workflow step scheduled in Kontent.ai, not published",
    ]);
  });

  it("every unpublished page answering 404 is a pass", async () => {
    const { reading: r } = await reading({
      live: ["/journal/spring-service", "/offers/ebike-trial"],
    });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.couldNotCheck).toEqual([]);
    expect(out.passed).toEqual(["kontent-ai-unpublished-live"]);
  });

  it("asks the live page with a GET on the site's own host and only for unpublished items", async () => {
    const { seen } = await reading({ live: ["/journal/spring-service", "/offers/e-bike-trial"] });
    expect(seen.sort()).toEqual([
      "GET /journal/closing-sale",
      "GET /journal/price-list-2025",
      "GET /offers/spring-ride-out",
    ]);
  });

  it("an item with a newer version in review is not unpublished: its published version is live", async () => {
    const { reading: r } = await reading({
      items: FERNHILL.slice(0, 3),
      live: ["/journal/spring-service"],
    });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual(["kontent-ai-unpublished-live"]);
  });

  it("a page that answers 500 is could-not-check for that page, never a pass and never a finding", async () => {
    const { reading: r } = await reading({ broken: ["/journal/closing-sale"] });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toMatch(/the page was not read \(the site answered 500\)/);
  });

  it("nothing waiting: the check passes", async () => {
    const { reading: r, seen } = await reading({ items: FERNHILL_SETTLED });
    expect(seen).toEqual([]);
    expect((await run(r)).passed).toEqual(["kontent-ai-unpublished-live"]);
  });

  it("without --owner-consent nothing is asked of Kontent.ai or the site, and it says so", async () => {
    const {
      reading: r,
      seen,
      cms,
    } = await reading({ ownerConsent: false, live: ["/journal/closing-sale"] });
    expect(seen).toEqual([]);
    expect(cms).toEqual([]);
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toContain("--owner-consent");
    expect(reasons(out)).toContain("only on sites you own or have permission to test");
  });

  it("without readPreview in the settings nothing is asked, even with consent", async () => {
    const {
      reading: r,
      seen,
      cms,
    } = await reading({
      settings: { readPreview: false },
      live: ["/journal/closing-sale"],
    });
    expect(seen).toEqual([]);
    expect(cms).toEqual([]);
    const out = await run(r);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toContain("readPreview");
  });

  it("with no urls pattern for any type nothing is read, and it says so", async () => {
    const { reading: r, cms } = await reading({ settings: { urls: {} } });
    expect(cms).toEqual([]);
    const out = await run(r);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toContain("urls");
  });

  it("no Preview key, or a refused one, is could-not-check and never a pass, and no page is asked", async () => {
    const envs: Record<string, string>[] = [
      { KONTENT_ENVIRONMENT_ID: ENVIRONMENT_ID, KONTENT_SECURE_ACCESS_KEY: SECURE },
      {
        KONTENT_ENVIRONMENT_ID: ENVIRONMENT_ID,
        KONTENT_SECURE_ACCESS_KEY: SECURE,
        KONTENT_PREVIEW_API_KEY: testKey("kontent-wrong-preview"),
      },
    ];
    for (const env of envs) {
      const { reading: r, seen } = await reading({ env, live: ["/journal/closing-sale"] });
      const out = await run(r);
      expect(seen).toEqual([]);
      expect(out.findings).toEqual([]);
      expect(out.passed).toEqual([]);
      expect(reasons(out)).toMatch(/Preview/);
    }
  });

  it("a list that changed between the reads is could-not-check, never a finding", async () => {
    let n = 0;
    const { reading: r, seen } = await reading({
      live: ["/journal/closing-sale"],
      fixture: {
        itemsFor: (host, all) =>
          host.startsWith("preview")
            ? all
            : (n++, all.filter((i) => i.published || (n > 1 && i.codename === "closing_sale"))),
      },
    });
    const out = await run(r);
    expect(seen).toEqual([]);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toContain("changed");
  });

  it("an item only the Preview list has whose step says published is named as unchecked, not reported", async () => {
    const { reading: r, seen } = await reading({
      live: ["/journal/closing-sale"],
      fixture: {
        tamper: (b, call) => {
          if (call.host.startsWith("preview"))
            for (const row of b.items as { system: Record<string, unknown> }[])
              if (row.system.codename === "closing_sale") row.system.workflow_step = "published";
          return b;
        },
      },
    });
    const out = await run(r);
    expect(seen).not.toContain("GET /journal/closing-sale");
    expect(out.findings).toEqual([]);
    expect(reasons(out)).toContain("published a moment ago");
  });

  it("an item with no pattern or no slug, or an address on another site or with a dot segment, is could-not-check and not asked", async () => {
    const noSlug = FERNHILL.map((i) =>
      i.codename === "closing_sale" ? { ...i, elements: { title: i.elements.title } } : i,
    );
    const a = await reading({ items: noSlug, live: ["/journal/closing-sale"] });
    expect(reasons(await run(a.reading))).toContain("it has no slug");
    const b = await reading({
      settings: { urls: { article: "https://other.example/{slug}", offer: "/offers/{slug}" } },
    });
    expect(b.seen.filter((s) => s.includes("other.example"))).toEqual([]);
    expect(reasons(await run(b.reading))).toContain("another site");
    const c = await reading({
      settings: { urls: { article: "/a/../{slug}", offer: "/offers/{slug}" } },
    });
    expect(reasons(await run(c.reading))).toContain("not a plain path");
    const d = await reading({ settings: { urls: { offer: "/offers/{slug}" } } });
    expect(reasons(await run(d.reading))).toContain(
      "article: 2 unpublished items were not asked about",
    );
  });

  it("an item that shares its slug with a published item of its type is not asked", async () => {
    const items = FERNHILL.map((i) =>
      i.codename === "closing_sale"
        ? { ...i, elements: { ...i.elements, url: { type: "url_slug", value: "spring-service" } } }
        : i,
    );
    const { reading: r, seen } = await reading({ items, live: ["/journal/spring-service"] });
    expect(seen).not.toContain("GET /journal/spring-service");
    expect(reasons(await run(r))).toContain("same as a published item's");
  });

  it("only as many pages as the budget are asked, and the rest are could-not-check", async () => {
    const { reading: r, seen } = await reading({ maxPages: 2 });
    const out = await run(r);
    expect(seen).toHaveLength(2);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toContain("1 unpublished item was not asked about");
  });

  it("exactly the budget is all asked and passes when every page is 404", async () => {
    const { reading: r, seen } = await reading({ maxPages: 3 });
    expect(seen).toHaveLength(3);
    expect((await run(r)).passed).toEqual(["kontent-ai-unpublished-live"]);
  });

  it("a rate limit that stays is could-not-check, and no page is asked from a partial read", async () => {
    const { reading: r, seen } = await reading({
      live: ["/journal/closing-sale"],
      fixture: { respond: (c) => (c.host.startsWith("preview") ? { status: 429 } : undefined) },
    });
    const out = await run(r);
    expect(seen).toEqual([]);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(reasons(out)).toContain("slow down");
  });

  it("sends only GET, and the keys only to their own hosts", async () => {
    const { cms } = await reading({});
    expect(new Set(cms.map((c) => c.split(" ")[0]))).toEqual(new Set(["GET"]));
    expect(new Set(cms.map((c) => c.split(" ")[1]))).toEqual(
      new Set(["deliver.kontent.ai", "preview-deliver.kontent.ai"]),
    );
  });

  it("an unpublished slug that redirects to another page is could-not-check, never a finding", async () => {
    const { reading: r } = await reading({
      live: ["/"],
      redirects: { "/journal/closing-sale": "/" },
    });
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(reasons(out)).toContain("redirects to /");
  });

  it("a trailing-slash redirect to the same page is still a live page", async () => {
    const { reading: r } = await reading({
      live: ["/journal/closing-sale/"],
      redirects: { "/journal/closing-sale": "/journal/closing-sale/" },
    });
    expect((await run(r)).findings).toHaveLength(1);
  });

  it("the finding and the report show no text from the client's content or any key", async () => {
    const { reading: r } = await reading({ live: ["/journal/closing-sale"] });
    const text = JSON.stringify([r, await run(r)]);
    for (const v of Object.values(KONTENT_MARKERS)) expect(text).not.toContain(v);
    expect(text).not.toContain(SECURE);
    expect(text).not.toContain(PREVIEW);
  });

  it("is deterministic: the same project gives the same findings", async () => {
    const a = await run((await reading({ live: ["/journal/closing-sale"] })).reading);
    const b = await run((await reading({ live: ["/journal/closing-sale"] })).reading);
    expect(b).toEqual(a);
  });
});

describe("the Kontent.ai check's text", () => {
  it("has plain done and estimateChanges sentences", () => {
    for (const c of KONTENT_AI_CHECKS) {
      for (const text of [c.done, c.estimateChanges]) {
        expect(text).not.toMatch(/[`<>\n]/);
        expect(text.endsWith(".")).toBe(true);
      }
    }
  });

  it("says it is a probing check that needs consent and a site you own", () => {
    const check = KONTENT_AI_CHECKS[0];
    expect(check.tech).toContain("--owner-consent");
    expect(check.tech).toContain("run only on sites you own or have permission to test");
    expect(check.id).toBe("kontent-ai-unpublished-live");
  });
});
