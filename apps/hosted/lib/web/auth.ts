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
  /** The claims of an access token that is genuine and not expired, else null. Never throws. */
  verify(accessToken: string): Claims | null;
}

const b64 = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

export function signHs256(claims: object, secret: string): string {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify(claims));
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}

/** The payload of an HS256 token with a valid signature, else null. Any other `alg` (including none) is refused. */
export function verifyHs256(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  try {
    const header = JSON.parse(Buffer.from(head, "base64url").toString()) as { alg?: unknown };
    if (header.alg !== "HS256") return null;
    const want = createHmac("sha256", secret).update(`${head}.${body}`).digest();
    const got = Buffer.from(sig, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const payload: unknown = JSON.parse(Buffer.from(body, "base64url").toString());
    return payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LINK_TTL_MS = 15 * 60_000;
export const SESSION_TTL_S = 8 * 3600;

export interface StandInOptions {
  /** Signs the tokens. Server-only, at least 32 characters. */
  secret: string;
  /** email -> user id (the `sub`). Addresses are compared without case. */
  users: Record<string, string>;
  /** Hands the one-time token to the person (a test inbox, a dev console). Never a log in production. */
  deliver: (email: string, token: string) => void | Promise<void>;
  now?: () => Date;
}

export class StandInAuth implements AuthProvider {
  private readonly users = new Map<string, string>();
  /** sha256(token) -> who and until when. The token itself is never kept. */
  private readonly links = new Map<string, { sub: string; email: string; expires: number }>();
  private readonly now: () => Date;

  constructor(private readonly opts: StandInOptions) {
    if (process.env.NODE_ENV === "production")
      throw new Error("The stand-in auth is for development and tests, never in production.");
    if (opts.secret.length < 32)
      throw new Error("The stand-in secret must be at least 32 characters.");
    for (const [email, id] of Object.entries(opts.users))
      this.users.set(email.trim().toLowerCase(), id);
    this.now = opts.now ?? (() => new Date());
  }

  async requestLink(email: string): Promise<void> {
    const address = email.trim().toLowerCase();
    const sub = this.users.get(address);
    if (!sub) return;
    const token = randomBytes(32).toString("base64url");
    this.links.set(hash(token), {
      sub,
      email: address,
      expires: this.now().getTime() + LINK_TTL_MS,
    });
    await this.opts.deliver(address, token);
  }

  async exchangeLink(token: string): Promise<Exchange> {
    const key = hash(token);
    const link = this.links.get(key);
    if (!link) return { ok: false, reason: "invalid" };
    this.links.delete(key);
    const iat = Math.floor(this.now().getTime() / 1000);
    if (this.now().getTime() >= link.expires) return { ok: false, reason: "expired" };
    const claims: Claims = {
      sub: link.sub,
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
    if (typeof c.exp !== "number" || c.exp <= nowS) return null;
    if (c.aud !== "authenticated" || c.role !== "authenticated") return null;
    if (typeof c.sub !== "string" || !UUID.test(c.sub)) return null;
    return c as unknown as Claims;
  }
}

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");
