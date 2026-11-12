// check-community: allow-email (invented people at reserved example domains: the sign-in tests need addresses)
/**
 * A running web app for the tests: a fresh seeded database, the app's own login (not the owner, not a
 * superuser, a member of `authenticated` only), the stand-in auth with an inbox the tests can read, and a
 * `request` function that carries cookies like a browser would.
 */
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import {
  freshDatabase,
  ORG_A,
  RUN_A1,
  seed,
  SITE_A1,
  SITE_A2,
  TEST_DATABASE_URL,
  USER_A_CLIENT,
  USER_A_MEMBER,
  USER_A_OWNER,
  USER_B_OWNER,
  USER_BOTH,
  type Sql,
  type TestDatabase,
} from "../../db/__tests__/harness.js";
import { StandInAuth } from "../../lib/web/auth.js";
import type { WebDeps } from "../../lib/web/deps.js";
import { route } from "../../lib/web/routes.js";

export const SECRET = "test-secret-not-a-real-key-0123456789abcdef";
export const ORIGIN = "http://app.test";
export const PEOPLE = {
  maya: { email: "maya@northgate.test", id: USER_A_OWNER }, // owner of Northgate Studio
  dev: { email: "dev@northgate.test", id: USER_A_MEMBER }, // member of Northgate
  manager: { email: "manager@tidewater-bar.test", id: USER_A_CLIENT }, // client viewer of The Tidewater Bar
  ben: { email: "ben@brightfield.test", id: USER_B_OWNER }, // owner of Brightfield Web
  both: { email: "both@agency.test", id: USER_BOTH }, // member of Northgate, admin of Brightfield
  eve: { email: "eve@quiet-cafe.test", id: "55555555-0000-4000-8000-000000000001" }, // owner of a team with no sites
} as const;

export interface Fixture {
  db: TestDatabase;
  owner: Sql;
  appSql: Sql;
  appRole: string;
  /** The app login's connection address (a secret in real life). */
  appUrl: string;
  /** The owner's address (the migration role): what the app must refuse to start on. */
  ownerUrl: string;
  deps: WebDeps;
  inbox: { email: string; token: string }[];
  now: { t: Date };
  /** A browser: cookies kept between requests. */
  browser: () => Browser;
  drop: () => Promise<void>;
}

export interface Browser {
  get: (path: string, init?: RequestInit) => Promise<Response>;
  post: (
    path: string,
    form: Record<string, string>,
    init?: { origin?: string | null },
  ) => Promise<Response>;
  /** Sign in as someone through the real routes: ask for the link, open it, confirm. */
  signIn: (email: string) => Promise<Response>;
  cookies: Map<string, string>;
}

export async function fixture(): Promise<Fixture> {
  const db = await freshDatabase();
  await seed(db.sql);
  const role = `gl_web_${randomBytes(4).toString("hex")}`;
  const password = randomBytes(12).toString("hex");
  await db.sql.unsafe(
    `create role ${role} login noinherit nosuperuser nobypassrls password '${password}'; grant authenticated to ${role};`,
  );
  const dbName = (await db.sql`select current_database() as n`)[0]!.n as string;
  const ownerUrl = new URL(TEST_DATABASE_URL);
  ownerUrl.pathname = `/${dbName}`;
  const u = new URL(ownerUrl.href);
  u.username = role;
  u.password = password;
  const appSql = postgres(u.href, { max: 4, onnotice: () => {} });
  const inbox: Fixture["inbox"] = [];
  const now = { t: new Date("2026-11-12T09:00:00Z") };
  const deps: WebDeps = {
    sql: appSql,
    auth: new StandInAuth({
      secret: SECRET,
      users: Object.fromEntries(Object.values(PEOPLE).map((p) => [p.email, p.id])),
      deliver: (email, token) => void inbox.push({ email, token }),
      now: () => now.t,
    }),
    secureCookies: false,
    now: () => now.t,
  };
  const browser = (): Browser => {
    const cookies = new Map<string, string>();
    const send = async (path: string, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers);
      if (cookies.size) headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
      const res = await route(
        new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" }),
        deps,
      );
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const eq = pair!.indexOf("=");
        const name = pair!.slice(0, eq);
        const value = pair!.slice(eq + 1);
        if (/Max-Age=0/.test(c) || value === "") cookies.delete(name);
        else cookies.set(name, value);
      }
      return res;
    };
    const post: Browser["post"] = (path, form, init = {}) =>
      send(path, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(init.origin === null ? {} : { origin: init.origin ?? ORIGIN }),
        },
        body: new URLSearchParams(form).toString(),
      });
    return {
      cookies,
      get: send,
      post,
      signIn: async (email) => {
        const before = inbox.length;
        await post("/sign-in", { email });
        const sent = inbox[before];
        if (!sent) throw new Error(`no link was sent to ${email}`);
        return post("/sign-in/verify", { token: sent.token });
      },
    };
  };
  return {
    db,
    owner: db.sql,
    appSql,
    appRole: role,
    appUrl: u.href,
    ownerUrl: ownerUrl.href,
    deps,
    inbox,
    now,
    browser,
    drop: async () => {
      await appSql.end({ timeout: 1 });
      await db.sql
        .unsafe(`drop owned by ${role}; drop role if exists ${role}`)
        .catch(() => undefined);
      await db.drop();
    },
  };
}

