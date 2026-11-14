import { randomBytes } from "node:crypto";
import { keyMatches } from "./key.js";

export const SESSION_COOKIE = "gl_session";

/**
 * The key in the link is exchanged, once, for a session token (32 random bytes, separate from the
 * key) carried in an HttpOnly, SameSite=Strict cookie. After the exchange the key is spent.
 */
export function createSession(key: string): {
  exchange(candidateKey: string | undefined): string | null;
  isValid(cookieValue: string | undefined): boolean;
} {
  let token: string | undefined;
  return {
    exchange(candidateKey) {
      if (token !== undefined || !keyMatches(candidateKey, key)) return null;
      token = randomBytes(32).toString("base64url");
      return token;
    },
    isValid(cookieValue) {
      return token !== undefined && keyMatches(cookieValue, token);
    },
  };
}

/** The first gl_session in a Cookie header, parsed by hand: split on ";", trim, first match. */
export function sessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const p = part.trim();
    const eq = p.indexOf("=");
    if (eq > 0 && p.slice(0, eq).trim() === SESSION_COOKIE) return p.slice(eq + 1).trim();
  }
  return undefined;
}

/** HttpOnly so page scripts can't read it, SameSite=Strict so other sites' requests don't carry it.
 * No Secure (plain http on loopback; a dropped cookie would lock the user out) and no Domain. */
export const setSessionCookie = (token: string) =>
  `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
