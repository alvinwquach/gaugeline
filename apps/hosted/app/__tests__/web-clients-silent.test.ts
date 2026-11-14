// check-community: allow-email (invented people at reserved example domains: the sign-in tests need addresses)
/**
 * The all-clients page against a real Postgres: a client with no run in the last 7 days shows "No run in N days"
 * (or "No run yet") instead of zeros and is listed first; the nav links to it for staff only. The page's clock
 * is the fixture's (12 Nov 2026 09:00 UTC), never the real one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_DATABASE, ORG_A, SITE_A1, SITE_A2 } from "../../db/__tests__/harness.js";
import { fixture, PEOPLE, type Fixture } from "./web-helpers.js";

const BUSY = "c1000000-0000-4000-8000-0000000000c1"; // the bar: a run 2 days ago, 1 high finding
const NEVER = "c2000000-0000-4000-8000-0000000000c2"; // a site, never run
const EIGHT = "c3000000-0000-4000-8000-0000000000c3"; // last run 8 days ago
const EDGE = "c4000000-0000-4000-8000-0000000000c4"; // last run exactly 7 days ago
const JUST = "c5000000-0000-4000-8000-0000000000c5"; // last run 7 days and 1 minute ago
const MULTI = "c6000000-0000-4000-8000-0000000000c6"; // two sites: one stale, one run 1 day ago
const HOSTILE = "c7000000-0000-4000-8000-0000000000c7"; // last run 30 days ago, a name with markup
const S = (n: number) => `a${n}000000-0000-4000-8000-0000000000a${n}`;

describe.skipIf(!HAS_DATABASE)("silent clients on /clients", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture(); // now = 2026-11-12T09:00:00Z; the seed's bar run is 10 Nov 03:00 (a run 2 days ago)
    const sites = [3, 4, 5, 6, 7, 8].map(
      (n) => `('${S(n)}', '${ORG_A}', 'Site ${n}', 'https://site-${n}.test', 'UTC')`,
    );
    await f.owner.unsafe(`
      insert into public.sites (id, org_id, name, url, timezone) values ${sites.join(", ")};
      insert into public.clients (id, org_id, name) values
        ('${BUSY}', '${ORG_A}', 'Busy Bar Group'), ('${NEVER}', '${ORG_A}', 'Never Run Nursery'),
        ('${EIGHT}', '${ORG_A}', 'Eight Day Eatery'), ('${EDGE}', '${ORG_A}', 'Edge Cafe'),
        ('${JUST}', '${ORG_A}', 'Just Over Joinery'), ('${MULTI}', '${ORG_A}', 'Multi Site Market'),
        ('${HOSTILE}', '${ORG_A}', '<i>Quiet</i> & Co');
      update public.sites set client_id = '${BUSY}' where id = '${SITE_A1}';
      update public.sites set client_id = '${NEVER}' where id = '${SITE_A2}';
      update public.sites set client_id = '${EIGHT}' where id = '${S(3)}';
      update public.sites set client_id = '${EDGE}' where id = '${S(4)}';
      update public.sites set client_id = '${JUST}' where id = '${S(5)}';
      update public.sites set client_id = '${MULTI}' where id in ('${S(6)}', '${S(7)}');
      update public.sites set client_id = '${HOSTILE}' where id = '${S(8)}';
      insert into public.runs (org_id, site_id, started_at) values
        ('${ORG_A}', '${S(3)}', '2026-11-04T09:00:00Z'),
        ('${ORG_A}', '${S(4)}', '2026-11-05T09:00:00Z'),
        ('${ORG_A}', '${S(5)}', '2026-11-05T08:59:00Z'),
        ('${ORG_A}', '${S(6)}', '2026-10-01T09:00:00Z'),
        ('${ORG_A}', '${S(7)}', '2026-11-11T09:00:00Z'),
        ('${ORG_A}', '${S(8)}', '2026-10-13T09:00:00Z');
    `);
  });
  afterAll(async () => {
    await f?.drop();
  });

  const cells = (html: string, name: string): string => {
    const at = html.indexOf(`<th scope="row">${name}</th>`);
    expect(at, name).toBeGreaterThan(0);
    return html.slice(at, html.indexOf("</tr>", at));
  };

  it("shows 'No run in 8 days' instead of zeros, and lists it before a client with high findings", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.maya.email);
    const html = await (await b.get("/clients")).text();
    expect(cells(html, "Eight Day Eatery")).toContain("No run in 8 days");
    expect(cells(html, "Eight Day Eatery")).not.toMatch(/<td class="num">0<\/td>/);
    expect(html.indexOf("Eight Day Eatery")).toBeLessThan(html.indexOf("Busy Bar Group"));
  });

  it("a client with a run 2 days ago is not silent and keeps its numbers", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.maya.email);
    const html = await (await b.get("/clients")).text();
    expect(cells(html, "Busy Bar Group")).not.toContain("No run");
    expect(cells(html, "Busy Bar Group")).not.toContain("colspan");
    expect(cells(html, "Busy Bar Group")).toMatch(/<td class="num">1<\/td>/);
  });

  it("a client with no run ever says 'No run yet', no number", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.maya.email);
    const html = await (await b.get("/clients")).text();
    expect(cells(html, "Never Run Nursery")).toContain("No run yet");
    expect(cells(html, "Never Run Nursery")).not.toMatch(/No run in/);
  });

  it("exactly 7 days is not silent; 7 days and a minute is", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.maya.email);
    const html = await (await b.get("/clients")).text();
    expect(cells(html, "Edge Cafe")).not.toContain("No run");
    expect(cells(html, "Just Over Joinery")).toContain("No run in 7 days");
  });

  it("a client with several sites is not silent when one has a fresh run", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.maya.email);
    const html = await (await b.get("/clients")).text();
    expect(cells(html, "Multi Site Market")).not.toContain("No run");
  });

  it("orders silent clients first, longest silent first (never run first), then the rest worst first", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.maya.email);
    const html = await (await b.get("/clients")).text();
    const order = [
      "Never Run Nursery",
      "&lt;i&gt;Quiet&lt;/i&gt; &amp; Co",
      "Eight Day Eatery",
      "Just Over Joinery",
      "Busy Bar Group",
    ].map((n) => html.indexOf(`<th scope="row">${n}</th>`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, c) => a - c)).toEqual(order);
  });

  it("escapes a client's name on a silent row", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.maya.email);
    const html = await (await b.get("/clients")).text();
    expect(html).not.toContain("<i>Quiet</i>");
    expect(cells(html, "&lt;i&gt;Quiet&lt;/i&gt; &amp; Co")).toContain("No run in 30 days");
  });

  it("the nav links to Clients for staff and not for a client viewer", async () => {
    for (const who of [PEOPLE.maya, PEOPLE.dev]) {
      const b = f.browser();
      await b.signIn(who.email);
      expect(await (await b.get("/")).text()).toContain('<a href="/clients"');
    }
    const viewer = f.browser();
    await viewer.signIn(PEOPLE.manager.email);
    expect(await (await viewer.get("/")).text()).not.toContain('href="/clients"');
  });
});
