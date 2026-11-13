/**
 * Sign-in through Supabase Auth (GoTrue), email link only, behind the same `AuthProvider` as the stand-in.
 *
 *   requestLink   POST {SUPABASE_URL}/auth/v1/otp     {email, create_user: false}: invited members only
 *   exchangeLink  POST {SUPABASE_URL}/auth/v1/verify  {type: "email", token_hash}: the link's token hash
 *   verify        the access token, checked here (HS256 with the JWT secret, or ES256/RS256 against the
 *                 project's public key set), never by a request per page
 *   revoke        POST {SUPABASE_URL}/auth/v1/logout?scope=local with the session's own token, plus the
 *                 local revocation list, so a copy of the cookie stops working at once
 *
 * Only the anon (publishable) key is sent, as the `apikey` header. The service-role key is never read here.
 * Every request: an address built from the configured origin and a fixed path, no redirects followed, a
 * timeout, and a capped answer. What Supabase answers is never shown to the browser or logged; a log line
 * names the endpoint and the status only.
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import {
  claimsIfCurrent,
  MAX_TOKEN_LENGTH,
  verifyHs256,
  type AuthProvider,
  type Claims,
  type Exchange,
} from "./auth.js";

export interface SupabaseAuthOptions {
  /** SUPABASE_URL: the project's origin, https (http only to 127.0.0.1 or [::1] in development or test). */
  url: string;
  /** SUPABASE_ANON_KEY: the anon or publishable key. A service-role or secret key is refused. */
  anonKey: string;
  /** SUPABASE_JWT_SECRET: the legacy shared secret, for HS256 tokens. */
  jwtSecret?: string | undefined;
  /** SUPABASE_JWKS: the project's public keys (the JSON of /auth/v1/.well-known/jwks.json). */
  jwks?: string | undefined;
  nodeEnv?: string | undefined;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  /** Per request. */
  timeoutMs?: number;
  /** requestLink answers after exactly this long, whatever Supabase does, so timing tells nothing. */
  answerAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** The largest answer read from Supabase Auth; a session answer is a few kilobytes. */
export const MAX_ANSWER_BYTES = 64 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "[::1]"]);
const TOKEN_HASH = /^[A-Za-z0-9_-]{1,512}$/;
type Alg = "ES256" | "RS256";

export class SupabaseAuth implements AuthProvider {
  private readonly origin: string;
  private readonly issuer: string;
  private readonly keys = new Map<string, { alg: Alg; key: KeyObject }>();
  /** session_id -> the token's exp (seconds), kept only until the token would have expired anyway. */
  private readonly revoked = new Map<string, number>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => Date;

