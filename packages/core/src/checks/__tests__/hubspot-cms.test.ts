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

const KEY = testKey("hubspot-checks");
const FINGERPRINT = { "hubdb.loaves": ["name", "price"] };

interface Setup {
  data?: HubspotFixtureData;
  site?: Record<string, LivePage>;
  denied?: string[];
  fingerprint?: Record<string, string[]>;
  maxPages?: number;
  after?: { count: number };
}

async function read(setup: Setup = {}) {
  const apiSeen: { url: string; authorization: string | undefined }[] = [];
  const siteSeen: { url: string; headers: Record<string, string> }[] = [];
  let n = 0;
  const base = hubspotWorld(setup.data ?? hubspotData(), setup.site ?? healthySite(), {
    token: KEY,
    ...(setup.denied ? { denied: setup.denied } : {}),
    onRequest: (_m, url, headers) =>
      apiSeen.push({ url: url.href, authorization: headers.authorization }),
    onSiteRequest: (_m, url, headers) => siteSeen.push({ url: url.href, headers }),
  });
  const transport: typeof base =
    setup.after === undefined
      ? base
      : (url, req) =>
          n++ >= (setup.after?.count ?? 0)
            ? Promise.resolve({
                status: 429,
                headers: { "retry-after": "3600" },
                body: (async function* () {
                  yield Buffer.from("{}");
                })() as never,
              })
            : base(url, req);
  const fetcher = createFetcher({ transport, timeoutMs: 5000 });
  const adapter = createHubspotCmsAdapter({
    env: { HUBSPOT_CMS_TOKEN: KEY },
    fetcher,
    settings: { id: "hubspot-cms", fingerprint: setup.fingerprint ?? FINGERPRINT },
    sleep: () => Promise.resolve(),
  });
  const reading = await readHubspotCms({
    adapter,
    fetcher,
    site: HUBSPOT_CMS_SITE,
    ...(setup.maxPages !== undefined ? { maxPages: setup.maxPages } : {}),
  });
  return { reading, apiSeen, siteSeen };
}

const run = (r: HubspotCmsReading) => runChecks(r, createHubspotCmsRegistry());
const evidence = (r: Awaited<ReturnType<typeof run>>, id: string): string[] =>
  r.findings.filter((f) => f.checkId === id).map((f) => f.evidence);
const reasons = (r: Awaited<ReturnType<typeof run>>): string =>
  r.couldNotCheck.map((c) => `${c.id}: ${c.reason}`).join("\n");

describe("HubSpot checks: a healthy bakery site", () => {
  it("has no finding from any of the three checks", async () => {
    const { reading } = await read();
    const out = await run(reading);
    expect(out.findings).toEqual([]);
    expect(out.passed.sort()).toEqual([
      "hubspot-form-deleted",
      "hubspot-hubdb-drift",
      "hubspot-page-404",
    ]);
    expect(out.couldNotCheck).toEqual([]);
    expect(reading.forms.checked).toBe(1);
  });

  it("a page in a different domain's content is not counted for this site", async () => {
    // The portal's second domain has a published landing page that would 404 if it were asked for.
    const { reading, siteSeen, apiSeen } = await read();
    expect(reading.otherDomain).toBe(1);
    expect(reading.pages.map((p) => p.url).some((u) => u.startsWith(HUBSPOT_CMS_OTHER_SITE))).toBe(
      false,
    );
    expect(siteSeen.map((s) => s.url).join("\n")).not.toContain("brass-whisk-wholesale");
    expect(apiSeen.length).toBeGreaterThan(0);
    const out = await run(reading);
    expect(evidence(out, "hubspot-page-404")).toEqual([]);
  });

  it("asks the live site with no key and no per-address header, and the CMS only with the key", async () => {
    const { apiSeen, siteSeen } = await read();
    for (const s of siteSeen) expect(Object.keys(s.headers)).not.toContain("authorization");
    for (const a of apiSeen) {
      expect(a.authorization).toBe(`Bearer ${KEY}`);
      expect(a.url).not.toContain(KEY);
      expect(new URL(a.url).origin).toBe("https://api.hubapi.com");
    }
  });

  it("the reading holds no title, text or value, and no key", async () => {
    const { reading } = await read();
    const text = JSON.stringify(reading);
    for (const marker of Object.values(HUBSPOT_CMS_MARKERS)) expect(text).not.toContain(marker);
    expect(text).not.toContain(KEY);
  });
});

