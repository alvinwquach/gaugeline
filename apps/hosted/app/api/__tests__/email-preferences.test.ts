// check-community: allow-email (invented addresses on the reserved .test domain)
/**
 * The page a morning email's link opens, against a real Postgres. The link is a bearer token: opening it
 * shows the setting and changes nothing (mail scanners open links), and a POST with the token changes
 * that one person's setting. It never signs anyone in: no cookie, no session, nothing but this one row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  freshDatabase,
  HAS_DATABASE,
  ORG_A,
  ORG_B,
  seed,
  type Sql,
  type TestDatabase,
  USER_A_MEMBER,
  USER_A_OWNER,
} from "../../../db/__tests__/harness.js";
import { signToken } from "../../../lib/email/token.js";
import { getPreferences, postPreferences } from "../../../lib/email/preferences.js";
import { appLogin } from "./app-login.js";

const SECRET = "p".repeat(40);
const NOW = new Date("2026-11-12T07:10:00Z");
const BASE = "https://hosted.example/email/preferences";

describe.skipIf(!HAS_DATABASE)("the preference page", () => {
  let db: TestDatabase;
  let owner: Sql;
  let app: Awaited<ReturnType<typeof appLogin>>;
  const deps = () => ({ sql: app.sql, tokenSecret: SECRET, now: () => NOW });
  const tokenFor = (orgId: string, userId: string, at = NOW) =>
    signToken(SECRET, { orgId, userId }, at);

  beforeAll(async () => {
    db = await freshDatabase();
    owner = db.sql;
    await seed(owner);
    app = await appLogin(owner);
  });
  afterAll(async () => {
    await app?.drop();
    await db?.drop();
  });
  beforeEach(async () => {
    await owner`delete from public.email_preferences`;
    await owner`insert into public.email_preferences (org_id, user_id, email, email_confirmed_at, frequency)
      values (${ORG_A}, ${USER_A_OWNER}, 'owner@mail.example.test', now(), null),
             (${ORG_A}, ${USER_A_MEMBER}, 'dev@mail.example.test', now(), 'fix_first')`;
  });
  const freq = async (userId: string) =>
    (await owner`select frequency from public.email_preferences where user_id = ${userId}`)[0]!
      .frequency as string | null;
  const form = (t: string, frequency?: string) =>
    new Request(BASE, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ t, ...(frequency ? { frequency } : {}) }),
    });

  it("opening the link shows the current setting and changes nothing", async () => {
    const res = await getPreferences(
      new Request(`${BASE}?t=${tokenFor(ORG_A, USER_A_MEMBER)}`),
      deps(),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Northgate Studio");
    expect(html).toMatch(/fix first only/i);
    expect(html).not.toContain("dev@mail.example.test"); // the address is not shown to whoever holds the link
    expect(await freq(USER_A_MEMBER)).toBe("fix_first");
  });

  it("does not sign anyone in: no cookie, nothing cached, no referrer, no framing, no scripts", async () => {
    for (const res of [
      await getPreferences(new Request(`${BASE}?t=${tokenFor(ORG_A, USER_A_OWNER)}`), deps()),
      await postPreferences(form(tokenFor(ORG_A, USER_A_OWNER), "off"), deps()),
    ]) {
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(await res.text()).not.toMatch(/<script/i);
    }
  });

  it("choosing a setting changes that person's row, and only that", async () => {
    for (const choice of ["off", "every_change", "fix_first"]) {
      const res = await postPreferences(form(tokenFor(ORG_A, USER_A_OWNER), choice), deps());
      expect(res.status).toBe(200);
      expect(await freq(USER_A_OWNER)).toBe(choice);
    }
    expect(await freq(USER_A_MEMBER)).toBe("fix_first");
  });

  it("one-click unsubscribe (a POST with List-Unsubscribe=One-Click) turns it off", async () => {
    const req = new Request(`${BASE}?t=${tokenFor(ORG_A, USER_A_MEMBER)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect((await postPreferences(req, deps())).status).toBe(200);
    expect(await freq(USER_A_MEMBER)).toBe("off");
  });

  it("refuses a bad token, an expired token, another secret and an unknown choice, and changes nothing", async () => {
    const old = tokenFor(ORG_A, USER_A_OWNER, new Date(NOW.getTime() - 91 * 86_400_000));
    const other = signToken("q".repeat(40), { orgId: ORG_A, userId: USER_A_OWNER }, NOW);
    for (const t of ["", "nonsense", old, other]) {
      const res = await postPreferences(form(t, "off"), deps());
      expect(res.status, t).toBe(400);
      expect(
        (await getPreferences(new Request(`${BASE}?t=${encodeURIComponent(t)}`), deps())).status,
      ).toBe(400);
    }
    expect(
      (await postPreferences(form(tokenFor(ORG_A, USER_A_OWNER), "weekly"), deps())).status,
    ).toBe(400);
    expect(await freq(USER_A_OWNER)).toBeNull();
  });

  it("a token for a person who has no row (or left) is a not-found, and creates nothing", async () => {
    const res = await postPreferences(form(tokenFor(ORG_B, USER_A_OWNER), "off"), deps());
    expect(res.status).toBe(404);
    expect(
      await owner`select 1 from public.email_preferences where org_id = ${ORG_B}`,
    ).toHaveLength(0);
  });

  it("the organisation name is escaped, and a body over the cap is refused", async () => {
    await owner`update public.organisations set name = '<script>alert(1)</script> Studio' where org_id = ${ORG_A}`;
    const html = await (
      await getPreferences(new Request(`${BASE}?t=${tokenFor(ORG_A, USER_A_OWNER)}`), deps())
    ).text();
    await owner`update public.organisations set name = 'Northgate Studio' where org_id = ${ORG_A}`;
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    const big = new Request(BASE, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "t=" + "a".repeat(20_000),
    });
    expect((await postPreferences(big, deps())).status).toBe(400);
  });
});