  constructor(private readonly opts: SupabaseAuthOptions) {
    let u: URL;
    try {
      u = new URL(opts.url);
    } catch {
      throw new Error("SUPABASE_URL is not an address.");
    }
    const dev = opts.nodeEnv === "development" || opts.nodeEnv === "test";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && dev && LOOPBACK.has(u.hostname)))
      throw new Error(
        "SUPABASE_URL must be https (http only to 127.0.0.1 in development or test).",
      );
    if (u.username || u.password || u.pathname !== "/" || u.search || u.hash)
      throw new Error("SUPABASE_URL must be the project's origin only: no user, path, query or #.");
    this.origin = u.origin;
    this.issuer = `${u.origin}/auth/v1`;

    const anon = opts.anonKey ?? "";
    if (!/^[A-Za-z0-9._-]{20,4096}$/.test(anon))
      throw new Error("SUPABASE_ANON_KEY is missing or not a key.");
    if (anon.startsWith("sb_secret_") || (anon.split(".").length === 3 && jwtRole(anon) !== "anon"))
      throw new Error(
        "SUPABASE_ANON_KEY must be the anon (publishable) key, never a secret or service-role key.",
      );

    if (opts.jwtSecret !== undefined && opts.jwtSecret !== "") {
      if (opts.jwtSecret.length < 32 || new Set(opts.jwtSecret).size < 16)
        throw new Error("SUPABASE_JWT_SECRET is too weak: 32+ characters, 16+ different ones.");
    }
    if (opts.jwks) this.loadKeys(opts.jwks);
    if (!opts.jwtSecret && this.keys.size === 0)
      throw new Error("Set SUPABASE_JWT_SECRET or SUPABASE_JWKS so access tokens can be verified.");

    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? (() => new Date());
  }

  private loadKeys(text: string): void {
    let set: unknown;
    try {
      set = JSON.parse(text);
    } catch {
      throw new Error("SUPABASE_JWKS is not JSON.");
    }
    const keys = (set as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) throw new Error("SUPABASE_JWKS has no keys.");
    for (const k of keys as Record<string, unknown>[]) {
      if ("d" in k || "p" in k || "k" in k)
        throw new Error("SUPABASE_JWKS holds a private or shared key: give the public keys only.");
      const alg =
        k.alg === "ES256" && k.kty === "EC" && k.crv === "P-256"
          ? "ES256"
          : k.alg === "RS256" && k.kty === "RSA"
            ? "RS256"
            : null;
      if (!alg || typeof k.kid !== "string" || k.kid === "")
        throw new Error(
          "SUPABASE_JWKS: every key needs a kid and alg ES256 (EC P-256) or RS256 (RSA).",
        );
      try {
        this.keys.set(k.kid, { alg, key: createPublicKey({ key: k as never, format: "jwk" }) });
      } catch {
        throw new Error("SUPABASE_JWKS holds a key that does not load.");
      }
    }
  }

  /** POST to a fixed path on the configured origin. The answer's JSON, or the reason it failed. */
  private async post(
    name: string,
    path: string,
    body: object | null,
    bearer?: string,
  ): Promise<{ ok: true; json: unknown } | { ok: false }> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) return { ok: false };
    const headers: Record<string, string> = {
      apikey: this.opts.anonKey,
      accept: "application/json",
    };
    if (body) headers["content-type"] = "application/json";
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    let failure: string;
    try {
      const res = await this.fetch(url.href, {
        method: "POST",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      const text = await readCapped(res);
      if (res.status >= 200 && res.status < 300 && text !== null) {
        if (text === "") return { ok: true, json: null };
        try {
          return { ok: true, json: JSON.parse(text) };
        } catch {
          failure = "not JSON";
        }
      } else failure = text === null ? "answer too large" : String(res.status);
    } catch (e) {
      failure = (e as Error)?.name === "TimeoutError" ? "timeout" : "network";
    }
    this.log(`[auth] supabase ${name} failed: ${failure}`);
    return { ok: false };
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => console.warn(l)))(line);
  }

  async requestLink(email: string): Promise<void> {
    const address = email.trim().toLowerCase();
    // Sent in the background: the answer comes after a fixed time whether the address is a member,
    // unknown (Supabase refuses with create_user false), slow or failing.
    const call = this.post("otp", "/auth/v1/otp", { email: address, create_user: false }).then(
      () => undefined,
    );
    this.inflight.add(call);
    void call.finally(() => this.inflight.delete(call));
    await (this.opts.sleep ?? delay)(this.opts.answerAfterMs ?? 1500);
  }

  /** Test aid: resolves when every background request has finished. */
  async settled(): Promise<void> {
    await Promise.all([...this.inflight]);
  }

  revokedCount = (): number => this.revoked.size;

  async exchangeLink(token: string): Promise<Exchange> {
    if (!TOKEN_HASH.test(token)) return { ok: false, reason: "invalid" };
    const got = await this.post("verify", "/auth/v1/verify", { type: "email", token_hash: token });
    if (!got.ok) return { ok: false, reason: "invalid" };
    const { access_token, expires_in } = (got.json ?? {}) as Record<string, unknown>;
    if (typeof access_token !== "string" || typeof expires_in !== "number")
      return { ok: false, reason: "invalid" };
    const claims = this.verify(access_token);
    if (!claims) return { ok: false, reason: "invalid" };
    const left = Math.floor(claims.exp - this.now().getTime() / 1000);
    return {
      ok: true,
      accessToken: access_token,
      expiresIn: Math.max(0, Math.min(expires_in, left)),
    };
  }

  verify(accessToken: string): Claims | null {
    const t = this.now().getTime() / 1000;
    for (const [id, exp] of this.revoked) if (exp <= t) this.revoked.delete(id);
    const c = this.signedPayload(accessToken);
    const claims = c && claimsIfCurrent(c, this.issuer, this.now());
    if (!claims || claims.is_anonymous === true) return null;
    if (typeof claims.session_id !== "string" || this.revoked.has(claims.session_id)) return null;
    return claims;
  }

  /** The payload if the signature is good under the one algorithm its key allows, else null. */
  private signedPayload(token: string): Record<string, unknown> | null {
    if (token.length > MAX_TOKEN_LENGTH) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [head, body, sig] = parts as [string, string, string];
    try {
      const h = JSON.parse(Buffer.from(head, "base64url").toString()) as Record<string, unknown>;
      if (h.typ !== "JWT") return null;
      if (h.alg === "HS256")
        return this.opts.jwtSecret ? verifyHs256(token, this.opts.jwtSecret) : null;
      const k = typeof h.kid === "string" ? this.keys.get(h.kid) : undefined;
      if (!k || h.alg !== k.alg) return null;
      const signature = Buffer.from(sig, "base64url");
      if (signature.toString("base64url") !== sig) return null;
      const data = Buffer.from(`${head}.${body}`);
      const good =
        k.alg === "ES256"
          ? cryptoVerify("sha256", data, { key: k.key, dsaEncoding: "ieee-p1363" }, signature)
          : cryptoVerify("sha256", data, k.key, signature);
      if (!good) return null;
      const payload: unknown = JSON.parse(Buffer.from(body, "base64url").toString());
      return payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  async revoke(claims: Claims, accessToken?: string): Promise<void> {
    if (claims.session_id) this.revoked.set(claims.session_id, claims.exp);
    if (accessToken) await this.post("logout", "/auth/v1/logout?scope=local", null, accessToken);
  }
}

/** The `role` claim of a JWT-shaped key, read without verifying it (to refuse a service-role key). */
function jwtRole(key: string): unknown {
  try {
    return (
      JSON.parse(Buffer.from(key.split(".")[1]!, "base64url").toString()) as { role?: unknown }
    ).role;
  } catch {
    return undefined;
  }
}

/** The body as text, or null when it is over the cap (the rest is not read). */
async function readCapped(res: Response): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
