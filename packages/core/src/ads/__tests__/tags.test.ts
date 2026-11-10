import { Readable } from "node:stream";
import { startFixture } from "@gaugeline/fixtures";
import { describe, expect, it } from "vitest";
import { createFetcher, type Hop } from "../../fetcher.js";
import { CAMPAIGN_CHECKS, createCampaignRegistry } from "../../checks/campaign-fields-lost.js";
import { runChecks } from "../../run.js";
import { groupByDestination, type AdRow } from "../export.js";
import { checkAdLandingPages } from "../check.js";
import {
  PROBE_TAGS,
  campaignTags,
  describeTrail,
  isCampaignKey,
  tagSurvival,
  withCampaignTags,
} from "../tags.js";

const hop = (url: string, status = 200, location?: string): Hop => ({
  url,
  status,
  headers: location === undefined ? {} : { location },
  ms: 1,
});

const SHOP = "https://tapas-bar.example";

// ---- unit: which keys count -----------------------------------------------------------------------

describe("isCampaignKey", () => {
  it("is utm_ anything, gclid and fbclid, in any case", () => {
    for (const k of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "utm_id",
      "UTM_Source",
      "gclid",
      "fbclid",
      "GCLID",
    ])
      expect(isCampaignKey(k), k).toBe(true);
    for (const k of ["utm", "source", "gclsrc", "ref", "size", "fbclid2", "xgclid"])
      expect(isCampaignKey(k), k).toBe(false);
  });

  it("campaignTags reads the first value of each key, decoded, with the key in lower case", () => {
    expect(
      campaignTags(`${SHOP}/a?UTM_Source=face%20book&utm_source=other&size=l&gclid=a+b#utm_term=x`),
    ).toEqual({ utm_source: "face book", gclid: "a b" });
    expect(campaignTags("not an address")).toEqual({});
  });

  it("withCampaignTags adds the missing keys after the existing query and keeps the fragment", () => {
    expect(withCampaignTags(`${SHOP}/menu?size=l%20m#top`, { utm_source: "x y" })).toBe(
      `${SHOP}/menu?size=l%20m&utm_source=x%20y#top`,
    );
    expect(withCampaignTags(`${SHOP}/menu`, { gclid: "test" })).toBe(`${SHOP}/menu?gclid=test`);
    expect(withCampaignTags(`${SHOP}/menu?gclid=mine`, { gclid: "test" })).toBe(
      `${SHOP}/menu?gclid=mine`,
    );
  });
});

// ---- unit: survival over hop lists ----------------------------------------------------------------

