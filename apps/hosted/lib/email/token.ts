/**
 * The signed link in every morning email. It names one person in one organisation and lets whoever holds
 * it change that person's email setting (stop, fix-first only, every change) and nothing else: it does not
 * sign anyone in, and the page that reads it never sets a session.
 *
 *   v1.<payload>.<signature>     payload: {o: organisation, u: user, x: expiry in seconds}, base64url
 *                                signature: HMAC-SHA256 of the label and the payload, base64url
 *
 * The secret is the server's (GAUGELINE_EMAIL_TOKEN_SECRET): never stored, logged or sent. The signature
 * is compared in constant time. The link lives 90 days, so an old email still works for a quarter.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const TOKEN_SECRET_ENV = "GAUGELINE_EMAIL_TOKEN_SECRET";
export const TOKEN_TTL_MS = 90 * 86_400_000;
/** Domain separation: a signature made for another purpose with the same secret never verifies here. */
const LABEL = "gaugeline-email-preferences-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TOKEN = 600;
/** A SHA-256 signature in base64url without padding: exactly 43 characters of the URL-safe alphabet. */
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

export interface TokenClaims {
  orgId: string;
  userId: string;
}

export type TokenCheck =
  ({ ok: true } & TokenClaims) | { ok: false; reason: "malformed" | "signature" | "expired" };

/** Fewest different characters a secret may have: "kkkk...k" at any length is not a secret. */
const MIN_DISTINCT_CHARS = 8;

/** The secret from the environment: at least 32 characters, with at least 8 different ones, or the server does not start. */
export function checkTokenSecret(secret: string | undefined): string {
  if (!secret)
    throw new Error(`${TOKEN_SECRET_ENV} is not set: preference links cannot be signed.`);
  if (secret.length < 32)
    throw new Error(`${TOKEN_SECRET_ENV} must be at least 32 characters (use a random value).`);
  if (new Set(secret).size < MIN_DISTINCT_CHARS)
    throw new Error(
      `${TOKEN_SECRET_ENV} must have at least ${MIN_DISTINCT_CHARS} different characters (use a random value).`,
    );
  return secret;
}

const mac = (secret: string, payload: string): Buffer =>
  createHmac("sha256", secret).update(`${LABEL}.${payload}`).digest();

export function signToken(
  secret: string,
  claims: TokenClaims,
  now: Date,
  ttlMs = TOKEN_TTL_MS,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      o: claims.orgId,
      u: claims.userId,
      x: Math.floor((now.getTime() + ttlMs) / 1000),
    }),
  ).toString("base64url");
  return `v1.${payload}.${mac(secret, payload).toString("base64url")}`;
}

export function verifyToken(secret: string, token: string, now: Date): TokenCheck {
  const parts = token.length <= MAX_TOKEN ? token.split(".") : [];
  const [version, payload, signature] = parts;
  if (parts.length !== 3 || version !== "v1" || !payload || !signature)
    return { ok: false, reason: "malformed" };
  // Node's base64url decoder forgives padding, whitespace, stray characters and the standard alphabet, and
  // 43 characters carry two spare bits, so several spellings decode to the same bytes. Only the one
  // spelling signToken writes is accepted: the signature must have its exact shape and be what its bytes
  // encode back to.
  if (!SIGNATURE.test(signature)) return { ok: false, reason: "malformed" };
  const given = Buffer.from(signature, "base64url");
  const want = mac(secret, payload);
  // timingSafeEqual throws on different lengths, so a length mismatch is answered first.
  if (
    given.length !== want.length ||
    given.toString("base64url") !== signature ||
    !timingSafeEqual(given, want)
  )
    return { ok: false, reason: "signature" };
  let claims: { o?: unknown; u?: unknown; x?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims.o !== "string" || typeof claims.u !== "string" || typeof claims.x !== "number")
    return { ok: false, reason: "malformed" };
  if (!UUID.test(claims.o) || !UUID.test(claims.u)) return { ok: false, reason: "malformed" };
  if (claims.x * 1000 < now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, orgId: claims.o, userId: claims.u };
}
