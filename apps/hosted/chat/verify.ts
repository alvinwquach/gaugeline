/**
 * Checking that a chat request really came from the workspace's own chat app (X69). Nothing here reads a
 * database or a clock of its own: the caller passes the signing secret and `now`, so each rule is a plain
 * function a test can drive.
 *
 * The check is on the RAW body bytes, before anything parses them: a parsed and re-encoded body is not the
 * body that was signed, and parsing unverified input is how a forged request reaches a parser.
 */
import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as edVerify,
} from "node:crypto";

/** The largest request body read at all. A Slack interaction is a few kilobytes. */
export const MAX_CHAT_BODY = 64 * 1024;
/** How far a request's timestamp may be from our clock, in either direction (Slack's own advice: five minutes). */
export const MAX_SKEW_SECONDS = 5 * 60;

export type VerifyFailure = "missing-header" | "bad-timestamp" | "stale" | "bad-signature";
export type Verified =
  /** `requestKey` is unique to this exact signed request: what the replay table stores. */
  { ok: true; requestKey: string } | { ok: false; reason: VerifyFailure };

export interface SlackRequest {
  /** The app's signing secret, from the secret store. Never logged, never in an error. */
  secret: string;
  rawBody: Uint8Array;
  /** The `X-Slack-Signature` header: `v0=` and 64 hex characters. */
  signature: string | null;
  /** The `X-Slack-Request-Timestamp` header: whole seconds since the epoch. */
  timestamp: string | null;
  now: Date;
}

const SIGNATURE = /^v0=([0-9a-f]{64})$/i;
const SECONDS = /^[0-9]{1,12}$/;

/**
 * Slack's scheme: HMAC-SHA256, keyed with the signing secret, of `v0:<timestamp>:<raw body>`, as lowercase
 * hex after `v0=`; a timestamp more than five minutes from now is refused (bolt-js verify-request.ts).
 * Slack's reference only refuses an old timestamp; this refuses a future one too, so a request signed for
 * later cannot be held back and replayed after its window opens.
 */
export function verifySlack(req: SlackRequest): Verified {
  if (!req.secret || req.signature === null || req.timestamp === null)
    return { ok: false, reason: "missing-header" };
  if (!SECONDS.test(req.timestamp)) return { ok: false, reason: "bad-timestamp" };
  const skew = Math.abs(Math.floor(req.now.getTime() / 1000) - Number(req.timestamp));
  if (skew > MAX_SKEW_SECONDS) return { ok: false, reason: "stale" };
  const given = SIGNATURE.exec(req.signature);
  if (!given) return { ok: false, reason: "bad-signature" };
  const expected = createHmac("sha256", req.secret)
    .update(`v0:${req.timestamp}:`)
    .update(req.rawBody)
    .digest();
  // Both are 32 bytes (the pattern above fixed the length), as timingSafeEqual requires.
  if (!timingSafeEqual(expected, Buffer.from(given[1]!, "hex")))
    return { ok: false, reason: "bad-signature" };
  return { ok: true, requestKey: given[1]!.toLowerCase() };
}

/**
 * The request's body, or undefined when it is larger than `max` bytes. The declared length is refused
 * before a byte is read, and a body that lies about it (or sends none, chunked) is cut off at the cap.
 */
export async function readCappedBody(
  request: Request,
  max = MAX_CHAT_BODY,
): Promise<Buffer | undefined> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^[0-9]{1,15}$/.test(declared) || Number(declared) > max))
    return undefined;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** A Slack request's verifier in the shape `authenticate` takes: reads the two headers, then checks. */
export function slackVerifier(input: {
  secret: string;
  rawBody: Buffer;
  headers: Headers;
  now: Date;
}): Verified {
  return verifySlack({
    secret: input.secret,
    rawBody: input.rawBody,
    signature: input.headers.get("x-slack-signature"),
    timestamp: input.headers.get("x-slack-request-timestamp"),
    now: input.now,
  });
}

export interface DiscordRequest {
  /** The application's public key: 64 hex characters, from Discord's developer portal. Public, not secret. */
  publicKey: string;
  rawBody: Uint8Array;
  /** The `X-Signature-Ed25519` header: 128 hex characters. */
  signature: string | null;
  /** The `X-Signature-Timestamp` header: whole seconds since the epoch. */
  timestamp: string | null;
  now: Date;
}

const HEX_KEY = /^[0-9a-f]{64}$/i;
const HEX_SIGNATURE = /^[0-9a-f]{128}$/i;
/** The fixed prefix of an Ed25519 public key in DER (SubjectPublicKeyInfo), RFC 8410. */
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Discord's scheme: an Ed25519 signature, from the application's key, over the `X-Signature-Timestamp`
 * header followed by the raw body (Discord's interactions overview, "Validating Security Request Headers").
 * A failure is answered 401. Discord's page names no freshness window; this one applies the same five
 * minutes as Slack's, in both directions (uncited: a rule of this file). The replay key is the SHA-256 of
 * what was signed, not the signature, so a second way of writing the same signature is still the same
 * request.
 */
export function verifyDiscord(req: DiscordRequest): Verified {
  if (!req.publicKey || req.signature === null || req.timestamp === null)
    return { ok: false, reason: "missing-header" };
  if (!SECONDS.test(req.timestamp)) return { ok: false, reason: "bad-timestamp" };
  const skew = Math.abs(Math.floor(req.now.getTime() / 1000) - Number(req.timestamp));
  if (skew > MAX_SKEW_SECONDS) return { ok: false, reason: "stale" };
  if (!HEX_SIGNATURE.test(req.signature) || !HEX_KEY.test(req.publicKey))
    return { ok: false, reason: "bad-signature" };
  const signed = Buffer.concat([Buffer.from(req.timestamp, "utf8"), req.rawBody]);
  let good = false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI, Buffer.from(req.publicKey, "hex")]),
      format: "der",
      type: "spki",
    });
    good = edVerify(null, signed, key, Buffer.from(req.signature, "hex"));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: "bad-signature" };
  return { ok: true, requestKey: createHash("sha256").update(signed).digest("hex") };
}

/** A Discord request's verifier in the shape `authenticate` takes; the connection's "secret" is the public key. */
export function discordVerifier(input: {
  secret: string;
  rawBody: Buffer;
  headers: Headers;
  now: Date;
}): Verified {
  return verifyDiscord({
    publicKey: input.secret,
    rawBody: input.rawBody,
    signature: input.headers.get("x-signature-ed25519"),
    timestamp: input.headers.get("x-signature-timestamp"),
    now: input.now,
  });
}