describe("tagSurvival: unit", () => {
  const start = `${SHOP}/go?utm_source=facebook&utm_medium=paid&gclid=Cj0demo`;

  it("a page with no redirect at all passes, with nothing to walk", () => {
    const s = tagSurvival([hop(start)]);
    expect(s.sent).toEqual({ utm_source: "facebook", utm_medium: "paid", gclid: "Cj0demo" });
    expect(s.arrived).toEqual(s.sent);
    expect(s.lostAt).toBeUndefined();
    expect(tagSurvival([])).toEqual({ sent: {}, arrived: {} });
  });

  it("all kept through two redirects, reordered, is fine", () => {
    const s = tagSurvival([
      hop(start, 301, "/menu?gclid=Cj0demo&utm_medium=paid&utm_source=facebook"),
      hop(
        `${SHOP}/menu?gclid=Cj0demo&utm_medium=paid&utm_source=facebook`,
        302,
        "/landing?utm_source=facebook&gclid=Cj0demo&utm_medium=paid",
      ),
      hop(`${SHOP}/landing?utm_source=facebook&gclid=Cj0demo&utm_medium=paid`),
    ]);
    expect(s.lostAt).toBeUndefined();
    expect(s.arrived).toEqual(s.sent);
  });

  it("one key dropped at hop 2 is reported at hop 2 with that key only", () => {
    const second = `${SHOP}/menu?utm_source=facebook&utm_medium=paid&gclid=Cj0demo`;
    const s = tagSurvival([
      hop(start, 301, second),
      hop(second, 302, "/landing?utm_source=facebook&utm_medium=paid"),
      hop(`${SHOP}/landing?utm_source=facebook&utm_medium=paid`),
    ]);
    expect(s.lostAt).toEqual({
      hop: 2,
      from: second,
      to: `${SHOP}/landing?utm_source=facebook&utm_medium=paid`,
      status: 302,
      keys: ["gclid"],
    });
    expect(s.arrived).toEqual({ utm_source: "facebook", utm_medium: "paid" });
  });

  it("everything dropped at hop 1 lists every key", () => {
    const s = tagSurvival([hop(start, 301, "/landing"), hop(`${SHOP}/landing`)]);
    expect(s.lostAt).toMatchObject({
      hop: 1,
      from: start,
      to: `${SHOP}/landing`,
      status: 301,
      keys: ["utm_source", "utm_medium", "gclid"],
    });
    expect(s.arrived).toEqual({});
  });

  it("a value written again (%20 against +, a different case of the key) counts as kept", () => {
    const s = tagSurvival([
      hop(
        `${SHOP}/go?utm_campaign=autumn%20menu&UTM_Source=a+b`,
        301,
        "/landing?utm_campaign=autumn+menu&utm_source=a%20b",
      ),
      hop(`${SHOP}/landing?utm_campaign=autumn+menu&utm_source=a%20b`),
    ]);
    expect(s.lostAt).toBeUndefined();
    expect(s.sent).toEqual({ utm_campaign: "autumn menu", utm_source: "a b" });
  });

  it("a value that was changed is lost: the report no longer says what the ad said", () => {
    const s = tagSurvival([
      hop(`${SHOP}/go?utm_source=facebook`, 302, "/landing?utm_source=fb"),
      hop(`${SHOP}/landing?utm_source=fb`),
    ]);
    expect(s.lostAt).toMatchObject({ hop: 1, keys: ["utm_source"] });
  });

  it("a key dropped and put back by a later hop survived; one that never came back did not", () => {
    const a = `${SHOP}/go?utm_source=facebook&gclid=x`;
    const s = tagSurvival([
      hop(a, 302, "/mid"),
      hop(`${SHOP}/mid`, 302, "/landing?utm_source=facebook"),
      hop(`${SHOP}/landing?utm_source=facebook`),
    ]);
    expect(s.lostAt).toMatchObject({ hop: 1, keys: ["gclid"] });
    expect(s.arrived).toEqual({ utm_source: "facebook" });
  });

  it("a redirect to another host that keeps the tags passes", () => {
    const s = tagSurvival([
      hop(
        start,
        301,
        "https://shop.tapas-bar.example/landing?gclid=Cj0demo&utm_medium=paid&utm_source=facebook",
      ),
      hop(
        "https://shop.tapas-bar.example/landing?gclid=Cj0demo&utm_medium=paid&utm_source=facebook",
      ),
    ]);
    expect(s.lostAt).toBeUndefined();
  });

  it("a redirect that moves the tags into the fragment is lost, and says where they went", () => {
    const s = tagSurvival([
      hop(`${SHOP}/go?utm_source=facebook&gclid=x`, 302, "/landing#utm_source=facebook"),
      hop(`${SHOP}/landing#utm_source=facebook`),
    ]);
    expect(s.lostAt).toMatchObject({
      hop: 1,
      keys: ["utm_source", "gclid"],
      inFragment: ["utm_source"],
    });
    const text = describeTrail([
      hop(`${SHOP}/go?utm_source=facebook&gclid=x`, 302, "/landing#utm_source=facebook"),
      hop(`${SHOP}/landing#utm_source=facebook`),
    ]);
    expect(text.notes.join(" ")).toContain("servers never see");
  });

  it("a trail that ends on a redirect it could not follow still reads that redirect's Location", () => {
    const s = tagSurvival([hop(`${SHOP}/a?utm_source=x`, 302, "/b")]);
    expect(s.lostAt).toMatchObject({ hop: 1, keys: ["utm_source"], to: `${SHOP}/b` });
  });

  it("a hop the fetcher refused to request counts as where the trail ended", () => {
    const s = tagSurvival([
      hop(`${SHOP}/a?utm_source=x`, 302, "http://127.0.0.1/b?utm_source=x"),
      {
        url: "http://127.0.0.1/b?utm_source=x",
        status: 0,
        headers: {},
        ms: 0,
        error: "private-address-refused",
      },
    ]);
    expect(s.lostAt).toBeUndefined();
  });

  it("a status other than 200 at the end does not change the tag verdict", () => {
    const s = tagSurvival([hop(`${SHOP}/a?utm_source=x`, 301, "/gone"), hop(`${SHOP}/gone`, 404)]);
    expect(s.lostAt).toMatchObject({ hop: 1, status: 301 });
  });
});

