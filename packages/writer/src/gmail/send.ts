/**
 * The writer's second connection (ADR-0010, X75; named in the post-boundary scan's list and exempted in
 * the lint rules, and nowhere else): to https://gmail.googleapis.com only, after the registry has accepted
 * the request, with the customer's OAuth access token in the Authorization header and nowhere else.
 * Redirects are refused so the token cannot follow one to another host, and the request times out.
 *
 * The token is read from its source before each request (the worker's store), not once at start, so a
 * disconnect that deletes it takes effect at the next request. The response is reduced to a status and,
 * on success, the draft's id: Gmail's text is never returned, so it cannot be logged or recorded.
 *
 * It calls the global `fetch` directly, so the post-boundary scan sees the connection; a test replaces
 * the global with the stand-in.
 */
import { checkGmailRequest, GMAIL_ENDPOINTS, type GmailRequest } from "./endpoints.js";

const ORIGIN = "https://gmail.googleapis.com";
/** Longest wait for Gmail's answer. */
const TIMEOUT_MS = 30_000;
/** What an OAuth access token looks like to a header: visible ASCII, no space. */
const TOKEN_SHAPE = /^[!-~]{1,4096}$/;

/** Gives the customer's access token, or null when none is stored (never connected, or disconnected). */
export type TokenSource = () => Promise<string | null>;

/** The token is missing or unusable. The message is fixed: it never carries a token or a store's error. */
export class MailTokenError extends Error {
  constructor() {
    super("the mailbox is not connected: no usable access token");
    this.name = "MailTokenError";
  }
}

export interface GmailResponse {
  status: number;
  /** `{ id }` for a created draft (when Gmail returned a text id), otherwise null. Never Gmail's text. */
  json: { id: string } | null;
}

export type CreateDraft = (req: GmailRequest) => Promise<GmailResponse>;

/**
 * The address to fetch for the registered path: on gmail.googleapis.com, and exactly the path the registry
 * checked. A path the URL parser would rewrite (a dot segment, a backslash, a tab, a query) or move to
 * another host (`//host/...`) is refused, so what was checked is what is sent.
 */
export function draftsUrl(path: string): URL {
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN) throw new Error("the writer talks to gmail.googleapis.com only");
  if (url.pathname !== path || url.search !== "" || url.hash !== "")
    throw new Error("the writer sends the path it checked, unchanged");
  return url;
}

/** A token source over a store with the SecretStore's `get` (V-01): one organisation's named secret. */
export function tokenFromStore(
  store: { get(orgId: string, name: string): Promise<string | null> },
  orgId: string,
  name: string,
): TokenSource {
  return async () => (await store.get(orgId, name)) || null;
}

/**
 * The sender for one site: it creates drafts addressed to `contacts` only (the registry reads the message
 * back and refuses any other recipient, before the token is read).
 */
export function gmailSender(token: TokenSource, contacts: readonly string[]): CreateDraft {
  return async (req) => {
    checkGmailRequest(req, contacts);
    const url = draftsUrl(req.path);
    let value: string | null;
    try {
      value = await token();
    } catch {
      throw new MailTokenError(); // the store's error may carry the secret: replaced, not wrapped
    }
    if (value === null || !TOKEN_SHAPE.test(value)) throw new MailTokenError();
    const res = await fetch(url.href, {
      method: GMAIL_ENDPOINTS.createDraft.method,
      headers: { authorization: `Bearer ${value}`, "content-type": "application/json" },
      body: JSON.stringify(req.body),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const answer: unknown = await res.json().catch(() => null);
    const id =
      res.ok && typeof answer === "object" && answer !== null
        ? (answer as { id?: unknown }).id
        : undefined;
    return { status: res.status, json: typeof id === "string" ? { id } : null };
  };
}
