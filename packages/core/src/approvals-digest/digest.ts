/**
 * The pending-approvals digest (AG-14): a morning summary of the drafts waiting in the hosted inbox, built from
 * what the read-only pending-approvals reads return (AG-08: the API's GET /drafts?status=pending and the MCP
 * tool list_pending_approvals). Counting, grouping and ordering are plain code: same rows and same clock, same
 * digest. No model, no network, no write, and no real clock: the time is handed in.
 *
 * What a draft may add: its id, its site's id, its kind, its dates and its title. The title is the agent's
 * words and may quote a page, so it is data: cleaned, cut and labelled by core's sanitise, and escaped for
 * Markdown when shown. The excerpt, the payload hash and the finding ids are never read. Every link is built
 * from the operator's own address and a draft's id.
 */
import * as z from "zod";
import { sanitise, UNTRUSTED_CAPS } from "../untrusted.js";

/** An approval is refused after this long (the inbox's own rule, migration 0005), so a draft's life ends here. */
export const APPROVAL_WINDOW_HOURS = 72;
/** Most rows one digest reads: a hosted page is at most 50, so this is forty pages. Over it, the input is refused. */
export const MAX_DIGEST_ROWS = 2000;
/** Most drafts listed under "needs a decision first"; the rest are counted. */
export const MAX_ATTENTION = 20;
export const DEFAULT_STALE_AFTER_HOURS = 24;
export const DEFAULT_EXPIRING_WITHIN_HOURS = 24;
const SITE_NAME_MAX = 80;
const HOUR_MS = 3_600_000;

/** The inbox's draft kinds, in its order (apps/hosted/inbox/kinds.ts; a hosted test keeps the two equal). */
export const APPROVALS_DIGEST_KINDS = ["pull_request", "email", "sanity_draft"] as const;
export type ApprovalsDigestKind = (typeof APPROVALS_DIGEST_KINDS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const count = z.number().int().min(0);
const byKind = z.object({ pull_request: count, email: count, sanity_draft: count }).strict();
const item = z
  .object({
    id: z.string().min(1).max(64),
    siteId: z.string().min(1).max(64),
    kind: z.enum(APPROVALS_DIGEST_KINDS),
    title: z.string().max(200),
    ageHours: count,
    hoursLeft: count,
    overdue: z.boolean(),
    expiring: z.boolean(),
    link: z.string().max(300).nullable(),
  })
  .strict();
/** The digest's shape. The eval harness parses a model's answer with the same schema. */
export const approvalsDigestSchema = z
  .object({
    asOf: z.string().max(40),
    staleAfterHours: count,
    expiringWithinHours: count,
    headline: z.string().max(200),
    totals: z
      .object({
        pending: count,
        overdue: count,
        expiring: count,
        expired: count,
        skipped: count,
        byKind,
      })
      .strict(),
    sites: z
      .array(
        z
          .object({
            siteId: z.string().max(64),
            name: z.string().max(200).nullable(),
            pending: count,
            overdue: count,
            expiring: count,
            byKind,
          })
          .strict(),
      )
      .max(MAX_DIGEST_ROWS),
    attention: z.array(item).max(MAX_ATTENTION),
    attentionOmitted: count,
    inboxUrl: z.string().max(300).nullable(),
  })
  .strict();
export type ApprovalsDigest = z.infer<typeof approvalsDigestSchema>;
export type ApprovalsDigestItem = ApprovalsDigest["attention"][number];

export interface ApprovalsDigestOptions {
  /** A draft is "older than it should be" at this age: whole hours, 1 to 72. Default 24. */
  staleAfterHours?: number;
  /** A draft "expires soon" with this long left: whole hours, 1 to 72. Default 24. */
  expiringWithinHours?: number;
  /** The hosted app's address, for the inbox links: https (http on a loopback address), nothing after the host. */
  appUrl?: string;
  /** Site names by site id, for a person to read. Page-adjacent text: cleaned and cut like a title. */
  siteNames?: ReadonlyMap<string, string>;
}

/** The input is not a list of drafts, or is too long to read. Its message is fixed words. */
export class ApprovalsDigestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalsDigestInputError";
  }
}

/** The wrapped `{ text }` an agent's words arrive in (the API and the MCP tool), or a plain string. */
const wording = z.union([z.string(), z.object({ text: z.string() }).transform((o) => o.text)]);
const draftRow = z.object({
  id: z.string().regex(UUID),
  siteId: z.string().regex(UUID),
  kind: z.enum(APPROVALS_DIGEST_KINDS),
  title: wording.catch(""),
  createdAt: z.string().regex(ISO),
  expiresAt: z.string().regex(ISO),
});

const wholeHours = (v: unknown, name: string): number => {
  if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= APPROVAL_WINDOW_HOURS)
    return v;
  throw new RangeError(
    `${name} must be a whole number of hours from 1 to ${APPROVAL_WINDOW_HOURS}.`,
  );
};