describe("describeTrail", () => {
  it("one line per hop with the keys still there, then one verdict", () => {
    const hops = [
      hop(`${SHOP}/go?utm_source=x&gclid=y`, 302, "/landing?utm_source=x"),
      hop(`${SHOP}/landing?utm_source=x`),
    ];
    const t = describeTrail(hops);
    expect(t.hops).toEqual([
      `hop 1  302  ${SHOP}/go?utm_source=x&gclid=y  tags: utm_source, gclid`,
      `hop 2  200  ${SHOP}/landing?utm_source=x  tags: utm_source`,
    ]);
    expect(t.verdict).toBe(
      `Campaign tags lost at hop 1: the 302 from ${SHOP}/go to ${SHOP}/landing dropped gclid. utm_source arrived.`,
    );
  });

  it("a pass says what arrived and how many redirects it took", () => {
    expect(describeTrail([hop(`${SHOP}/a?utm_source=x`)]).verdict).toBe(
      "Campaign tags kept: utm_source arrived (no redirect).",
    );
    const two = describeTrail([
      hop(`${SHOP}/a?utm_source=x&gclid=1`, 301, "/b?utm_source=x&gclid=1"),
      hop(`${SHOP}/b?utm_source=x&gclid=1`, 301, "/c?utm_source=x&gclid=1"),
      hop(`${SHOP}/c?utm_source=x&gclid=1`),
    ]);
    expect(two.verdict).toBe("Campaign tags kept: utm_source, gclid arrived (2 redirects).");
  });

  it("notes a final page that does not load, and leaves it to the dead-page check", () => {
    const t = describeTrail([
      hop(`${SHOP}/a?utm_source=x`, 301, `/gone?utm_source=x`),
      hop(`${SHOP}/gone?utm_source=x`, 404),
    ]);
    expect(t.verdict).toContain("Campaign tags kept");
    expect(t.notes.join(" ")).toContain("404");
  });
});

// ---- integration: the fixture site ---------------------------------------------------------------

const ads = (links: string[], extra: Partial<AdRow> = {}): AdRow[] =>
  links.map((link, i) => ({
    name: `Ad ${i + 1}`,
    link,
    spend: 1000 * (i + 1),
    currency: "USD",
    ...extra,
  }));

