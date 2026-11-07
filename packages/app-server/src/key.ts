import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The one-time key in the printed link: 32 random bytes, base64url (43 characters). Made per
 * start, held in the server's closure, never written to disk or logged.
 */
export function createKey(): string {
  return randomBytes(32).toString("base64url");
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/**
 * Whether a request's key is the key. Both sides are hashed first, so timingSafeEqual always
 * compares two 32-byte buffers: it never throws on a length difference, and the time taken never
 * says how long the key is or how much of it matched.
 */
export function keyMatches(candidate: string | undefined, key: string): boolean {
  if (candidate === undefined || candidate === "") return false;
  return timingSafeEqual(digest(candidate), digest(key));
}