/** The address links start from, or null. https only, except a loopback address; no credentials or query. */
function inboxBase(appUrl: string | undefined): string | null {
  if (appUrl === undefined) return null;
  const u = URL.canParse(appUrl) ? new URL(appUrl) : null;
  const loopback = u !== null && (u.hostname === "127.0.0.1" || u.hostname === "[::1]");
  if (
    !u ||
    u.username !== "" ||
    u.password !== "" ||
    u.search !== "" ||
    u.hash !== "" ||
    !(u.protocol === "https:" || (u.protocol === "http:" && loopback))
  )
    throw new RangeError(
      "appUrl needs an https address with no credentials, query or fragment (http only on 127.0.0.1).",
    );
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function headline(pending: number, overdue: number, expiring: number, stale: number, soon: number) {
  if (pending === 0) return "Nothing is waiting for approval.";
  const parts = [
    overdue > 0 ? `${overdue} older than ${plural(stale, "hour", "hours")}` : "",
    expiring > 0 ? `${expiring} expire within ${plural(soon, "hour", "hours")}` : "",
  ].filter((p) => p !== "");
  return `${plural(pending, "draft waits", "drafts wait")} for approval${parts.length ? `: ${parts.join(", ")}` : ""}.`;
}

/**
 * Builds the digest from the pending drafts as `now` sees them. `drafts` is whatever the read returned: a
 * row that is not a draft is skipped and counted, a draft past its expiry is counted as expired and not
 * listed, and a list that is not a list, or is over MAX_DIGEST_ROWS, is refused. A draft's life is the
 * shorter of the expiry it carries and 72 hours after it was created.
 */
export function buildApprovalsDigest(
  drafts: unknown,
  now: Date,
  opts: ApprovalsDigestOptions = {},
): ApprovalsDigest {
  const at = now.getTime();
  if (!Number.isFinite(at)) throw new RangeError("now must be a valid date.");
  const stale = wholeHours(opts.staleAfterHours ?? DEFAULT_STALE_AFTER_HOURS, "staleAfterHours");
  const soon = wholeHours(
    opts.expiringWithinHours ?? DEFAULT_EXPIRING_WITHIN_HOURS,
    "expiringWithinHours",
  );
  const base = inboxBase(opts.appUrl);
  if (!Array.isArray(drafts))
    throw new ApprovalsDigestInputError("The pending drafts must be a list.");
  if (drafts.length > MAX_DIGEST_ROWS)
    throw new ApprovalsDigestInputError(`More than ${MAX_DIGEST_ROWS} rows: ask for fewer.`);

  const empty = () => ({ pull_request: 0, email: 0, sanity_draft: 0 });
  const totals = { pending: 0, overdue: 0, expiring: 0, expired: 0, skipped: 0, byKind: empty() };
  // A Map keyed by site id: one pass groups, and a site's counters are found without a search.
  const sites = new Map<string, ApprovalsDigest["sites"][number]>();
  const urgent: (ApprovalsDigestItem & { expiresMs: number })[] = [];

  for (const raw of drafts) {
    const r = draftRow.safeParse(raw);
    const created = r.success ? Date.parse(r.data.createdAt) : Number.NaN;
    const carried = r.success ? Date.parse(r.data.expiresAt) : Number.NaN;
    if (!r.success || Number.isNaN(created) || Number.isNaN(carried)) {
      totals.skipped += 1;
      continue;
    }
    const d = r.data;
    const expiresMs = Math.min(carried, created + APPROVAL_WINDOW_HOURS * HOUR_MS);
    if (expiresMs <= at) {
      totals.expired += 1;
      continue;
    }
    const ageMs = Math.max(0, at - created);
    const overdue = ageMs >= stale * HOUR_MS;
    const expiring = expiresMs - at <= soon * HOUR_MS;
    const id = d.id.toLowerCase();
    const siteId = d.siteId.toLowerCase();
    totals.pending += 1;
    totals.byKind[d.kind] += 1;
    if (overdue) totals.overdue += 1;
    if (expiring) totals.expiring += 1;
    let site = sites.get(siteId);
    if (!site) {
      const name = opts.siteNames?.get(siteId);
      site = {
        siteId,
        name: name === undefined ? null : sanitise(name, SITE_NAME_MAX).text,
        pending: 0,
        overdue: 0,
        expiring: 0,
        byKind: empty(),
      };
      sites.set(siteId, site);
    }
    site.pending += 1;
    site.byKind[d.kind] += 1;
    if (overdue) site.overdue += 1;
    if (expiring) site.expiring += 1;
    if (overdue || expiring)
      urgent.push({
        id,
        siteId,
        kind: d.kind,
        title: sanitise(d.title, UNTRUSTED_CAPS.title).text,
        ageHours: Math.floor(ageMs / HOUR_MS),
        hoursLeft: Math.floor((expiresMs - at) / HOUR_MS),
        overdue,
        expiring,
        link: base ? `${base}/inbox/${id}` : null,
        expiresMs,
      });
  }

  // Soonest expiry first, then oldest, then id: a total order, so the input's order never shows.
  urgent.sort(
    (a, b) => a.expiresMs - b.expiresMs || b.ageHours - a.ageHours || (a.id < b.id ? -1 : 1),
  );
  const shown = urgent.slice(0, MAX_ATTENTION).map(({ expiresMs: _, ...rest }) => rest);
  return {
    asOf: new Date(at).toISOString(),
    staleAfterHours: stale,
    expiringWithinHours: soon,
    headline: headline(totals.pending, totals.overdue, totals.expiring, stale, soon),
    totals,
    sites: [...sites.values()].sort(
      (a, b) =>
        b.expiring - a.expiring ||
        b.overdue - a.overdue ||
        b.pending - a.pending ||
        (a.siteId < b.siteId ? -1 : 1),
    ),
    attention: shown,
    attentionOmitted: urgent.length - shown.length,
    inboxUrl: base ? `${base}/inbox` : null,
  };
}