describe("checkAdLandingPages: the fixture site", () => {
  async function run(links: string[]) {
    const site = await startFixture("ad-redirects");
    try {
      const fetcher = createFetcher({ allowPrivate: true });
      const groups = groupByDestination(ads(links.map((l) => l.replace("ORIGIN", site.origin))));
      const out = await checkAdLandingPages(groups, { fetcher });
      return { out, site };
    } finally {
      await site.close();
    }
  }

  it("/go to a 301 without the query: the finding names the 301 and every key", async () => {
    const { out, site } = await run([
      "ORIGIN/go?utm_source=facebook&utm_medium=paid&utm_campaign=autumn-menu&gclid=Cj0demo",
    ]);
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f).toMatchObject({
      checkId: "campaign-fields-lost",
      severity: "high",
      url: `${site.origin}/go`,
    });
    expect(f?.evidence).toContain("301");
    expect(f?.evidence).toContain(`${site.origin}/go`);
    expect(f?.evidence).toContain(`${site.origin}/landing`);
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "gclid"])
      expect(f?.evidence).toContain(key);
    expect(f?.evidence).toContain("hop 1");
    expect(f?.evidence).toContain("10.00 USD");
    expect(out.passed).not.toContain("campaign-fields-lost");
  });

  it("a 302 that keeps utm_* and drops gclid lists gclid only", async () => {
    const { out } = await run([
      "ORIGIN/go-keeps?utm_source=facebook&utm_medium=paid&utm_campaign=autumn-menu&gclid=Cj0demo",
    ]);
    expect(out.findings).toHaveLength(1);
    const evidence = out.findings[0]?.evidence ?? "";
    expect(evidence).toContain("302");
    expect(evidence).toMatch(/drop(s|ped)? gclid\b/);
    expect(evidence).not.toMatch(/drop(s|ped)? [^.]*utm_/);
  });

  it("the second redirect of a chain is the hop that is named", async () => {
    const { out, site } = await run(["ORIGIN/chain?utm_source=facebook&utm_medium=paid"]);
    expect(out.findings[0]?.evidence).toContain("hop 2");
    expect(out.findings[0]?.evidence).toContain(`${site.origin}/chain-2`);
  });

  it("a redirect that moves the tag into the fragment is reported, with the note about fragments", async () => {
    const { out } = await run(["ORIGIN/go-fragment?utm_source=facebook"]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.evidence).toContain("servers never see");
  });

  it("a page with no redirect passes; a missing final page still gets its tag verdict", async () => {
    const { out } = await run([
      "ORIGIN/landing?utm_source=facebook",
      "ORIGIN/gone?utm_source=facebook",
    ]);
    // The 404 is the page check's to report (ad-dead-page); the tags themselves are fine.
    expect(out.findings.map((f) => f.checkId)).toEqual(["ad-dead-page"]);
    expect(out.passed).toContain("campaign-fields-lost");
    expect(out.probes.map((p) => p.hops.at(-1)?.status)).toEqual([200, 404]);
  });

  it("a trail that loops after keeping its tags is not a loss, and is not a pass either", async () => {
    const { out } = await run(["ORIGIN/loop-a?utm_source=facebook"]);
    // A page that redirects in a loop does not load: that is ad-dead-page's finding.
    expect(out.findings.map((f) => f.checkId)).toEqual(["ad-dead-page"]);
    expect(out.couldNotCheck).toHaveLength(1);
    expect(out.couldNotCheck[0]).toMatchObject({ id: "campaign-fields-lost" });
    expect(out.passed).not.toContain("campaign-fields-lost");
  });

  it("an export with no tags on a link is tested with Gaugeline's own values, and the finding says so", async () => {
    const { out, site } = await run(["ORIGIN/go", "ORIGIN/landing"]);
    expect(out.probes[0]?.source).toBe("probe");
    expect(out.probes[0]?.requested).toBe(
      `${site.origin}/go?utm_source=${PROBE_TAGS.utm_source}&gclid=${PROBE_TAGS.gclid}`,
    );
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.evidence).toContain("utm_source=gaugeline-check");
    expect(out.findings[0]?.evidence).toContain("gclid=test");
    expect(out.findings[0]?.evidence).toMatch(/Gaugeline's own/);
  });

  it("when the export has tags, the first ad's real values are the ones sent, and the finding does not repeat them", async () => {
    const { out, site } = await run([
      "ORIGIN/go",
      "ORIGIN/go?utm_source=instagram&utm_campaign=autumn-menu",
      "ORIGIN/go?utm_source=facebook",
    ]);
    expect(out.probes).toHaveLength(1);
    expect(out.probes[0]).toMatchObject({ source: "export", ads: 3 });
    expect(out.probes[0]?.requested).toBe(
      `${site.origin}/go?utm_source=instagram&utm_campaign=autumn-menu`,
    );
    expect(out.findings[0]?.evidence).not.toContain("instagram");
    expect(out.findings[0]?.evidence).toContain("60.00 USD");
  });

  it("4 destinations for 12 ads make exactly 4 first requests, only GET or HEAD, at most 5 at a time", async () => {
    const site = await startFixture("ad-redirects");
    try {
      const paths = ["landing", "", "gone", "go-keeps"];
      const rows = ads(
        Array.from(
          { length: 12 },
          (_, i) => `${site.origin}/${paths[i % 4]}?utm_source=facebook&utm_campaign=c${i}`,
        ),
      );
      const fetcher = createFetcher({ allowPrivate: true });
      const groups = groupByDestination(rows);
      expect(groups.size).toBe(4);
      const out = await checkAdLandingPages(groups, { fetcher });
      expect(out.probes).toHaveLength(4);
      // The one redirect adds its own second request; the four first requests are one per destination.
      expect(site.total).toBe(5);
      expect(site.hits.get("/go-keeps")).toBe(1);
      expect([...site.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
      expect(fetcher.stats.maxInFlight).toBeLessThanOrEqual(5);
    } finally {
      await site.close();
    }
  });

  it("300 destinations still make 300 first requests and never more than 5 at once", async () => {
    const fetcher = createFetcher({
      transport: () =>
        Promise.resolve({
          status: 200,
          headers: {},
          body: Readable.from(
            (async function* () {
              await new Promise((r) => setTimeout(r, 1));
              yield Buffer.from("ok");
            })(),
          ),
        }),
    });
    const rows = ads(Array.from({ length: 300 }, (_, i) => `${SHOP}/page-${i}?utm_source=a`));
    const out = await checkAdLandingPages(groupByDestination(rows), { fetcher });
    expect(fetcher.stats.requests).toBe(300);
    expect(fetcher.stats.maxInFlight).toBeLessThanOrEqual(5);
    expect(out.findings).toEqual([]);
  });

  it("an address that cannot be reached is could-not-check for that page, not a finding or a pass", async () => {
    const fetcher = createFetcher({ transport: () => Promise.reject(new Error("boom")) });
    const out = await checkAdLandingPages(groupByDestination(ads([`${SHOP}/a?utm_source=x`])), {
      fetcher,
    });
    // The tags could not be followed; that the page is unreachable is ad-dead-page's finding.
    expect(out.findings.map((f) => f.checkId)).toEqual(["ad-dead-page"]);
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck).toEqual([
      expect.objectContaining({ id: "campaign-fields-lost", url: `${SHOP}/a` }),
    ]);
  });
});

