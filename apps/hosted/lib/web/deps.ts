/**
 * What the web app is built from, and the one place that reads the environment.
 *
 *   GAUGELINE_WEB_DATABASE_URL    the web app's own database login (server-only): a member of `authenticated`
 *                                 and nothing else. Not the owner's address, not the runs API's login.
 *   GAUGELINE_APP_URL             the app's public address; https makes cookies Secure.
 *   GAUGELINE_AUTH                `supabase`, or `stand-in` for development and tests; anything else is not
 *                                 configured. The stand-in also needs NODE_ENV to be exactly `development` or `test`.
 *   GAUGELINE_STANDIN_SECRET      stand-in only: signs its tokens (32+ characters).
 *   GAUGELINE_STANDIN_USERS       stand-in only: `email=user-id,email=user-id`.
 *   SUPABASE_URL                  supabase only: the project's origin (https).
 *   SUPABASE_ANON_KEY             supabase only: the anon (publishable) key, sent as `apikey`.
 *   SUPABASE_JWT_SECRET           supabase only: the legacy JWT secret (HS256 tokens), and/or
 *   SUPABASE_JWKS                 supabase only: the project's public signing keys (ES256/RS256), as JSON.
 * Sign-in never reads SUPABASE_SERVICE_ROLE_KEY.
 *
 * The first request (or the server's start) opens the database and checks the login once; a refusal is
 * kept, so a server on a login that skips row-level security never serves a page.
 */
import { StandInAuth, type AuthProvider } from "./auth.js";
import { openAppDatabase, type Sql } from "./db.js";
import { SupabaseAuth } from "./supabase-auth.js";

export interface WebDeps {
  sql: Sql;
  auth: AuthProvider;
  /** https: cookies are Secure and named with the __Host- prefix. */
  secureCookies: boolean;
  now: () => Date;
}

export function standIn(env: Record<string, string | undefined>): AuthProvider {
  const users: Record<string, string> = {};
  for (const pair of (env.GAUGELINE_STANDIN_USERS ?? "").split(",")) {
    const [email, id] = pair.split("=").map((s) => s.trim());
    if (email && id) users[email] = id;
  }
  const base = env.GAUGELINE_APP_URL ?? "http://127.0.0.1:3000";
  return new StandInAuth({
    secret: env.GAUGELINE_STANDIN_SECRET ?? "",
    users,
    nodeEnv: env.NODE_ENV,
    // Development only: the stand-in has no mail server, so the link goes to the terminal that runs it.
    deliver: (email, token) =>
      void console.log(
        `[stand-in] sign-in link for ${email}: ${base}/sign-in/verify?token=${token}`,
      ),
  });
}

/** The provider GAUGELINE_AUTH names, refused at start-up when its settings are missing or weak. */
export function authFromEnv(env: Record<string, string | undefined>): AuthProvider {
  if (env.GAUGELINE_AUTH === "stand-in") return standIn(env);
  if (env.GAUGELINE_AUTH === "supabase")
    return new SupabaseAuth({
      url: env.SUPABASE_URL ?? "",
      anonKey: env.SUPABASE_ANON_KEY ?? "",
      jwtSecret: env.SUPABASE_JWT_SECRET,
      jwks: env.SUPABASE_JWKS,
      nodeEnv: env.NODE_ENV,
    });
  throw new Error("GAUGELINE_AUTH is not set to a configured provider (`supabase` or `stand-in`).");
}

export async function buildDeps(env: Record<string, string | undefined>): Promise<WebDeps> {
  const auth = authFromEnv(env);
  const sql = await openAppDatabase(env);
  return {
    sql,
    auth,
    secureCookies: (env.GAUGELINE_APP_URL ?? "").startsWith("https://"),
    now: () => new Date(),
  };
}

let shared: Promise<WebDeps> | undefined;

export function getWebDeps(): Promise<WebDeps> {
  shared ??= buildDeps(process.env);
  return shared;
}
