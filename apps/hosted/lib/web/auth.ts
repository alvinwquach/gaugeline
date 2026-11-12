/**
 * Sign-in behind one interface, so the hosted app does not care who the identity provider is.
 *
 * The stand-in here is for development and tests. It signs the same kind of access token Supabase Auth
 * does (an HS256 JWT with sub, aud, role, email, session_id, aal, is_anonymous, iat and exp) and sends the
 * same kind of one-time email link, so everything downstream (the row-level security policies read
 * `sub` through auth.uid()) is exercised as it will be. Nothing here creates an account or reaches a
 * network. Replace it with a Supabase-backed AuthProvider when the project exists; docs/hosted lists the
 * settings to create.
 *
 * No passwords: the only way in is a link sent to the address, valid once, for 15 minutes.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/** The claims of a signed-in person, as a Supabase access token carries them. */
export interface Claims {
  sub: string;
  iss?: string;
  aud: string;
  role: string;
  email?: string;
  session_id?: string;
  aal?: string;
  is_anonymous?: boolean;
  iat: number;
  exp: number;
}

export type Exchange =
  | { ok: true; accessToken: string; expiresIn: number }
  | { ok: false; reason: "invalid" | "expired" };

export interface AuthProvider {
  /** Send a sign-in link to the address. Resolves the same way for an address that has no account. */
  requestLink(email: string): Promise<void>;
  /** Trade the one-time token from the link for an access token. */
  exchangeLink(token: string): Promise<Exchange>;
  /** The claims of an access token that is genuine, current and not signed out, else null. Never throws. */
  verify(accessToken: string): Claims | null;
  /** End this session on the server: the same token no longer verifies. */
  revoke(claims: Claims): Promise<void>;
}

const b64 = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

export function signHs256(claims: object, secret: string): string {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify(claims));
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}

/** No token the app issues comes near this; a longer one is refused before it is decoded. */
export const MAX_TOKEN_LENGTH = 8192;

/**
 * The payload of an HS256 token with a valid signature, else null. Only `alg: HS256` with `typ: JWT` is
 * accepted (never `none`), and the signature must be in its one canonical base64url form (no padding, no
 * stray characters), so a token has exactly one spelling.
 */