describe("hubspot-page-404", () => {
  it("positive: a page published in HubSpot that is a 404 on the live domain", async () => {
    const site = healthySite();
    site["/holiday-preorder"] = { status: 404 };
    const { reading } = await read({ site });
    const out = await run(reading);
    expect(evidence(out, "hubspot-page-404")).toEqual([
      "landing-pages holiday-preorder is published in HubSpot and /holiday-preorder answers 404",
    ]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.url).toBe(`${HUBSPOT_CMS_SITE}/holiday-preorder`);
    expect(out.findings[0]?.severity).toBe("high");
  });

  it("negative: a draft that has no live page is not a finding", async () => {
    // /private-tasting is a draft in HubSpot and is not on the site: nothing says it is published.
    const { reading, siteSeen } = await read();
    expect(siteSeen.map((s) => s.url).join("\n")).not.toContain("private-tasting");
    expect(evidence(await run(reading), "hubspot-page-404")).toEqual([]);
  });

  it("a 503 is could-not-check for that page, never a finding or a pass", async () => {
    const site = healthySite();
    site["/about"] = { status: 503 };
    const out = await run((await read({ site })).reading);
    expect(out.findings).toEqual([]);
    expect(reasons(out)).toMatch(/the site answered 503/);
    expect(out.passed).not.toContain("hubspot-page-404");
  });

  it("a page with a dubious address is not asked: http, credentials and other hosts are dropped", async () => {
    const data = hubspotData();
    const first = data.pages["site-pages"][0];
    if (first) first.url = "http://brass-whisk.example/menu";
    const second = data.pages["site-pages"][1];
    if (second) second.url = ["https://user:pw", "brass-whisk.example/about"].join("@");
    const { reading } = await read({ data });
    expect(reading.noAddress).toBe(2);
    expect(reasons(await run(reading))).toMatch(/2 published pages had no usable https address/);
  });

  it("a rate limit that stays ends the read as partial, never a pass", async () => {
    const { reading } = await read({ after: { count: 2 } });
    expect(reading.partial?.reason).toBe("rate-limited");
    const out = await run(reading);
    expect(out.passed).not.toContain("hubspot-page-404");
    expect(reasons(out)).toMatch(/rate limit|slow/i);
  });

  it("stays within the page budget and says how many were not asked", async () => {
    const { reading } = await read({ maxPages: 2 });
    expect(reading.pages).toHaveLength(2);
    expect(reading.pagesSkipped).toBeGreaterThan(0);
    expect(reasons(await run(reading))).toMatch(/not asked for, because a run asks for at most 2/);
  });
});

describe("hubspot-hubdb-drift", () => {
  it("positive: a row whose price on the page is not the table's", async () => {
    const site = healthySite();
    site["/bread/rye"] = {
      status: 200,
      html: livePage(`<h1>${HUBSPOT_CMS_MARKERS.rye}</h1><p>$12.00</p>`),
    };
    const out = await run((await read({ site })).reading);
    expect(evidence(out, "hubspot-hubdb-drift")).toEqual([
      "hubdb.loaves row 7002: column price is not on /bread/rye",
    ]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.severity).toBe("medium");
    // The finding names the column, never the value or the client's words.
    const text = JSON.stringify(out.findings);
    expect(text).not.toContain(HUBSPOT_CMS_MARKERS.rye);
    expect(text).not.toContain("9.25");
  });

  it("negative: rows whose values are on their pages are not a finding", async () => {
    const out = await run((await read()).reading);
    expect(evidence(out, "hubspot-hubdb-drift")).toEqual([]);
    expect(out.passed).toContain("hubspot-hubdb-drift");
  });

  it("a number is not found inside a longer one (8.5 is not in 18.50)", () => {
    expect(valueOnPage(8.5, visibleText("<p>Only $18.50 today</p>"))).toBe(false);
    expect(valueOnPage(8.5, visibleText("<p>$8.50</p>"))).toBe(true);
    expect(valueOnPage(8.5, visibleText("<p>8.5</p>"))).toBe(true);
    expect(valueOnPage(1200, visibleText("<p>$1,200</p>"))).toBe(true);
    expect(
      valueOnPage("Dark rye &amp; caraway", visibleText("<b>Dark   rye</b> &amp; caraway")),
    ).toBe(true);
    expect(valueOnPage(true, "x")).toBeUndefined();
  });

  it("a table named in the settings that no dynamic page shows is could-not-check", async () => {
    const data = hubspotData();
    const dynamicPage = data.pages["site-pages"][2];
    if (dynamicPage) delete dynamicPage.dynamicPageHubDbTableId;
    const out = await run((await read({ data })).reading);
    expect(out.findings).toEqual([]);
    expect(out.passed).not.toContain("hubspot-hubdb-drift");
    expect(reasons(out)).toMatch(/hubdb\.loaves: no published dynamic page/);
  });

  it("a table that is not named in the settings is not read", async () => {
    const { reading, apiSeen } = await read({ fingerprint: {} });
    expect(apiSeen.map((a) => a.url).join("\n")).not.toContain("/hubdb/");
    expect(reading.hubdb).toEqual([]);
  });

  it("a table the settings name that HubSpot does not have is could-not-check", async () => {
    const { reading } = await read({ fingerprint: { "hubdb.nope": ["name"] } });
    expect(reasons(await run(reading))).toMatch(/hubdb\.nope: HubSpot would not give this/);
  });
});

