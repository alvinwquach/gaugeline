import { describe, expect, it } from "vitest";
import {
  FORM_DELETED,
  FORM_LIVE,
  HUBSPOT_CMS_MARKERS,
  HUBSPOT_CMS_OTHER_SITE,
  HUBSPOT_CMS_PORTAL,
  HUBSPOT_CMS_SITE,
  healthySite,
  hubspotData,
  hubspotWorld,
  livePage,
  type HubspotFixtureData,
  type LivePage,
} from "../../adapters/__tests__/hubspot-cms-fixture.js";
import { createHubspotCmsAdapter } from "../../adapters/hubspot-cms.js";
import {
  formEmbeds,
  readHubspotCms,
  valueOnPage,
  visibleText,
  type HubspotCmsReading,
} from "../../adapters/hubspot-cms-read.js";
import { testKey } from "../../connectors/__tests__/fake.js";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { createHubspotCmsRegistry } from "../hubspot-cms.js";

/** The independent review's findings on the HubSpot adapter, each pinned with a test. */
const KEY = testKey("hubspot-review");

async function read(
  setup: {
    data?: HubspotFixtureData;
    site?: Record<string, LivePage>;
    denied?: string[];
    fingerprint?: Record<string, string[]>;
    siteHost?: string;
  } = {},
): Promise<HubspotCmsReading> {
  const fetcher = createFetcher({
    transport: hubspotWorld(setup.data ?? hubspotData(), setup.site ?? healthySite(), {
      token: KEY,
      ...(setup.denied ? { denied: setup.denied } : {}),
    }),
    timeoutMs: 5000,
  });
  const adapter = createHubspotCmsAdapter({
    env: { HUBSPOT_CMS_TOKEN: KEY },
    fetcher,
    settings: {
      id: "hubspot-cms",
      fingerprint: setup.fingerprint ?? { "hubdb.loaves": ["name", "price"] },
    },
    sleep: () => Promise.resolve(),
  });
  return readHubspotCms({ adapter, fetcher, site: setup.siteHost ?? HUBSPOT_CMS_SITE });
}
const run = (r: HubspotCmsReading) => runChecks(r, createHubspotCmsRegistry());
const reasons = (r: Awaited<ReturnType<typeof run>>): string =>
  r.couldNotCheck.map((c) => `${c.id}: ${c.reason}`).join("\n");

/** Milliseconds one call takes. */
function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("1. text of an untrusted page is read in linear time", () => {
  const hostile: [string, string][] = [
    ["unterminated comments", "<!--".repeat(40_000)],
    ["unterminated script tags", "<script ".repeat(40_000)],
    ["unterminated tags", "<a ".repeat(40_000)],
    ["stray less-than signs", "< ".repeat(80_000)],
  ];
  for (const [name, html] of hostile)
    it(`${name}: well under a second`, () => {
      expect(timed(() => visibleText(html))).toBeLessThan(300);
    });

  it("still strips comments, scripts, styles and tags, and decodes entities", () => {
    const text = visibleText(
      `<p>Rye &amp; <b>caraway</b></p><!-- hidden --><script>var a = "<b>";</script><style>.x{}</style><NOSCRIPT>no</NOSCRIPT>a < b`,
    );
    expect(text).toBe("rye & caraway a < b");
  });

  it("an unterminated script or comment hides the rest, as a browser would", () => {
    expect(visibleText("<p>seen</p><script>var x = 1")).toBe("seen");
    expect(visibleText("<p>seen</p><!-- never closed <p>unseen</p>")).toBe("seen");
  });

  it("a page over 512 KB is not scanned: its rows are unread, its forms are could-not-check, its status still counts", async () => {
    const site = healthySite();
    site["/bread/rye"] = {
      status: 200,
      html: livePage(`<p>${HUBSPOT_CMS_MARKERS.rye} $9.25</p>${"<p>x</p>".repeat(80_000)}`),
    };
    const r = await read({ site });
    const row = r.hubdb.find((d) => d.rowId === "7002");
    expect(row?.state).toBe("unread");
    expect(row?.reason).toMatch(/larger than 512 KB/);
    expect(r.forms.unread).toMatch(/larger than 512 KB/);
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(out.passed).not.toContain("hubspot-hubdb-drift");
    expect(out.passed).not.toContain("hubspot-form-deleted");
  });
});

