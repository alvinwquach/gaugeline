import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITES_DIR, startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher, type Hop } from "../../fetcher.js";
import { hiddenConfigSchema, isHidden, matchesGlob, overdue } from "../../hidden.js";
import { createBudget } from "../../limits.js";
import type { CheckContext } from "../../model.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import { hiddenIndexable } from "../hidden-indexable.js";
import { hiddenLinked } from "../hidden-linked.js";
import { hiddenPastLaunch } from "../hidden-past-launch.js";

const HIDDEN = ["hidden-in-sitemap", "hidden-linked", "hidden-indexable", "hidden-past-launch"];
const NOW = () => new Date("2026-11-05T20:00:00Z");
const config = hiddenConfigSchema.parse({
  hidden: [{ match: "/library/*", until: "2026-10-01" }, { match: "/beta/*" }],
});

const page = (url: string, body = "") =>
  buildSnapshot([{ url, status: 200, headers: { "content-type": "text/html" }, body, ms: 1 }]);

/** A fetcher that answers each address from a table, and logs what was asked. */
function tableFetcher(answers: Record<string, Hop[]>, asked: string[] = []) {
  return {
    get: async (url: string) => {
      asked.push(url);
      return answers[url] ?? [{ url, status: 404, headers: {}, body: "", ms: 1 }];
    },
    getSite: async () => [],
    stats: { requests: 0, maxInFlight: 0 },
  };
}

describe("hidden until launch: unit", () => {
  it("glob matching for hidden sections", () => {
    expect(matchesGlob("/library/*", "/library/guide")).toBe(true);
    expect(matchesGlob("/library/*", "/library/a/b")).toBe(true);
    expect(matchesGlob("/library/*", "/library/")).toBe(true);
    expect(matchesGlob("/library/*", "/library")).toBe(false);
    expect(matchesGlob("/library/*", "/libraryx/a")).toBe(false);
    expect(matchesGlob("/library/*", "/en/library/a")).toBe(false);
    expect(matchesGlob("/press-kit", "/press-kit")).toBe(true);
    expect(matchesGlob("/*/draft", "/news/draft")).toBe(true);
    expect(isHidden(config, "https://pop.example/library/guide?x=1", "https://pop.example/")).toBe(
      true,
    );
    // Another site's /library is not this site's hidden section.
    expect(isHidden(config, "https://other.example/library/guide", "https://pop.example/")).toBe(
      false,
    );
  });

  it("until comparisons with an injected clock", () => {
    expect(overdue(config, NOW).map((s) => s.match)).toEqual(["/library/*"]);
    expect(overdue(config, () => new Date("2026-10-01T12:00:00Z"))).toEqual([]);
    expect(overdue(config, () => new Date("2026-10-02T00:00:01Z")).map((s) => s.match)).toEqual([
      "/library/*",
    ]);
    expect(
      hiddenConfigSchema.safeParse({ hidden: [{ match: "/a/*", until: "next week" }] }).success,
    ).toBe(false);
  });
});

describe("hidden until launch: integration (the hidden-library fixture)", () => {
  it("a hidden /library section leaked through the sitemap and one footer link", async () => {
    const site = await startFixture("hidden-library");
    try {
      const hidden = hiddenConfigSchema.parse(
        JSON.parse(readFileSync(`${SITES_DIR}hidden-library/gaugeline.hidden.json`, "utf8")),
      );
      const { result } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        only: HIDDEN,
        hidden,
        now: NOW,
      });
      expect(result.findings.map((f) => [f.checkId, f.severity, f.evidence])).toEqual([
        ["hidden-in-sitemap", "high", "1 hidden address in the sitemap: /library/guide"],
        ["hidden-indexable", "high", "/library/guide answers 200 with no noindex and no login"],
        [
          "hidden-linked",
          "high",
          '/ links to /library/ ("Resource library"); /old-guide on / redirects to /library/guide',
        ],
        [
          "hidden-past-launch",
          "low",
          "/library/* was due to launch on 2026-10-01 and is still listed as hidden",
        ],
      ]);
      // The hidden page is asked only for its status and robots directives: the sitemap sample
      // and the link probe of /old-guide each reach it (HEAD, then GET if HEAD is refused), and
      // hidden-indexable reads it once more. Nothing walks into it from there.
      expect(site.hits.get("/library/guide")).toBeLessThanOrEqual(4);
      expect(result.failed).toEqual([]);
    } finally {
      await site.close();
    }
  });
});

describe("hidden until launch: edge cases", () => {
  const ctxWith = (
    answers: Record<string, Hop[]>,
    links: string[] = [],
    asked: string[] = [],
  ): CheckContext => ({
    warn: () => undefined,
    hidden: config,
    now: NOW,
    budget: createBudget(),
    fetcher: tableFetcher(answers, asked),
    site: async () => ({ sitemapUrls: links }) as never,
  });

  it("a hidden URL answering 401 or 404 passes hidden-indexable", async () => {
    const urls = ["https://pop.example/beta/app", "https://pop.example/library/x"];
    const answers = {
      [urls[0] as string]: [{ url: urls[0] as string, status: 401, headers: {}, body: "", ms: 1 }],
    };
    expect(await hiddenIndexable.run(page("https://pop.example/"), ctxWith(answers, urls))).toEqual(
      [],
    );
  });

  it("noindex in a header or meta tag passes hidden-indexable", async () => {
    const u = "https://pop.example/library/a";
    const v = "https://pop.example/library/b";
    const answers = {
      [u]: [{ url: u, status: 200, headers: { "x-robots-tag": "noindex" }, body: "", ms: 1 }],
      [v]: [
        { url: v, status: 200, headers: {}, body: '<meta name="robots" content="noindex">', ms: 1 },
      ],
    };
    expect(
      await hiddenIndexable.run(page("https://pop.example/"), ctxWith(answers, [u, v])),
    ).toEqual([]);
  });

  it("a hidden section reachable only through a redirect from a public URL is hidden-linked", async () => {
    const p = page("https://pop.example/", '<a href="/start">Start here</a>');
    const ctx: CheckContext = {
      warn: () => undefined,
      hidden: config,
      links: async () =>
        ({
          seen: 1,
          taken: [
            {
              url: "https://pop.example/start",
              href: "/start",
              text: "Start here",
              hops: [
                {
                  url: "https://pop.example/start",
                  status: 302,
                  headers: { location: "/beta/app" },
                  ms: 1,
                },
                { url: "https://pop.example/beta/app", status: 200, headers: {}, body: "", ms: 1 },
              ],
            },
          ],
        }) as never,
    };
    expect((await hiddenLinked.run(p, ctx)).map((f) => f.evidence)).toEqual([
      "/start on / redirects to /beta/app",
    ]);
  });

  it("without hidden settings nothing is requested and nothing reported", async () => {
    const asked: string[] = [];
    const ctx: CheckContext = {
      warn: () => undefined,
      fetcher: tableFetcher({}, asked),
      budget: createBudget(),
    };
    for (const c of [hiddenIndexable, hiddenLinked, hiddenPastLaunch])
      expect(await c.run(page("https://pop.example/", '<a href="/library/x">x</a>'), ctx)).toEqual(
        [],
      );
    expect(asked).toEqual([]);
  });
});