describe("hubspot-form-deleted", () => {
  it("positive: a page that embeds a form HubSpot no longer has", async () => {
    const site = healthySite();
    site["/holiday-preorder"] = {
      status: 200,
      html: livePage("<h1>Pre-order</h1>", { portalId: HUBSPOT_CMS_PORTAL, formId: FORM_DELETED }),
    };
    const out = await run((await read({ site })).reading);
    expect(evidence(out, "hubspot-form-deleted")).toEqual([
      `form ${FORM_DELETED} no longer exists in HubSpot and is embedded on /holiday-preorder`,
    ]);
    expect(out.findings).toHaveLength(1);
  });

  it("negative: a form that exists is not a finding, and is asked about once however many pages embed it", async () => {
    const { reading, apiSeen } = await read();
    expect(evidence(await run(reading), "hubspot-form-deleted")).toEqual([]);
    expect(apiSeen.filter((a) => a.url.includes(`/forms/${FORM_LIVE}`))).toHaveLength(1);
  });

  it("a form of another portal is not counted as deleted", async () => {
    const site = healthySite();
    site["/holiday-preorder"] = {
      status: 200,
      html: livePage("<h1>Pre-order</h1>", { portalId: "99999", formId: FORM_DELETED }),
    };
    const { reading } = await read({ site });
    expect(reading.forms.otherPortal).toBe(1);
    expect(evidence(await run(reading), "hubspot-form-deleted")).toEqual([]);
  });

  it("a key without the forms scope is could-not-check for forms only", async () => {
    const site = healthySite();
    site["/holiday-preorder"] = { status: 404 };
    const { reading } = await read({ denied: ["/marketing/v3/forms"] });
    const out = await run((await read({ site, denied: ["/marketing/v3/forms"] })).reading);
    // The pages are still read and the 404 is still found: only the forms part is could-not-check.
    expect(evidence(out, "hubspot-page-404")).toHaveLength(1);
    expect(out.passed).not.toContain("hubspot-form-deleted");
    expect(reasons(out)).toMatch(/forms were not checked: the token may not read HubSpot forms/);
    expect(reading.forms.deleted).toEqual([]);
  });

  it("reads form and portal ids as text: nothing in the page is run, and a script's own words are not a form", () => {
    const html = `<div data-form-id="${FORM_LIVE}" data-portal-id="55"></div>
<script>hbspt.forms.create({ portalId: "55", formId: '${FORM_DELETED}' });</script>
<script>var formId = "not-a-uuid"; </script>`;
    expect(formEmbeds(html)).toEqual({
      formIds: [FORM_LIVE, FORM_DELETED].map((f) => f.toLowerCase()),
      portalIds: ["55"],
    });
  });
});

describe("a key that lacks a permission is could-not-check for that part only", () => {
  it("no HubDB scope: the pages and forms are still read, the HubDB part says so", async () => {
    const site = healthySite();
    site["/holiday-preorder"] = { status: 404 };
    const out = await run((await read({ site, denied: ["/cms/v3/hubdb"] })).reading);
    expect(evidence(out, "hubspot-page-404")).toHaveLength(1);
    expect(out.passed).toContain("hubspot-form-deleted");
    expect(out.passed).not.toContain("hubspot-hubdb-drift");
    expect(reasons(out)).toMatch(
      /hubdb: HubSpot would not give this \(HubSpot did not let the token read this \(HTTP 403\)/,
    );
  });

  it("no page scope for blog posts: the other lists are still read", async () => {
    const out = await run((await read({ denied: ["/cms/v3/blogs"] })).reading);
    expect(reasons(out)).toMatch(/blog-posts: HubSpot would not give this/);
    expect(out.passed).not.toContain("hubspot-page-404");
    // The blog posts' forms were not read either, so that check is not a pass; the HubDB part is.
    expect(out.passed).not.toContain("hubspot-form-deleted");
    expect(out.passed).toContain("hubspot-hubdb-drift");
  });
});

describe("a site with drift between the CMS and the page", () => {
  it("finds a 404, a drifted price and a deleted form together", async () => {
    const site = healthySite();
    site["/blog/new-oven"] = { status: 404 };
    site["/bread/sourdough"] = {
      status: 200,
      html: livePage(`<h1>${HUBSPOT_CMS_MARKERS.sourdough}</h1><p>$7.50</p>`, {
        portalId: HUBSPOT_CMS_PORTAL,
        formId: FORM_DELETED,
      }),
    };
    const out = await run((await read({ site })).reading);
    expect(out.findings.map((f) => f.checkId).sort()).toEqual([
      "hubspot-form-deleted",
      "hubspot-hubdb-drift",
      "hubspot-page-404",
    ]);
  });
});