// ---- the check on its own -------------------------------------------------------------------------

describe("campaign-fields-lost: the check", () => {
  it("is registered, high, and the same probes give the same findings", async () => {
    expect(CAMPAIGN_CHECKS.map((c) => [c.id, c.severity])).toEqual([
      ["campaign-fields-lost", "high"],
    ]);
    const input = {
      probes: [
        {
          url: `${SHOP}/go`,
          requested: `${SHOP}/go?utm_source=x`,
          source: "export" as const,
          tags: { utm_source: "x" },
          hops: [hop(`${SHOP}/go?utm_source=x`, 301, "/landing"), hop(`${SHOP}/landing`)],
          ads: 2,
          spend: [{ currency: "USD", amount: 150075 }],
        },
      ],
    };
    const a = await runChecks(input, createCampaignRegistry());
    const b = await runChecks(input, createCampaignRegistry());
    expect(a.findings).toEqual(b.findings);
    expect(a.findings[0]?.evidence).toContain("2 ads");
    expect(a.findings[0]?.evidence).toContain("1500.75 USD");
  });

  it("two currencies are named side by side and never added", async () => {
    const r = await runChecks(
      {
        probes: [
          {
            url: `${SHOP}/go`,
            requested: `${SHOP}/go?utm_source=x`,
            source: "export" as const,
            tags: { utm_source: "x" },
            hops: [hop(`${SHOP}/go?utm_source=x`, 301, "/landing"), hop(`${SHOP}/landing`)],
            ads: 2,
            spend: [
              { currency: "EUR", amount: 4000 },
              { currency: "USD", amount: 2500 },
            ],
          },
        ],
      },
      createCampaignRegistry(),
    );
    expect(r.findings[0]?.evidence).toContain("40.00 EUR + 25.00 USD");
  });
});