export { TEST_DATABASE_URL };

export const ORG_C = "0c000000-0000-4000-8000-00000000000c"; // a team with no sites
export const SITE_A3 = "a3000000-0000-4000-8000-0000000000a3"; // a yoga studio: the same two nights running
export const SITE_A4 = "a4000000-0000-4000-8000-0000000000a4"; // a bakery never checked

/**
 * Nights of invented activity for Northgate (the seed has one run for the bar). Last night is 12 Nov 03:00 UTC.
 *   The Tidewater Bar     10 Nov: 1 high.  12 Nov: the same one, a new high whose evidence is hostile text, a medium.
 *   Juniper Pop-up Kitchen 11 Nov: 2 medium.  12 Nov: 1 of them.
 *   Harbour Yoga Studio    11 Nov and 12 Nov: the same 3 medium.
 *   Linden Bakery          never checked.
 * Quiet Cafe Co has one owner and no sites. Runs and findings are inserted as the owner, standing in for the
 * runs API: the app itself never writes them.
 */
export async function seedActivity(owner: Sql): Promise<void> {
  const fp = (n: number) => n.toString(16).padStart(16, "0");
  const run = (id: string, site: string, at: string) =>
    owner`insert into public.runs (id, org_id, site_id, started_at, finished_at) values (${id}, ${ORG_A}, ${site}, ${at}, ${at})`;
  const finding = (
    runId: string,
    site: string,
    sev: string,
    title: string,
    evidence: string,
    n: number,
  ) =>
    owner`insert into public.findings (org_id, site_id, run_id, check_id, severity, title, evidence, url, fingerprint)
      values (${ORG_A}, ${site}, ${runId}, 'seeded', ${sev}, ${title}, ${evidence}, 'https://example.test/', ${fp(n)})`;
  await owner`insert into public.organisations (org_id, name) values (${ORG_C}, 'Quiet Cafe Co')`;
  await owner`insert into public.members (org_id, user_id, role) values (${ORG_C}, ${PEOPLE.eve.id}, 'owner')`;
  await owner`insert into public.sites (id, org_id, name, url, timezone) values
    (${SITE_A3}, ${ORG_A}, 'Harbour Yoga Studio', 'https://harbour-yoga.test', 'Europe/London'),
    (${SITE_A4}, ${ORG_A}, 'Linden Bakery', 'https://linden-bakery.test', 'Europe/London')`;
  // The seed's high finding on the bar has fingerprint 0123456789abcdef (RUN_A1, 10 Nov).
  const barNight = "a1a20000-0000-4000-8000-0000000000a1";
  await run(barNight, SITE_A1, "2026-11-12T03:00:00Z");
  await owner`insert into public.findings (org_id, site_id, run_id, check_id, severity, title, evidence, url, fingerprint)
    values (${ORG_A}, ${SITE_A1}, ${barNight}, 'broken-links', 'high', 'Broken link on the menu page', '/menu links to /drinks-2025 (404)', 'https://tidewater-bar.test/menu', '0123456789abcdef')`;
  await finding(
    barNight,
    SITE_A1,
    "high",
    "Menu PDF is gone",
    "/menu links to <img src=x onerror=alert(1)> and returns 404",
    101,
  );
  await finding(
    barNight,
    SITE_A1,
    "medium",
    "No canonical address",
    "/book has no canonical link",
    102,
  );
  const jun1 = "a2a10000-0000-4000-8000-0000000000a1";
  const jun2 = "a2a20000-0000-4000-8000-0000000000a2";
  await run(jun1, SITE_A2, "2026-11-11T03:00:00Z");
  await run(jun2, SITE_A2, "2026-11-12T03:00:00Z");
  await finding(
    jun1,
    SITE_A2,
    "medium",
    "Opening hours differ",
    "Footer says 5pm, schema says 6pm",
    201,
  );
  await finding(jun1, SITE_A2, "medium", "Image has no alt text", "/gallery img 3", 202);
  await finding(
    jun2,
    SITE_A2,
    "medium",
    "Opening hours differ",
    "Footer says 5pm, schema says 6pm",
    201,
  );
  const yoga1 = "a3a10000-0000-4000-8000-0000000000a1";
  const yoga2 = "a3a20000-0000-4000-8000-0000000000a2";
  await run(yoga1, SITE_A3, "2026-11-11T03:00:00Z");
  await run(yoga2, SITE_A3, "2026-11-12T03:00:00Z");
  for (const [r, n] of [
    [yoga1, 0],
    [yoga2, 0],
  ] as const)
    for (const k of [301, 302, 303])
      await finding(r, SITE_A3, "medium", `Class page issue ${k}`, "/classes", k + n);
  void RUN_A1;
}
