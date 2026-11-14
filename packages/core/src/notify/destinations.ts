import type { PostResult } from "./post.js";
import { parseSentryDsn, sentryAuthHeader, sentryEndpoint } from "./sentry.js";

/**
 * Where the hosted app may send an organisation's findings (X67): its own Slack channel (an incoming
 * webhook) or its own Sentry project (a DSN). GitHub issues need a token with write rights to the
 * customer's repository, which the hosted service does not hold (ADR-0010): not a destination yet.
 *
 * An address is checked when it is saved and again before every send. The checks are exact: https, the
 * vendor's own host (no look-alikes, no IP address, no port), no userinfo in the address sent to, and the
 * vendor's path shape. A refusal never repeats the address, which is a secret.
 */
export type DestinationKind = "slack" | "sentry";
export const DESTINATION_KINDS: readonly DestinationKind[] = ["slack", "sentry"];

export type Destination =
  | {
      ok: true;
      kind: DestinationKind;
      /** The host alone: the only part of the address a log, a page or an error may show. */
      host: string;
      /** The address the POST goes to. */
      endpoint: string;
      headers: Record<string, string>;
    }
  | { ok: false; error: string };

const SLACK_HOST = "hooks.slack.com";
const SLACK_PATH = /^\/services\/[A-Za-z0-9]{1,40}\/[A-Za-z0-9]{1,40}\/[A-Za-z0-9]{1,80}$/;

function checkSlack(value: string): Destination {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return {
      ok: false,
      error: "a Slack webhook must be an address starting https://hooks.slack.com/services/",
    };
  }
  if (u.protocol !== "https:") return { ok: false, error: "a Slack webhook must use https" };
  if (u.username !== "" || u.password !== "")
    return { ok: false, error: "a Slack webhook has no user name or password in it" };
  if (u.hostname !== SLACK_HOST || u.port !== "")
    return { ok: false, error: `a Slack webhook must be on ${SLACK_HOST}` };
  if (!SLACK_PATH.test(u.pathname) || u.search !== "" || u.hash !== "")
    return {
      ok: false,
      error: "that is not a Slack incoming webhook (https://hooks.slack.com/services/...)",
    };
  return { ok: true, kind: "slack", host: SLACK_HOST, endpoint: u.href, headers: {} };
}

function checkSentry(value: string): Destination {
  const dsn = parseSentryDsn(value.trim());
  if (!dsn)
    return {
      ok: false,
      error:
        "a Sentry DSN looks like https://<public key>@o<number>.ingest.sentry.io/<project number>",
    };
  return {
    ok: true,
    kind: "sentry",
    host: dsn.host,
    endpoint: sentryEndpoint(dsn),
    headers: { "x-sentry-auth": sentryAuthHeader(dsn.publicKey) },
  };
}

export function checkDestination(kind: DestinationKind, value: string): Destination {
  if (typeof value !== "string" || value.length > 2048)
    return { ok: false, error: "the address is too long" };
  if (kind === "slack") return checkSlack(value);
  if (kind === "sentry") return checkSentry(value);
  return {
    ok: false,
    error: "only Slack and Sentry can be added; GitHub issues need a token we do not hold",
  };
}

/** Waits between attempts: three tries over about 35 seconds. Integers in milliseconds. */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000];

/** Answers that another try will not change: the webhook or project is gone, or the request is wrong. */
const PERMANENT = new Set([400, 401, 403, 404, 410]);

export interface Delivered extends PostResult {
  attempts: number;
  /** The destination refused in a way a retry cannot fix (a revoked webhook, a deleted project). */
  permanent?: boolean;
}

/** Send, and on a failure that might pass (a timeout, a 429 or 5xx) wait and send again. */
export async function sendWithRetry(
  send: () => Promise<PostResult>,
  opts: {
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<Delivered> {
  const delays = opts.delaysMs ?? RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const r = await send();
    if (r.ok) return { ...r, attempts };
    if (r.status !== undefined && PERMANENT.has(r.status))
      return { ...r, attempts, permanent: true };
    const wait = delays[attempts - 1];
    if (wait === undefined) return { ...r, attempts };
    await sleep(wait);
  }
}
