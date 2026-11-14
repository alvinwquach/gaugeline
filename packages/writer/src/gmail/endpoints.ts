/**
 * The writer's whole Gmail surface (ADR-0010 part 1): one request, `users.drafts.create`
 * (POST /gmail/v1/users/me/drafts). There is no send, no update, no delete and no read in this registry,
 * so there is nothing for the sender to be asked to do but create one draft. The path is matched exactly
 * ("me", the authenticated user, never an address), the body is exactly `{ message: { raw } }` (no thread,
 * no labels), and the message in `raw` is read back with `readRaw`: it must be a message this writer
 * built, and every recipient in it must be one of the customer's configured contacts.
 *
 * The scope the customer grants is `gmail.drafts.create` ("Compose new draft emails"): the narrowest scope
 * Gmail lists for drafts.create, and not accepted by the method that sends a draft (the PR's Sources).
 *
 * The registry is frozen all the way down, so code elsewhere in the process cannot add an endpoint.
 */
import { RegistryError } from "../github/endpoints.js";
import { MimeError, readRaw, type MailParts } from "./mime.js";

export type GmailEndpointId = "createDraft";

export interface GmailRequest {
  endpoint: GmailEndpointId;
  /** Always DRAFTS_PATH. */
  path: string;
  body?: { message: { raw: string } };
}

/** The OAuth scope to grant: can create drafts, cannot read mail, cannot send. */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.drafts.create";

/** Users.drafts.create: the authenticated user's mailbox. */
export const DRAFTS_PATH = "/gmail/v1/users/me/drafts";

export const GMAIL_ENDPOINTS = Object.freeze({
  createDraft: Object.freeze({ method: "POST", path: DRAFTS_PATH }),
});

/** The most a message may be, as base64url text (Gmail accepts 36 MB; a draft of ours is a few KB). */
const MAX_RAW = 100_000;

function refuse(why: string): never {
  throw new RegistryError(`refused createDraft: ${why}`);
}

/**
 * Throws unless `req` is the one registered request, with a message built by this writer, addressed to
 * the configured contacts and no one else. Returns the parts the draft will have.
 */
export function checkGmailRequest(req: GmailRequest, contacts: readonly string[]): MailParts {
  if (req === null || typeof req !== "object") refuse("not a request");
  if (Object.keys(req).sort().join() !== "body,endpoint,path")
    refuse("a request is endpoint, path and body");
  if (!Object.hasOwn(GMAIL_ENDPOINTS, req.endpoint)) refuse("not a registered endpoint");
  if (req.path !== DRAFTS_PATH) refuse("the path is users/me/drafts only");
  const body = req.body as Record<string, unknown> | undefined;
  if (body === undefined || Object.keys(body).join() !== "message")
    refuse("the body is message only");
  const message = body.message as Record<string, unknown> | null;
  if (message === null || typeof message !== "object" || Object.keys(message).join() !== "raw")
    refuse("the message is raw only");
  const raw = message.raw;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RAW) refuse("raw");
  let parts: MailParts;
  try {
    parts = readRaw(raw);
  } catch (e) {
    if (e instanceof MimeError) return refuse("raw is not a message this writer built");
    throw e;
  }
  const allowed = new Set(contacts.map((c) => c.toLowerCase()));
  if (!parts.to.every((a) => allowed.has(a.toLowerCase())))
    refuse("a recipient is not one of the configured contacts");
  return parts;
}
