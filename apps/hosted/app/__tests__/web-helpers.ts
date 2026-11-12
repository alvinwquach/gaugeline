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
  seed,
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
