/**
 * The front door for a chat request (X69): the checks that run BEFORE anything in the body is parsed, and
 * in this order, so a request that fails one never reaches the next.
 *
 *   1. size       the body is read up to a cap; a larger one is refused without being read
 *   2. connection the id in the address names an active connection of the endpoint's own provider
 *   3. secret     the connection's signing secret, from the secret store (never from the request)
 *   4. signature  the provider's signature over the RAW bytes, in constant time, and the timestamp window
 *   5. replay     the request's key is claimed once; a second request with it is refused
 *
 * The replay claim comes after the signature on purpose: claiming first would let anyone who knows a
 * connection's id burn keys. An unknown connection, a wrong provider, a missing secret, a bad signature and
 * a replay all answer 401 with the same body, so a caller cannot tell which of them it hit; the reason code
 * is for the server's log only and never holds a secret, a signature or a body.
 */
import type { ChatConnection, ChatProvider, ChatStore } from "./store.js";
import { MAX_CHAT_BODY, readCappedBody, type Verified } from "./verify.js";

export type Reject =
  | "too-large"
  | "unknown-connection"
  | "wrong-provider"
  | "no-secret"
  | "missing-header"
  | "bad-timestamp"
  | "stale"
  | "bad-signature"
  | "replayed";

export type Authenticated =
  | { ok: true; connection: ChatConnection; rawBody: Buffer }
  | { ok: false; status: 401 | 413; reason: Reject };

/** What a provider's verifier is given: the secret, the raw bytes, the request's headers and the time. */
export interface VerifyInput {
  secret: string;
  rawBody: Buffer;
  headers: Headers;
  now: Date;
}

export interface ReceiveDeps {
  store: ChatStore;
  now?: () => Date;
  maxBody?: number;
}

export async function authenticate(
  request: Request,
  connectionId: string,
  provider: ChatProvider,
  verify: (input: VerifyInput) => Verified,
  deps: ReceiveDeps,
): Promise<Authenticated> {
  const rawBody = await readCappedBody(request, deps.maxBody ?? MAX_CHAT_BODY);
  if (!rawBody) return { ok: false, status: 413, reason: "too-large" };
  const connection = await deps.store.connection(connectionId);
  if (!connection) return { ok: false, status: 401, reason: "unknown-connection" };
  if (connection.provider !== provider) return { ok: false, status: 401, reason: "wrong-provider" };
  const secret = await deps.store.signingSecret(connection.id);
  if (!secret) return { ok: false, status: 401, reason: "no-secret" };
  const verified = verify({
    secret,
    rawBody,
    headers: request.headers,
    now: (deps.now ?? (() => new Date()))(),
  });
  if (!verified.ok) return { ok: false, status: 401, reason: verified.reason };
  if (!(await deps.store.claim(connection.id, verified.requestKey)))
    return { ok: false, status: 401, reason: "replayed" };
  return { ok: true, connection, rawBody };
}

/** The one response for every refusal: same body, so which check failed is not visible to the caller. */
export function rejection(result: { status: 401 | 413 }): Response {
  return new Response(result.status === 413 ? "Request too large" : "Unauthorized", {
    status: result.status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
