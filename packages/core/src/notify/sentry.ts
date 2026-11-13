import { randomUUID } from "node:crypto";
import type { Severity } from "../model.js";
import { sanitise, UNTRUSTED_CAPS } from "../untrusted.js";
import type { ChangedFinding } from "./slack.js";

/**
 * Sentry, through the project's DSN: one event per new finding, grouped by the finding's fingerprint, so
 * one finding is one Sentry issue for its whole life and a finding that comes back regresses that issue.
 * A DSN can only send events: resolving the issue when the finding is fixed needs an auth token with write
 * rights to the customer's Sentry, which the hosted service does not hold (ADR-0010).
 */
export interface SentryDsn {
  host: string;
  projectId: string;
  publicKey: string;
}

/** o<digits>.ingest.sentry.io, or the same in a data region (o<digits>.ingest.us.sentry.io). */
export const SENTRY_INGEST_HOST = /^o\d{1,20}\.ingest\.(?:[a-z]{2}\.)?sentry\.io$/;

/** The DSN's host, project and public key, or undefined when it is not a Sentry SaaS DSN. */
export function parseSentryDsn(dsn: string): SentryDsn | undefined {
  let u: URL;
  try {
    u = new URL(dsn);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.password !== "") return undefined;
  if (!SENTRY_INGEST_HOST.test(u.hostname)) return undefined;
  if (!/^[0-9a-f]{32}$/.test(u.username)) return undefined;
  const project = /^\/(\d{1,20})$/.exec(u.pathname);
  if (!project || u.search !== "" || u.hash !== "") return undefined;
  return { host: u.hostname, projectId: project[1]!, publicKey: u.username };
}

/** The store endpoint for a DSN: no userinfo; the key goes in the X-Sentry-Auth header. */
export function sentryEndpoint(dsn: SentryDsn): string {
  return `https://${dsn.host}/api/${dsn.projectId}/store/`;
}

export function sentryAuthHeader(publicKey: string): string {
  return `Sentry sentry_version=7, sentry_client=gaugeline/1, sentry_key=${publicKey}`;
}

const LEVEL: Readonly<Record<Severity, "error" | "warning" | "info">> = {
  high: "error",
  medium: "warning",
  low: "info",
};

export interface SentryEvent {
  event_id: string;
  timestamp: string;
  platform: "other";
  level: "error" | "warning" | "info";
  logger: "gaugeline";
  message: { formatted: string };
  fingerprint: [string, string];
  tags: { check: string; site: string };
  extra: { evidence: string; url?: string };
}

/** One finding as a Sentry event. Page text is cleaned (control and direction characters) and capped. */
export function sentryEvent(f: ChangedFinding, site: string, now: Date): SentryEvent {
  const clean = (s: string, max: number) => sanitise(s, max).text as string;
  return {
    event_id: randomUUID().replace(/-/g, ""),
    timestamp: now.toISOString(),
    platform: "other",
    level: LEVEL[f.severity],
    logger: "gaugeline",
    message: { formatted: clean(f.title, UNTRUSTED_CAPS.title) },
    fingerprint: ["gaugeline", f.fingerprint],
    tags: { check: f.checkId, site: clean(site, 200) },
    extra: {
      evidence: clean(f.evidence, UNTRUSTED_CAPS.evidence),
      ...(f.url ? { url: clean(f.url, 2000) } : {}),
    },
  };
}
