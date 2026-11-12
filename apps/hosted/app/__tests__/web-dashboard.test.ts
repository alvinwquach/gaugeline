// check-community: allow-email (invented people at reserved example domains: the sign-in tests need addresses)
/**
 * The dashboard against a real Postgres (X63, part 2): sites worst first with the new finding shown,
 * read as the signed-in person, so two teams see only their own sites.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_DATABASE, ORG_A, ORG_B, SITE_A1, SITE_B1 } from "../../db/__tests__/harness.js";
import { asUser } from "../../lib/web/db.js";
import { listSites } from "../../lib/web/memberships.js";
import { siteSummaries } from "../../lib/web/dashboard.js";
import { fixture, PEOPLE, seedActivity, type Fixture } from "./web-helpers.js";

const text = (r: Response) => r.text();
const claims = (p: { id: string; email: string }) => ({
  sub: p.id,
  aud: "authenticated",
  role: "authenticated",
  email: p.email,
  iat: 1,
  exp: 4e9,
});

describe.skipIf(!HAS_DATABASE)("dashboard", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
    await seedActivity(f.owner);
  });
  afterAll(async () => {
    await f?.drop();
  });

  const summaries = (p: (typeof PEOPLE)[keyof typeof PEOPLE], org: string) =>
    asUser(f.appSql, claims(p), async (tx) => {
      const m = {
        orgId: org,
        orgName: "",
        role: (
          await tx`select role from public.members where user_id = ${p.id} and org_id = ${org}`
        )[0]!.role,
        siteId: (
          await tx`select site_id from public.members where user_id = ${p.id} and org_id = ${org}`
        )[0]!.site_id,
      };
      return siteSummaries(tx, await listSites(tx, m));
    });

  it("lists the team's sites worst first, with counts, trend and the new finding on the worst", async () => {
    const list = await summaries(PEOPLE.maya, ORG_A);
    expect(list.map((s) => [s.name, s.counts, s.trend])).toEqual([
      ["The Tidewater Bar", { high: 2, medium: 1, low: 0 }, "worse"],
      ["Harbour Yoga Studio", { high: 0, medium: 3, low: 0 }, "still"],
      ["Juniper Pop-up Kitchen", { high: 0, medium: 1, low: 0 }, "better"],
      ["Linden Bakery", null, "unchecked"],
    ]);
    expect(list[0]!.newest).toEqual({
      severity: "high",
      title: expect.stringContaining("Menu PDF"),
      evidence: expect.stringContaining("returns 404"),
    });
    // Still open is not new: the finding that was there last night is not shown as news.
    expect(list[1]!.newest).toBeNull();
    expect(list[2]!.newest).toBeNull();
  });

  it("two teams, two members: disjoint sites; a person in both sees both, per organisation", async () => {
    const a = await summaries(PEOPLE.maya, ORG_A);
    const b = await summaries(PEOPLE.ben, ORG_B);
    expect(a.map((s) => s.id).filter((id) => b.some((x) => x.id === id))).toEqual([]);
    expect(b.map((s) => s.id)).toEqual([SITE_B1]);
    expect(b[0]!.trend).toBe("first");
    // Asking for another team's sites by id, as someone who is not in that team, learns nothing: no counts, no run, no finding.
    const stolen = await asUser(f.appSql, claims(PEOPLE.ben), (tx) =>
      siteSummaries(tx, [{ id: SITE_A1, name: "x", url: "x", timezone: "UTC" }]),
    );
    expect(stolen.map((x) => [x.counts, x.lastRun, x.newest])).toEqual([[null, null, null]]);
    const both = await summaries(PEOPLE.both, ORG_B);
    expect(both.map((s) => s.id)).toEqual([SITE_B1]);
  });

  it("a client viewer's dashboard is their one site", async () => {
    const list = await summaries(PEOPLE.manager, ORG_A);
    expect(list.map((s) => s.id)).toEqual([SITE_A1]);
  });

  it("through the page: the worst site is first, its new finding is shown as text, nothing of another team", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.maya.email);
    const body = await text(await b.get("/"));
    const names = [
      "The Tidewater Bar",
      "Harbour Yoga Studio",
      "Juniper Pop-up Kitchen",
      "Linden Bakery",
    ];
    const at = names.map((n) => body.indexOf(n));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(body).toContain("Menu PDF");
    expect(body).toContain("Worse");
    expect(body).not.toContain("Maple Street Physio");
    // The hostile evidence line is text.
    expect(body).not.toContain("<img src=x");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("a client viewer's page has their site and no other, and a team with no sites is told what to do", async () => {
    const m = f.browser();
    await m.signIn(PEOPLE.manager.email);
    const mine = await text(await m.get("/"));
    expect(mine).toContain("The Tidewater Bar");
    expect(mine).not.toMatch(/Juniper|Harbour|Linden/);
    const e = f.browser();
    await e.signIn(PEOPLE.eve.email);
    const empty = await text(await e.get("/"));
    expect(empty).toContain("Quiet Cafe Co");
    expect(empty).toContain("No sites yet");
  });
});
