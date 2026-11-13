// check-community: allow-email (invented people at reserved example domains: the sign-in tests need addresses)
/**
 * The Supabase Auth adapter end to end against a LOCAL Supabase Auth (GoTrue) and its mail catcher
 * (Mailpit), with the app's real routes and the repository's row-level security policies (A-01, part 2).
 *
 * Runs only when GAUGELINE_SUPABASE_LOCAL_URL is set (the `supabase-local` CI job starts the local stack
 * with the Supabase CLI; no account or project is involved) and GAUGELINE_TEST_DATABASE_URL points at a
 * Postgres server for the app's tables. Everything here is a throwaway local stack: the JWT secret below is
 * the local stack's, never a project's.
 *
 *   GAUGELINE_SUPABASE_LOCAL_URL         the stack's API address (its API_URL), e.g. http://127.0.0.1:54321
 *   GAUGELINE_SUPABASE_LOCAL_ANON_KEY    the stack's anon key
 *   GAUGELINE_SUPABASE_LOCAL_JWT_SECRET  the stack's JWT secret (the test mints its admin token with it)
 *   GAUGELINE_SUPABASE_LOCAL_MAIL_URL    the stack's Mailpit address, e.g. http://127.0.0.1:54324
 *   GAUGELINE_SUPABASE_LOCAL_SERVICE_ROLE_KEY  optional: the stack's admin key, for this test's set-up
 *                                       only (else one is minted with the JWT secret); never the adapter's
 *   GAUGELINE_SUPABASE_LOCAL_JWKS        optional: the stack's public key set, when it signs ES256/RS256
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signHs256 } from "../../lib/web/auth.js";
import { SupabaseAuth } from "../../lib/web/supabase-auth.js";
import { HAS_DATABASE } from "../../db/__tests__/harness.js";
import { fixture, PEOPLE, type Fixture } from "./web-helpers.js";

const env = process.env;
const BASE = env.GAUGELINE_SUPABASE_LOCAL_URL ?? "";
const ANON = env.GAUGELINE_SUPABASE_LOCAL_ANON_KEY ?? "";
const SECRET = env.GAUGELINE_SUPABASE_LOCAL_JWT_SECRET ?? "";
const MAIL = env.GAUGELINE_SUPABASE_LOCAL_MAIL_URL ?? "";
/** Only the asymmetric public keys of the stack's key set (a shared-secret entry is not a public key). */
const JWKS = (() => {
  try {
    const keys = (
      JSON.parse(env.GAUGELINE_SUPABASE_LOCAL_JWKS ?? "") as { keys: { kty: string }[] }
    ).keys.filter((k) => k.kty === "EC" || k.kty === "RSA");
    return keys.length ? JSON.stringify({ keys }) : undefined;
  } catch {
    return undefined;
  }
})();
const RUN = BASE !== "" && HAS_DATABASE;

if (BASE !== "" && !HAS_DATABASE)
  throw new Error("GAUGELINE_SUPABASE_LOCAL_URL is set but GAUGELINE_TEST_DATABASE_URL is not.");

const nowS = () => Math.floor(Date.now() / 1000);
/** The local stack's admin token, for the test's own set-up only: the adapter never sees it. */
const admin = () =>
  signHs256(
    { role: "service_role", iss: "supabase-local", iat: nowS(), exp: nowS() + 600 },
    SECRET,
  );

