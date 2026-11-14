// check-community: allow-email (invented people at reserved example domains: the sign-in tests need addresses)
/**
 * What happened last night against a real Postgres (X63, part 3): new, still open and closed findings by
 * fingerprint, read as the signed-in person.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_DATABASE, ORG_A, ORG_B, SITE_A1, SITE_B1 } from "../../db/__tests__/harness.js";
import { asUser } from "../../lib/web/db.js";
import { lastNight } from "../../lib/web/last-night.js";
import { listSites } from "../../lib/web/memberships.js";
import { fixture, PEOPLE, seedActivity, type Fixture } from "./web-helpers.js";

const claims = (p: { id: string; email: string }) => ({
  sub: p.id,
  aud: "authenticated",
  role: "authenticated",
  email: p.email,
  iat: 1,
  exp: 4e9,
});

describe.skipIf(!HAS_DATABASE)("last night", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
    await seedActivity(f.owner);
  });
  afterAll(async () => {
    await f?.drop();
  });

  const night = (
    p: (typeof PEOPLE)[keyof typeof PEOPLE],
    org: string,
    role = "owner",
    siteId: string | null = null,
  ) =>
    asUser(f.appSql, claims(p), async (tx) =>
      lastNight(
        tx,
        await listSites(tx, { orgId: org, orgName: "", role: role as "owner", siteId }),
      ),
    );

  it("splits each site's last run into new, still open and closed by fingerprint", async () => {
    const list = await night(PEOPLE.maya, ORG_A);
    const by = Object.fromEntries(list.map((s) => [s.name, s.changes]));
    expect(by["The Tidewater Bar"]).toMatchObject({ openedTotal: 2, stillOpen: 1, closedTotal: 0 });
    expect(by["The Tidewater Bar"]!.opened.map((i) => [i.severity, i.title])).toEqual([
      ["high", "Menu PDF is gone"],
      ["medium", "No canonical address"],
    ]);
    expect(by["Juniper Pop-up Kitchen"]).toMatchObject({
      openedTotal: 0,
      stillOpen: 1,
      closedTotal: 1,
    });
    expect(by["Juniper Pop-up Kitchen"]!.closed.map((i) => i.title)).toEqual([
      "Image has no alt text",
    ]);
    expect(by["Harbour Yoga Studio"]).toMatchObject({
      openedTotal: 0,
      stillOpen: 3,
      closedTotal: 0,
    });
    expect(by["Linden Bakery"]).toBeNull();
  });

  it("lists at most five of a kind and says how many more", async () => {
    const sid = "a5000000-0000-4000-8000-0000000000a5";
    const r1 = "a5a10000-0000-4000-8000-0000000000a1";
    const r2 = "a5a20000-0000-4000-8000-0000000000a2";
    await f.owner`insert into public.sites (id, org_id, name, url, timezone) values (${sid}, ${ORG_A}, 'Zed Many', 'https://zed.test', 'UTC')`;
    await f.owner`insert into public.runs (id, org_id, site_id, started_at) values (${r1}, ${ORG_A}, ${sid}, '2026-11-11T03:00:00Z'), (${r2}, ${ORG_A}, ${sid}, '2026-11-12T03:00:00Z')`;
    for (let i = 0; i < 8; i++)
      await f.owner`insert into public.findings (org_id, site_id, run_id, check_id, severity, title, evidence, url, fingerprint)
        values (${ORG_A}, ${sid}, ${r2}, 'seeded', ${i === 0 ? "high" : "medium"}, ${"Problem " + i}, '', 'https://zed.test/', ${"9" + String(i).padStart(15, "0")})`;
    const many = (await night(PEOPLE.maya, ORG_A)).find((s) => s.id === sid)!;
    expect(many.changes!.openedTotal).toBe(8);
    expect(many.changes!.opened).toHaveLength(5);
    expect(many.changes!.opened[0]!.severity).toBe("high");
  });

  it("two teams see only their own nights, a client viewer one site, a first check has no comparison", async () => {
    const b = await night(PEOPLE.ben, ORG_B);
    expect(b.map((s) => s.id)).toEqual([SITE_B1]);
    expect(b[0]!.changes).toBeNull();
    expect(b[0]!.trend).toBe("first");
    const client = await night(PEOPLE.manager, ORG_A, "client", SITE_A1);
    expect(client.map((s) => s.id)).toEqual([SITE_A1]);
  });

  it("through the page: grouped by what happened, with the bar first, and a sign-in is needed", async () => {
    expect((await f.browser().get("/last-night")).status).toBe(303);
    const b = f.browser();
    await b.signIn(PEOPLE.maya.email);
    const res = await b.get("/last-night");
    expect(res.status).toBe(200);
    const body = await res.text();
    const at = ["New problems", "Problems closed", "No change", "Not checked yet"].map((h) =>
      body.indexOf(h),
    );
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(body).toContain("Menu PDF is gone");
    expect(body).toContain("Image has no alt text");
    expect(body).not.toContain("<img src=x");
    expect(body).not.toContain("Maple Street Physio");
    expect(body).toMatch(/aria-current="page"[^>]*>Last night/);
    // The dashboard links to it.
    expect(await (await b.get("/")).text()).toContain('href="/last-night"');
  });
});