describe("2. a form id is bound to its own HubSpot embed", () => {
  const FOREIGN = "9f9f9f9f-0000-4000-8000-0000000000ff";

  it("only formIds inside hbspt.forms.create are read, with that call's portalId", () => {
    const html = `<script>hbspt.forms.create({portalId:"123456",formId:"${FORM_LIVE}"});</script>
<script>Foo.init({formId: "${FOREIGN}"});</script>`;
    expect(formEmbeds(html)).toEqual({
      forms: [{ formId: FORM_LIVE, portalId: "123456" }],
      truncated: false,
    });
  });

  it("a data-form-id takes the data-portal-id of its own element", () => {
    const html = `<div data-form-id="${FORM_LIVE}" data-portal-id="111"></div>
<div data-form-id="${FORM_DELETED}" data-portal-id="222"></div>
<div data-portal-id="333"></div>`;
    expect(formEmbeds(html).forms).toEqual([
      { formId: FORM_LIVE, portalId: "111" },
      { formId: FORM_DELETED, portalId: "222" },
    ]);
  });

  it("another vendor's formId on the page is never reported as a deleted HubSpot form", async () => {
    const site = healthySite();
    site["/holiday-preorder"] = {
      status: 200,
      html: livePage("<h1>x</h1>", { portalId: HUBSPOT_CMS_PORTAL, formId: FORM_LIVE }).replace(
        "</body>",
        `<script>Foo.init({formId: "${FOREIGN}"});</script></body>`,
      ),
    };
    const out = await run(await read({ site }));
    expect(out.findings).toEqual([]);
  });

  it("a deleted form in a real embed is still found", async () => {
    const site = healthySite();
    site["/holiday-preorder"] = {
      status: 200,
      html: livePage("<h1>x</h1>", { portalId: HUBSPOT_CMS_PORTAL, formId: FORM_DELETED }),
    };
    const out = await run(await read({ site }));
    expect(out.findings.map((f) => f.checkId)).toEqual(["hubspot-form-deleted"]);
  });
});

describe("3. forms past the per-page limit are could-not-check, not dropped", () => {
  const many = (n: number): string =>
    Array.from(
      { length: n },
      (_, i) =>
        `<div data-form-id="5c1d2e3f-0000-4000-8000-${String(i).padStart(12, "0")}" data-portal-id="${HUBSPOT_CMS_PORTAL}"></div>`,
    ).join("");

  it("reads 20 and says it stopped", () => {
    const e = formEmbeds(many(25));
    expect(e.forms).toHaveLength(20);
    expect(e.truncated).toBe(true);
    expect(formEmbeds(many(20)).truncated).toBe(false);
  });

  it("the reading and the check say which page had more", async () => {
    const site = healthySite();
    site["/about"] = { status: 200, html: livePage(many(25)) };
    const r = await read({ site });
    expect(r.forms.unread).toMatch(/more than 20 forms/);
    const out = await run(r);
    expect(out.passed).not.toContain("hubspot-form-deleted");
    expect(reasons(out)).toMatch(/more than 20 forms/);
  });
});

describe("4. the 404 check never passes on no evidence", () => {
  it("every published page is on another domain: could-not-check, naming why", async () => {
    const out = await run(await read({ siteHost: "https://brass-whisk-typo.example" }));
    expect(out.passed).not.toContain("hubspot-page-404");
    expect(out.passed).not.toContain("hubspot-form-deleted");
    expect(reasons(out)).toMatch(/none is on this site/);
  });

  it("the portal lists no published page: could-not-check", async () => {
    const data = hubspotData();
    data.pages["site-pages"] = [];
    data.pages["landing-pages"] = [];
    data.pages["blog-posts"] = [];
    const out = await run(await read({ data }));
    expect(out.passed).not.toContain("hubspot-page-404");
    expect(reasons(out)).toMatch(/lists no published page/);
  });

  it("a site with pages and some on another domain is still checked", async () => {
    const r = await read();
    expect(r.otherDomain).toBe(1);
    expect((await run(r)).passed).toContain("hubspot-page-404");
    expect(HUBSPOT_CMS_OTHER_SITE).not.toBe(HUBSPOT_CMS_SITE);
  });
});