async function gotrueAdmin(method: string, path: string, body?: object): Promise<Response> {
  return fetch(`${BASE}/auth/v1${path}`, {
    method,
    headers: {
      apikey: ANON,
      authorization: `Bearer ${admin()}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** The token hash in the newest link mailed to `email` after `since`, waiting for it to arrive. */
async function linkFor(email: string, since: Date): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const found = (await (await fetch(`${MAIL}/api/v1/search?query=to:${email}`)).json()) as {
      messages: { ID: string; Created: string }[];
    };
    const m = found.messages.find((x) => new Date(x.Created) >= since);
    if (m) {
      const text = (
        (await (await fetch(`${MAIL}/api/v1/message/${m.ID}`)).json()) as { Text: string }
      ).Text;
      const hash = /[?&]token=([0-9a-f]+)/.exec(text)?.[1];
      if (hash) return hash;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no link arrived for ${email}`);
}

describe.skipIf(!RUN)(
  "Supabase Auth, local stack: sign-in end to end with the RLS policies",
  () => {
    let f: Fixture;
    let auth: SupabaseAuth;
    // One link per person: Auth refuses a second link to the same address within its minimum interval.
    const people = [PEOPLE.maya, PEOPLE.manager, PEOPLE.ben, PEOPLE.dev, PEOPLE.both];

    beforeAll(async () => {
      f = await fixture();
      auth = new SupabaseAuth({
        url: BASE,
        anonKey: ANON,
        jwtSecret: SECRET,
        jwks: JWKS,
        nodeEnv: "test",
        answerAfterMs: 10,
        log: () => {},
      });
      f.deps.auth = auth;
      // Invited members: Auth users with the seed's own ids, so the seeded memberships are theirs.
      for (const p of people) {
        await gotrueAdmin("DELETE", `/admin/users/${p.id}`);
        const res = await gotrueAdmin("POST", "/admin/users", {
          id: p.id,
          email: p.email,
          email_confirm: true,
        });
        expect(res.status, await res.text()).toBe(200);
      }
    });
    afterAll(async () => {
      for (const p of people) await gotrueAdmin("DELETE", `/admin/users/${p.id}`);
      await f?.drop();
    });

    async function signIn(email: string) {
      const b = f.browser();
      const since = new Date(Date.now() - 1000);
      await b.post("/sign-in", { email });
      await auth.settled();
      const res = await b.post("/sign-in/verify", { token: await linkFor(email, since) });
      return { b, res };
    }

    it("a member signs in from the mailed link and sees only their organisation's sites", async () => {
      const { b, res } = await signIn(PEOPLE.maya.email);
      expect(res.status).toBe(303);
      const home = await (await b.get("/")).text();
      expect(home).toContain("Northgate Studio");
      expect(home).toContain("The Tidewater Bar");
      expect(home).toContain("Juniper Pop-up Kitchen");
      expect(home).not.toContain("Maple Street Physio");
    });

    it("a client viewer sees their one site; another organisation's owner sees none of Northgate's", async () => {
      const manager = await (await (await signIn(PEOPLE.manager.email)).b.get("/")).text();
      expect(manager).toContain("The Tidewater Bar");
      expect(manager).not.toContain("Juniper Pop-up Kitchen");
      const ben = await (await (await signIn(PEOPLE.ben.email)).b.get("/")).text();
      expect(ben).toContain("Maple Street Physio");
      expect(ben).not.toContain("The Tidewater Bar");
    });

    it("an address that is not invited gets the same answer and no mail; a link works once", async () => {
      const since = new Date(Date.now() - 1000);
      const b = f.browser();
      const res = await b.post("/sign-in", { email: "stranger@nowhere.test" });
      await auth.settled();
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Check your email");
      const none = (await (
        await fetch(`${MAIL}/api/v1/search?query=to:stranger@nowhere.test`)
      ).json()) as {
        messages: { Created: string }[];
      };
      expect(none.messages.filter((m) => new Date(m.Created) >= since)).toHaveLength(0);

      await b.post("/sign-in", { email: PEOPLE.dev.email });
      await auth.settled();
      const hash = await linkFor(PEOPLE.dev.email, since);
      expect((await auth.exchangeLink(hash)).ok).toBe(true);
      expect(await auth.exchangeLink(hash)).toEqual({ ok: false, reason: "invalid" });
    });

    it("refuses a forged, an expired and a service-role token", () => {
      const claims = {
        iss: `${BASE}/auth/v1`,
        sub: PEOPLE.maya.id,
        aud: "authenticated",
        role: "authenticated",
        session_id: "66666666-0000-4000-8000-000000000006",
        iat: nowS(),
        exp: nowS() + 600,
      };
      expect(auth.verify(signHs256(claims, SECRET))).not.toBeNull();
      expect(auth.verify(signHs256(claims, `${SECRET}-forged`))).toBeNull();
      expect(
        auth.verify(signHs256({ ...claims, iat: nowS() - 99, exp: nowS() - 9 }, SECRET)),
      ).toBeNull();
      expect(auth.verify(admin())).toBeNull();
      expect(auth.verify(signHs256({ ...claims, role: "service_role" }, SECRET))).toBeNull();
    });

    it("signing out ends the session at Supabase too: Auth no longer accepts the token", async () => {
      const { b } = await signIn(PEOPLE.both.email);
      const token = [...b.cookies.values()].find((v) => v.split(".").length === 3)!;
      const user = () =>
        fetch(`${BASE}/auth/v1/user`, {
          headers: { apikey: ANON, authorization: `Bearer ${token}` },
        });
      expect((await user()).status).toBe(200);
      await b.post("/sign-out", {});
      expect(auth.verify(token)).toBeNull();
      expect((await user()).status).not.toBe(200);
    });
  },
);