export function verifyHs256(token: string, secret: string): Record<string, unknown> | null {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  try {
    const header = JSON.parse(Buffer.from(head, "base64url").toString()) as {
      alg?: unknown;
      typ?: unknown;
    };
    if (header.alg !== "HS256" || header.typ !== "JWT") return null;
    const want = createHmac("sha256", secret).update(`${head}.${body}`).digest();
    const got = Buffer.from(sig, "base64url");
    if (got.toString("base64url") !== sig) return null;
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const payload: unknown = JSON.parse(Buffer.from(body, "base64url").toString());
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LINK_TTL_MS = 15 * 60_000;
export const SESSION_TTL_S = 8 * 3600;
/** The longest a token may claim to live, whatever its signature says. */
const MAX_LIFETIME_S = 30 * 86400;
/** How far ahead of this server's clock a token's iat or nbf may be. */
const SKEW_S = 60;
export const STAND_IN_ISSUER = "gaugeline-stand-in";

export interface StandInOptions {
  /** Signs the tokens. Server-only, at least 32 characters that do not repeat. */
  secret: string;
  /** email -> user id (the `sub`). Addresses are compared without case. */
  users: Record<string, string>;
  /** Hands the one-time token to the person (a test inbox, a dev console). Never a log in production. */
  deliver: (email: string, token: string) => void | Promise<void>;
  now?: () => Date;
  /** The NODE_ENV to judge by; the process's own when the key is absent. Only `development` and `test` run. */
  nodeEnv?: string | undefined;
}

export class StandInAuth implements AuthProvider {
  private readonly users = new Map<string, string>();
  /** sha256(token) -> who and until when. The token itself is never kept. */
  private readonly links = new Map<string, { sub: string; email: string; expires: number }>();
  /** The one unused link each person has: a newer link ends the older one. */
  private readonly linkOf = new Map<string, string>();
  /** session_id -> the token's exp (seconds), kept only until the token would have expired anyway. */
  private readonly revoked = new Map<string, number>();
  private dummy = 0;
  private readonly now: () => Date;

  constructor(private readonly opts: StandInOptions) {
    const env = "nodeEnv" in opts ? opts.nodeEnv : process.env.NODE_ENV;
    if (env !== "development" && env !== "test")
      throw new Error(
        "The stand-in auth runs only in development and test (NODE_ENV must be exactly one of them), never anywhere else.",
      );
    if (opts.secret.length < 32)
      throw new Error("The stand-in secret must be at least 32 characters.");
    if (new Set(opts.secret).size < 16)
      throw new Error(
        "The stand-in secret must look random: use at least 16 different characters.",
      );
    for (const [email, id] of Object.entries(opts.users))
      this.users.set(email.trim().toLowerCase(), id);
    this.now = opts.now ?? (() => new Date());
  }

  private prune(): void {
    const t = this.now().getTime();
    for (const [key, link] of this.links)
      if (t >= link.expires) {
        this.links.delete(key);
        if (this.linkOf.get(link.sub) === key) this.linkOf.delete(link.sub);
      }
    for (const [id, exp] of this.revoked) if (exp <= t / 1000) this.revoked.delete(id);
  }

  async requestLink(email: string): Promise<void> {
    this.prune();
    const address = email.trim().toLowerCase();
    const sub = this.users.get(address);
    const token = randomBytes(32).toString("base64url");
    const key = hash(token);
    if (!sub) {
      // The same hashing work as for a known address, so the two cannot be told apart by it.
      this.dummy += 1;
      return;
    }
    const older = this.linkOf.get(sub);
    if (older) this.links.delete(older);
    this.links.set(key, { sub, email: address, expires: this.now().getTime() + LINK_TTL_MS });
    this.linkOf.set(sub, key);
    await this.opts.deliver(address, token);
  }

  /** Test aids: how many unused links, revoked sessions and unknown-address requests are being held. */
  pendingLinks = (): number => this.links.size;
  revokedCount = (): number => this.revoked.size;
  dummyWork = (): number => this.dummy;

  async exchangeLink(token: string): Promise<Exchange> {
    const key = hash(token);
    const link = this.links.get(key);
    if (!link) return { ok: false, reason: "invalid" };
    // Used up first, then judged: an expired link is gone too.
    this.links.delete(key);
    this.linkOf.delete(link.sub);
    this.prune();
    if (this.now().getTime() >= link.expires) return { ok: false, reason: "expired" };
    const iat = Math.floor(this.now().getTime() / 1000);
    const claims: Claims = {
      sub: link.sub.toLowerCase(),
      iss: STAND_IN_ISSUER,
      aud: "authenticated",
      role: "authenticated",
      email: link.email,
      session_id: randomUUID(),
      aal: "aal1",
      is_anonymous: false,
      iat,
      exp: iat + SESSION_TTL_S,
    };
    return { ok: true, accessToken: signHs256(claims, this.opts.secret), expiresIn: SESSION_TTL_S };
  }

  verify(accessToken: string): Claims | null {
    const c = verifyHs256(accessToken, this.opts.secret);
    if (!c) return null;
    const nowS = this.now().getTime() / 1000;
    if (typeof c.exp !== "number" || !(c.exp > nowS) || c.exp > nowS + MAX_LIFETIME_S) return null;
    if (typeof c.iat !== "number" || c.iat > nowS + SKEW_S) return null;
    if (c.nbf !== undefined && (typeof c.nbf !== "number" || c.nbf > nowS + SKEW_S)) return null;
    if (c.iss !== STAND_IN_ISSUER) return null;
    if (c.aud !== "authenticated" || c.role !== "authenticated") return null;
    if (typeof c.sub !== "string" || !UUID.test(c.sub)) return null;
    if (typeof c.session_id === "string" && this.revoked.has(c.session_id)) return null;
    return { ...(c as unknown as Claims), sub: c.sub.toLowerCase() };
  }

  async revoke(claims: Claims): Promise<void> {
    if (claims.session_id) this.revoked.set(claims.session_id, claims.exp);
  }
}

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");
