// check-community: allow-email (invented people at reserved example domains: the sign-in tests need addresses)
/**
 * The web app's database access, against a real Postgres (X63, part 1): it starts only on a login that
 * respects row-level security, every user query runs as `authenticated` with the person's claims, and two
 * people in different organisations see disjoint rows.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  SITE_A1,
  SITE_A2,
  SITE_B1,
} from "../../db/__tests__/harness.js";
import { APP_URL_ENV, asUser, openAppDatabase } from "../../lib/web/db.js";
import { listMemberships } from "../../lib/web/memberships.js";
import { fixture, PEOPLE, type Fixture } from "./web-helpers.js";

const claims = (p: { id: string; email: string }) => ({
  sub: p.id,
  aud: "authenticated",
  role: "authenticated",
  email: p.email,
  iat: 1,
  exp: 4e9,
});

describe.skipIf(!HAS_DATABASE)("web database access", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });
  afterAll(async () => {
    await f?.drop();
  });

  it("refuses to start on the owner's login, and says which variable to fix", async () => {
    await expect(openAppDatabase({ [APP_URL_ENV]: f.ownerUrl })).rejects.toThrow(
      /Refusing to start.*skips row-level security/s,
    );
    await expect(openAppDatabase({})).rejects.toThrow(/GAUGELINE_WEB_DATABASE_URL is not set/);
  });

  it("starts on the app's own login", async () => {
    const sql = await openAppDatabase({ [APP_URL_ENV]: f.appUrl });
    try {
      expect((await sql`select current_user as u`)[0]!.u).toBe(f.appRole);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it("refuses a login that is a member of service_role: the web app reads as people, never as the server", async () => {
    const role = `gl_sr_${Math.random().toString(16).slice(2, 8)}`;
    await f.owner.unsafe(
      `create role ${role} login noinherit nosuperuser nobypassrls password 'pw'; grant authenticated, service_role to ${role};`,
    );
    try {
      const u = new URL(f.ownerUrl);
      u.username = role;
      u.password = "pw";
      await expect(openAppDatabase({ [APP_URL_ENV]: u.href })).rejects.toThrow(/service_role/);
    } finally {
      await f.owner.unsafe(`drop owned by ${role}; drop role ${role}`);
    }
  });

  it("reads its address from its own variable, not the API's", () => {
    expect(APP_URL_ENV).toBe("GAUGELINE_WEB_DATABASE_URL");
  });

  it("asUser runs as `authenticated` with the person's id, and leaves the login role afterwards", async () => {
    const seen = await asUser(f.appSql, claims(PEOPLE.maya), async (tx) => {
      const r = await tx`select current_user as u, auth.uid() as uid`;
      return r[0]!;
    });
    expect(seen).toEqual({ u: "authenticated", uid: PEOPLE.maya.id });
    expect((await f.appSql`select current_user as u`)[0]!.u).toBe(f.appRole);
  });

  it("two people in different organisations see disjoint organisations and sites", async () => {
    const sites = async (p: (typeof PEOPLE)[keyof typeof PEOPLE]) =>
      asUser(f.appSql, claims(p), async (tx) =>
        (await tx`select id from public.sites order by id`).map((r) => r.id as string),
      );
    expect(await sites(PEOPLE.maya)).toEqual([SITE_A1, SITE_A2]);
    expect(await sites(PEOPLE.ben)).toEqual([SITE_B1]);
    expect(await sites(PEOPLE.manager)).toEqual([SITE_A1]);
    expect(await sites(PEOPLE.both)).toEqual([SITE_A1, SITE_A2, SITE_B1]);
    const orgs = async (p: (typeof PEOPLE)[keyof typeof PEOPLE]) =>
      asUser(f.appSql, claims(p), (tx) => listMemberships(tx, p.id));
    expect((await orgs(PEOPLE.maya)).map((m) => [m.orgId, m.role])).toEqual([[ORG_A, "owner"]]);
    expect((await orgs(PEOPLE.ben)).map((m) => m.orgId)).toEqual([ORG_B]);
    expect((await orgs(PEOPLE.both)).map((m) => [m.orgName, m.role])).toEqual([
      ["Brightfield Web", "admin"],
      ["Northgate Studio", "member"],
    ]);
    expect((await orgs(PEOPLE.manager))[0]).toMatchObject({ role: "client", siteId: SITE_A1 });
  });

  it("a person whose claims name nobody sees nothing, and a session without a role is refused", async () => {
    const ghost = { id: "99999999-0000-4000-8000-000000000009", email: "ghost@nowhere.test" };
    expect(
      await asUser(
        f.appSql,
        claims(ghost),
        async (tx) => (await tx`select * from public.sites`).length,
      ),
    ).toBe(0);
    await expect(
      asUser(f.appSql, { ...claims(PEOPLE.maya), sub: "not-a-uuid" }, async (tx) => tx`select 1`),
    ).rejects.toThrow();
  });

  it("a statement inside asUser cannot write what the policies forbid (no invented runs)", async () => {
    await expect(
      asUser(
        f.appSql,
        claims(PEOPLE.maya),
        (tx) =>
          tx`insert into public.runs (org_id, site_id, started_at) values (${ORG_A}, ${SITE_A1}, now())`,
      ),
    ).rejects.toThrow(/permission denied|row-level security/);
  });
});

describe("the web app's own code", () => {
  const dir = fileURLToPath(new URL("../../lib/web/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  const code = (f: string) =>
    readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

  it("never resets the role, sets one for the session, or reaches for service_role or the owner's address", () => {
    for (const f of files) {
      expect(code(f), f).not.toMatch(/reset\s+role/i);
      expect(code(f), f).not.toMatch(/session\s+authorization/i);
      expect(code(f), f).not.toMatch(/set\s+(?!local\s)role/i);
      if (f !== "db.ts") expect(code(f), f).not.toMatch(/service_role/);
      expect(code(f), f).not.toMatch(
        /(set\s+local\s+role|set_config\('role'[^)]*)\s*service_role/i,
      );
      expect(code(f), f).not.toMatch(/GAUGELINE_MIGRATE_URL/);
    }
  });

  it("only db.ts switches role, and nothing in it writes an id, decided_at or recorded_at", () => {
    expect(files.filter((f) => /set\s+local\s+role/i.test(code(f)))).toEqual(["db.ts"]);
    for (const f of files) expect(code(f), f).not.toMatch(/\b(decided_at|recorded_at)\b/);
  });

  it("reads the environment in deps.ts only (bar NODE_ENV), and no variable is a public one", () => {
    for (const f of files) {
      if (f !== "deps.ts") expect(code(f), f).not.toMatch(/process\.env(?!\.NODE_ENV)/);
      expect(code(f), f).not.toMatch(/NEXT_PUBLIC_|VITE_/);
    }
  });
});