describe("5. HubDB values are compared the way a page shows them, or not at all", () => {
  const text = (html: string) => visibleText(html);

  it("numbers in comma-decimal and grouped formats are found", () => {
    expect(valueOnPage(1234.5, text("<p>1.234,50 EUR</p>"))).toBe(true);
    expect(valueOnPage(1234.5, text("<p>$1,234.50</p>"))).toBe(true);
    expect(valueOnPage(19.9, text("<p>19,90</p>"))).toBe(true);
    expect(valueOnPage(1234.5, text("<p>1 234,50 EUR</p>"))).toBe(true);
    expect(valueOnPage(19.9, text("<p>19,95</p>"))).toBe(false);
    expect(valueOnPage(8.5, text("<p>18,50</p>"))).toBe(false);
  });

  it("a date column (epoch milliseconds) is not compared", () => {
    expect(valueOnPage(1730419200000, text("<p>Nov 1, 2026</p>"))).toBeUndefined();
  });

  it("short strings and small whole numbers are not compared", () => {
    expect(valueOnPage("5", text("<p>Open 24/7 since 2015</p>"))).toBeUndefined();
    expect(valueOnPage(5, text("<p>Open 24/7 since 2015</p>"))).toBeUndefined();
    expect(valueOnPage("ab", text("<p>about</p>"))).toBeUndefined();
  });

  it("a string must match whole words: rye is not found in 'dryer'", () => {
    expect(valueOnPage("rye", text("<p>a dryer day</p>"))).toBe(false);
    expect(valueOnPage("rye", text("<p>dark rye, today</p>"))).toBe(true);
    expect(valueOnPage("Dark rye &amp; caraway", text("<b>Dark   rye</b> &amp; caraway"))).toBe(
      true,
    );
  });

  it("a very long value is not compared", () => {
    expect(valueOnPage("word ".repeat(2000), text("<p>word</p>"))).toBeUndefined();
  });

  it("a date column in a row is could-not-check for that column, and the other columns still compare", async () => {
    const data = hubspotData();
    const row = data.tables[0]?.rows[0];
    if (row) row.values.opens = 1730419200000;
    const r = await read({
      data,
      fingerprint: { "hubdb.loaves": ["name", "price", "opens"] },
    });
    const sourdough = r.hubdb.find((d) => d.rowId === "7001");
    expect(sourdough?.state).toBe("matches");
    expect(sourdough?.notCompared).toEqual(["opens"]);
    const out = await run(r);
    expect(out.findings).toEqual([]);
    expect(reasons(out)).toMatch(/hubdb\.loaves: column opens .*not compared/);
    expect(out.passed).not.toContain("hubspot-hubdb-drift");
  });

  it("a column the table says is a DATE or DATETIME is not compared even when its value looks small", async () => {
    const data = hubspotData();
    const table = data.tables[0] as unknown as { columns?: { name: string; type: string }[] };
    table.columns = [{ name: "opens", type: "DATE" }];
    const row = data.tables[0]?.rows[0];
    if (row) row.values.opens = 123456;
    const r = await read({
      data,
      fingerprint: { "hubdb.loaves": ["name", "opens"] },
    });
    expect(r.hubdb.find((d) => d.rowId === "7001")?.notCompared).toEqual(["opens"]);
  });
});

describe("6. a page cut at the size limit is not used", () => {
  it("a truncated body is unread for rows and forms, never a match or a drift", async () => {
    const site = healthySite();
    site["/bread/rye"] = { status: 200, html: "x".repeat(5_300_000) };
    const r = await read({ site });
    const row = r.hubdb.find((d) => d.rowId === "7002");
    expect(row?.state).toBe("unread");
    expect(r.forms.unread).toBeDefined();
    expect((await run(r)).findings).toEqual([]);
  });
});

describe("7. a refused page list with a named table is not 'no dynamic page'", () => {
  it("says the pages were not read, still could-not-check", async () => {
    const r = await read({ denied: ["/cms/v3/pages/site-pages"] });
    expect(r.hubdbWithoutPage).toEqual([]);
    const out = await run(r);
    expect(out.passed).not.toContain("hubspot-hubdb-drift");
    expect(reasons(out)).toMatch(/hubdb\.loaves: .*pages that would show it were not all read/);
    expect(reasons(out)).not.toMatch(/no published dynamic page/);
  });
});

describe("8. a state Gaugeline does not recognise is counted, not skipped quietly", () => {
  it("notes the number of pages and does not call them published", async () => {
    const data = hubspotData();
    const page = data.pages["site-pages"][1];
    if (page) (page as { state: string }).state = "PUBLISHED_AND_PENDING";
    const r = await read({ data });
    expect(r.statesUnrecognised).toBe(1);
    const out = await run(r);
    expect(out.passed).not.toContain("hubspot-page-404");
    expect(reasons(out)).toMatch(/1 page has a state Gaugeline does not recognise/);
  });

  it("DRAFT and SCHEDULED are known and are not counted", async () => {
    const data = hubspotData();
    data.pages["site-pages"].push({
      id: "105",
      slug: "later",
      state: "SCHEDULED",
      updated: "2026-11-01T00:00:00.000Z",
      fields: {},
    });
    expect((await read({ data })).statesUnrecognised).toBe(0);
  });
});
