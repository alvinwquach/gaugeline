import { ConfigError } from "../errors.js";
import type { Fetcher } from "../fetcher.js";
import type { SentEmail } from "../delivery/reconcile.js";
import type { Window } from "../delivery/window.js";
import { RESEND_KEY_ENV } from "../notify/index.js";
import { isConfigured } from "./env.js";
import { getJson, isRecord } from "./get-json.js";
import { ConnectorRateLimitedError, ConnectorRefusedError } from "./http.js";
import { createRedactor } from "./redact.js";
import type { Connector } from "./types.js";

export const RESEND_API_KEY = RESEND_KEY_ENV;
const API = "https://api.resend.com/emails";

/** Proposed: the most Resend returns per page. */
export const RESEND_PAGE_SIZE = 100;
/** Proposed: pages read per run, so a runaway cursor can never keep a run going. 50 x 100 = 5,000 emails. */
export const RESEND_MAX_PAGES = 50;
/**
 * Proposed: how far back Resend lists sent emails. Uncited: Resend's page was not reachable. It is
 * only used to say which window was readable; a plan that keeps less shows older orders as missing.
 */
export const RESEND_RETENTION_DAYS = 30;

/** last_event values for an email that has not left, or did not arrive. Proposed; every other value counts as sent. */
const NOT_SENT: ReadonlySet<string> = new Set([
  "bounced",
  "canceled",
  "failed",
  "queued",
  "scheduled",
  "suppressed",
]);

export interface ResendSentOptions {
  window: Window;
  /** The run's clock, for the retention. */
  now: Date;
  sleep?: (ms: number) => Promise<void>;
  /** Told where the readable window starts: later than the window's start when Resend keeps less or a cap cut it short. */
  onReadable?: (from: Date) => void;
  retentionDays?: number;
  maxPages?: number;
}

/**
 * Resend's created_at ("2026-11-09 10:00:00.250000+00") or an ISO time, as milliseconds. A
 * Postgres-style stamp is not valid ISO: the space, a "+00" offset and microseconds are fixed first.
 */
export function resendTime(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const fixed = v
    .trim()
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00")
    .replace(/(\.\d{3})\d+/, "$1");
  const ms = Date.parse(fixed);
  return Number.isNaN(ms) ? null : ms;
}

function recipients(v: unknown): string[] {
  if (typeof v === "string") return [v];
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
}

function refusal(err: ConnectorRefusedError): ConnectorRefusedError {
  return new ConnectorRefusedError(
    err.status,
    err.status === 401
      ? `Resend did not accept ${RESEND_API_KEY}. Check it is an API key from the right Resend account.`
      : `${RESEND_API_KEY} cannot list sent emails. Resend's list needs a key with full access; a key that can only send cannot read it.`,
  );
}

/**
 * Resend as a source of sent emails ("resend-sent"). Read only: GETs of the emails list, 100 a page,
 * newest first, following `after` while `has_more` is true, and stopping once a page reaches back
 * past the window's start, at most RESEND_MAX_PAGES pages. The key goes in an Authorization header.
 * Each email becomes {when, recipients}: no subject, sender or body is kept, and an email that
 * bounced, failed, was cancelled or has not left is not counted as sent.
 */
export function createResendSentConnector(options: ResendSentOptions): Connector<SentEmail> {
  const { window } = options;
  const maxPages = options.maxPages ?? RESEND_MAX_PAGES;
  const retentionMs = (options.retentionDays ?? RESEND_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    id: "resend-sent",
    envVars: [RESEND_API_KEY],
    secretEnvVars: [RESEND_API_KEY],
    configured: (env) => isConfigured(env, [RESEND_API_KEY]),
    async read(env, fetcher: Fetcher, note = () => undefined) {
      try {
        const key = (env[RESEND_API_KEY] ?? "").trim();
        const source = {
          fetcher,
          request: { authorization: `Bearer ${key}` },
          sleep,
          system: "Resend",
        };
        const sent: SentEmail[] = [];
        let cursor: string | undefined;
        let oldest: number | undefined;
        let complete = false;
        for (let page = 1; page <= maxPages && !complete; page++) {
          const url =
            `${API}?limit=${RESEND_PAGE_SIZE}` +
            (cursor === undefined ? "" : `&after=${encodeURIComponent(cursor)}`);
          let body: unknown;
          try {
            body = (await getJson(source, url)).body;
          } catch (err) {
            if (err instanceof ConnectorRefusedError) throw refusal(err);
            throw err;
          }
          if (!isRecord(body) || !Array.isArray(body.data))
            throw new Error("Resend answered with something that is not a list of emails.");
          const data: unknown[] = body.data;
          const last = data.at(-1);
          const lastId = isRecord(last) && typeof last.id === "string" ? last.id : null;
          if (data.length > 0 && lastId === null)
            throw new Error("Resend answered with an email that has no id.");
          if (lastId !== null && lastId === cursor) {
            note("Resend sent the same page of emails twice, so Gaugeline stopped reading them.");
            break;
          }
          let reachedBack = false;
          for (const raw of data) {
            if (!isRecord(raw)) continue;
            const at = resendTime(raw.created_at);
            if (at === null) continue;
            oldest = oldest === undefined ? at : Math.min(oldest, at);
            if (at < window.from.getTime()) reachedBack = true;
            const event = typeof raw.last_event === "string" ? raw.last_event : "";
            if (NOT_SENT.has(event) || at < window.from.getTime() || at > window.to.getTime())
              continue;
            sent.push({ at, to: recipients(raw.to) });
          }
          if (body.has_more !== true || lastId === null || reachedBack) complete = true;
          else cursor = lastId;
        }
        const kept = Math.max(window.from.getTime(), options.now.getTime() - retentionMs);
        if (complete) options.onReadable?.(new Date(kept));
        else {
          const from = new Date(Math.max(oldest ?? kept, kept));
          options.onReadable?.(from);
          note(
            `Resend has more emails in this window than Gaugeline reads in one run: it read the newest ${maxPages * RESEND_PAGE_SIZE} (${maxPages} pages of ${RESEND_PAGE_SIZE}), back to ${from.toISOString().slice(0, 10)}, and left the older ones out.`,
          );
        }
        return sent;
      } catch (err) {
        if (
          err instanceof ConfigError ||
          err instanceof ConnectorRefusedError ||
          err instanceof ConnectorRateLimitedError
        )
          throw err;
        const text = err instanceof Error ? err.message : String(err);
        throw new Error(createRedactor(env, [RESEND_API_KEY])(text));
      }
    },
  };
}
