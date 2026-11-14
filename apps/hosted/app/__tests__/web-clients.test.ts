// check-community: allow-email (invented people at reserved example domains: the sign-in tests need addresses)
/**
 * The agency's pages against a real Postgres (X66): all clients worst first, and the weekly update preview,
 * read as the signed-in person. A client viewer is sent to their own site; another agency's client is not found.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  SITE_A1,
  SITE_A2,
  SITE_B1,
} from "../../db/__tests__/harness.js";
import { fixture, PEOPLE, type Fixture } from "./web-helpers.js";

const BAR = "c1000000-0000-4000-8000-0000000000c1";
const KITCHEN = "c2000000-0000-4000-8000-0000000000c2";
const CLINIC = "c3000000-0000-4000-8000-0000000000c3";

describe.skipIf(!HAS_DATABASE)("clients pages", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
    await f.owner.unsafe(`
      insert into public.clients (id, org_id, name) values
        ('${BAR}', '${ORG_A}', 'Tidewater Hospitality'), ('${KITCHEN}', '${ORG_A}', 'Juniper Kitchens'),
        ('${CLINIC}', '${ORG_B}', 'Maple Street Health');
      update public.sites set client_id = '${BAR}' where id = '${SITE_A1}';
      update public.sites set client_id = '${KITCHEN}' where id = '${SITE_A2}';
      update public.sites set client_id = '${CLINIC}' where id = '${SITE_B1}';
      insert into public.runs (org_id, site_id, started_at) values ('${ORG_A}', '${SITE_A2}', '2026-11-11T03:00:00Z');
    `);
  });
  afterAll(async () => {
    await f?.drop();
  });

  it("lists the agency's clients worst first, with open counts and this week's update state", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.dev.email);
    const html = await (await b.get("/clients")).text();
    const bar = html.indexOf("Tidewater Hospitality");
    const kitchen = html.indexOf("Juniper Kitchens");
    expect(bar).toBeGreaterThan(0);
    expect(kitchen).toBeGreaterThan(bar);
    expect(html).toContain("Not drafted yet");
    expect(html).not.toContain("Maple Street Health");
  });

  it("previews a client's update in plain words, from the agency's name", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.maya.email);
    const res = await b.get(`/clients/update?client=${KITCHEN}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Juniper Kitchens: your sites, week of Mon 9 Nov");
    expect(html).toContain("<strong>From:</strong> Northgate Studio");
    expect(html).toContain("All checked, nothing found.");
    expect(html).toContain("a preview of what Friday");
  });

  it("another agency's client is not found, and a client viewer is sent to their own site", async () => {
    const b = f.browser();
    await b.signIn(PEOPLE.maya.email);
    expect((await b.get(`/clients/update?client=${CLINIC}`)).status).toBe(404);
    expect((await b.get("/clients/update?client=not-an-id")).status).toBe(404);
    const viewer = f.browser();
    await viewer.signIn(PEOPLE.manager.email);
    for (const path of ["/clients", `/clients/update?client=${BAR}`]) {
      const r = await viewer.get(path);
      expect(r.status, path).toBe(303);
      expect(r.headers.get("location"), path).toBe("/");
    }
  });
});
