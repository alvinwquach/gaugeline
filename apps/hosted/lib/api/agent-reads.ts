/**
 * The API's agent reads (AG-08), for a registered agent's own token (`Authorization: Bearer gla_...`):
 *
 *   GET /drafts?status=pending   ?site=&limit=&cursor=   the organisation's drafts waiting for a decision
 *   GET /drafts/:id                                      one of them (404 once decided, expired or not theirs)
 *   GET /runs?site=              ?since=&limit=&cursor=  one site's run history (handlers.ts hands it here)
 *
 * Each request is ONE call of a database function as gaugeline_agent (db.ts withAgent, on agent-db.ts's login), which authorizes it once
 * with its scope (read:pending, read:runs) and takes the organisation from the token. Nothing here decides,
 * approves or changes anything, and no agent token reaches the service_role connection. The global kill
 * switch (GAUGELINE_AGENTS_OFF) is read first, at every request, and refuses with no database call.
 *
 * What an agent wrote may quote a page, so a draft's title and excerpt leave here cleaned, cut short, with
 * key-shaped strings redacted, and labelled `untrusted: true` (core's markUntrusted).
 */
import { agentsOff, isAgentDenyReason, markUntrusted, redact } from "@gaugeline/core";
import * as z from "zod";
import { AGENT_TOKEN_PATTERN } from "../../agents/registry.js";
import { decodeCursor, encodeCursor, isUuid } from "./cursor.js";
import { withAgent } from "./db.js";
import type { ApiDeps } from "./handlers.js";
import { json, problem } from "./http.js";

/** The most rows one agent read returns (the SQL refuses more). */
export const AGENT_PAGE_MAX = 50;
export const AGENT_PAGE_DEFAULT = 20;
/** A draft's title and excerpt as an agent sees them, in characters. */
export const TITLE_MAX = 120;
export const EXCERPT_MAX = 280;
/** A cursor this API makes is about 100 characters; anything much longer is not one. */
const CURSOR_MAX = 200;

/** Both token shapes Gaugeline mints, redacted wherever an agent's text quotes one. */
const OUR_TOKENS = /\bgl[at]_[0-9a-f]{8}_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

/** The agent's token in an `Authorization: Bearer gla_...` header, or null. */
export function agentBearer(header: string | null): string | null {
  const m = header === null ? null : /^Bearer ([^\s]+)$/i.exec(header);
  return m && AGENT_TOKEN_PATTERN.test(m[1]!) ? m[1]! : null;
}

const UNAUTHORIZED_AGENT = (reason?: string): Response =>
  json(
    401,
    {
      code: "unauthorized",
      message: "Send a registered agent's token as: Authorization: Bearer <token>.",
      ...(reason ? { reason } : {}),
    },
    { "www-authenticate": 'Bearer realm="gaugeline"' },
  );

/** A refusal from the policy, with its reason from the closed list (the same word as the deny log). */
function denied(reason: string): Response {
  // The reason only: never the token, the query or the organisation.
  console.warn("agent api: denied", reason);
  if (reason === "unknown-agent" || reason === "revoked" || reason === "disabled")
    return UNAUTHORIZED_AGENT(reason);
  // A read that ran past the agent's time limit may work if tried again: 503, like a busy server. The
  // mapping of reasons to statuses is this API's own choice (uncited).
  const status =
    reason === "rate-limit" || reason === "cost-ceiling" ? 429 : reason === "timeout" ? 503 : 403;
  return json(status, {
    code: "denied",
    message: `Refused by the agent policy: ${reason}.`,
    reason,
  });
}

/** Not configured, the kill switch, or the agent's token; else the answer to send. */
function gate(req: Request, deps: ApiDeps): { token: string } | Response {
  const token = agentBearer(req.headers.get("authorization"));
  if (!token) return UNAUTHORIZED_AGENT();
  if (agentsOff(process.env)) return denied("kill-switch-global");
  if (deps.agentUnavailable)
    return problem(
      503,
      "agents_unavailable",
      "Agent reads are off: the server's agent login is set but was refused. Uploads and site tokens are not affected.",
    );
  if (!deps.agentSql)
    return problem(503, "agents_not_configured", "Agent reads are not set up on this server.");
  return { token };
}

const failed = (e: unknown): Response => {
  const err = e as { code?: string; name?: string };
  console.error("agent api: the read failed", err.code ?? err.name ?? "error");
  return problem(500, "internal_error", "The read failed; try again.");
};

const badQuery = (issues: z.core.$ZodIssue[]): Response =>
  problem(
    400,
    "invalid_query",
    `Bad query: ${issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}.`,
  );

const pageQuery = {
  limit: z.coerce.number().int().min(1).max(AGENT_PAGE_MAX).default(AGENT_PAGE_DEFAULT),
  cursor: z.string().max(CURSOR_MAX).optional(),
  site: z.string().refine(isUuid, "must be a site id").optional(),
};
const draftsQuery = z.object({ ...pageQuery, status: z.literal("pending").default("pending") });

const param = (url: URL, name: string) => url.searchParams.get(name) ?? undefined;

/** A piece of an agent's text, as another agent may see it: redacted, cleaned, cut, labelled. */
export function agentText(text: unknown, source: string, maxChars: number) {
  const plain = typeof text === "string" ? text : "";
  return markUntrusted(redact(plain).replace(OUR_TOKENS, "gl_[redacted]"), { source, maxChars });
}

interface PendingRow {
  id: string;
  site_id: string;
  kind: string;
  title: string | null;
  excerpt: string | null;
  payload_sha256: string;
  created_at: string;
  expires_at: string;
  cursor_at: string;
  finding_ids: string[];
}

const draftOut = (d: PendingRow) => ({
  id: d.id,
  siteId: d.site_id,
  kind: d.kind,
  title: agentText(d.title, "draft title", TITLE_MAX),
  excerpt: agentText(d.excerpt, "draft excerpt", EXCERPT_MAX),
  payloadSha256: d.payload_sha256,
  createdAt: d.created_at,
  expiresAt: d.expires_at,
  findingIds: d.finding_ids,
});

type Page = { allowed: boolean; reason?: string; more?: boolean; found?: boolean } & Record<
  string,
  unknown
>;

function refusal(page: Page): Response | undefined {
  if (page.allowed) return undefined;
  // A reason off the closed list cannot come from the policy: fail closed, and say nothing more.
  return denied(isAgentDenyReason(page.reason) ? page.reason : "bad-input");
}

async function listPending(
  deps: ApiDeps,
  token: string,
  o: { limit: number; cursor: { t: string; id: string } | null; site?: string; draft?: string },
): Promise<Page> {
  return withAgent(deps.agentSql!, async (tx) => {
    const [r] = await tx`select private.agent_list_pending(${token}, ${o.limit},
      ${o.cursor?.t ?? null}::text::timestamptz, ${o.cursor?.id ?? null}::uuid, ${o.draft ?? null}::uuid,
      ${o.site ?? null}::uuid) as p`;
    return r!.p as Page;
  });
}

export async function getPendingDrafts(req: Request, deps: ApiDeps): Promise<Response> {
  try {
    const g = gate(req, deps);
    if (g instanceof Response) return g;
    const url = new URL(req.url);
    const q = draftsQuery.safeParse({
      status: param(url, "status"),
      limit: param(url, "limit"),
      cursor: param(url, "cursor"),
      site: param(url, "site"),
    });
    if (!q.success) return badQuery(q.error.issues);
    const cursor = q.data.cursor === undefined ? null : decodeCursor(q.data.cursor, "drafts");
    if (q.data.cursor !== undefined && !cursor)
      return problem(400, "invalid_cursor", "cursor is not one this API gave you.");
    const page = await listPending(deps, g.token, {
      limit: q.data.limit,
      cursor,
      ...(q.data.site ? { site: q.data.site.toLowerCase() } : {}),
    });
    const refused = refusal(page);
    if (refused) return refused;
    const rows = (page.drafts as PendingRow[] | undefined) ?? [];
    const last = rows[rows.length - 1];
    return json(200, {
      drafts: rows.map(draftOut),
      nextCursor:
        page.more && last ? encodeCursor({ t: last.cursor_at, id: last.id }, "drafts") : null,
    });
  } catch (e) {
    return failed(e);
  }
}

export async function getPendingDraft(req: Request, id: string, deps: ApiDeps): Promise<Response> {
  try {
    const g = gate(req, deps);
    if (g instanceof Response) return g;
    // Decided, expired, another organisation's and none at all look the same.
    const notFound = () => problem(404, "not_found", "No such pending draft.");
    if (!isUuid(id)) return notFound();
    const page = await listPending(deps, g.token, {
      limit: 1,
      cursor: null,
      draft: id.toLowerCase(),
    });
    const refused = refusal(page);
    if (refused) return refused;
    const row = (page.drafts as PendingRow[] | undefined)?.[0];
    return row ? json(200, { draft: draftOut(row) }) : notFound();
  } catch (e) {
    return failed(e);
  }
}

/** A time Postgres can hold and the API means: between the years 1900 and 9999 (UTC). */
const inRange = (iso: string): boolean => {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= Date.UTC(1900, 0, 1) && t < Date.UTC(10000, 0, 1);
};
const runsQuery = z.object({
  ...pageQuery,
  site: z.string().refine(isUuid, "must be a site id"),
  since: z.iso
    .datetime({ offset: true })
    .refine(inRange, "must be a time between the years 1900 and 9999")
    .optional(),
});

interface RunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  summary: unknown;
  cursor_at: string;
}

/** GET /runs for an agent: `site` is required, and must be a site of the agent's organisation. */
export async function getRunsForAgent(req: Request, deps: ApiDeps): Promise<Response> {
  try {
    const g = gate(req, deps);
    if (g instanceof Response) return g;
    const url = new URL(req.url);
    const q = runsQuery.safeParse({
      site: param(url, "site"),
      since: param(url, "since"),
      limit: param(url, "limit"),
      cursor: param(url, "cursor"),
    });
    if (!q.success) return badQuery(q.error.issues);
    const cursor = q.data.cursor === undefined ? null : decodeCursor(q.data.cursor, "runs");
    if (q.data.cursor !== undefined && !cursor)
      return problem(400, "invalid_cursor", "cursor is not one this API gave you.");
    const site = q.data.site.toLowerCase();
    const page = await withAgent(deps.agentSql!, async (tx) => {
      const [r] =
        await tx`select private.agent_list_runs(${g.token}, ${site}::uuid, ${q.data.limit},
        ${cursor?.t ?? null}::text::timestamptz, ${cursor?.id ?? null}::uuid,
        ${q.data.since ?? null}::text::timestamptz) as p`;
      return r!.p as Page;
    });
    const refused = refusal(page);
    if (refused) return refused;
    // Another organisation's site and one that does not exist look the same.
    if (!page.found) return problem(404, "not_found", "No such site for this agent.");
    const rows = (page.runs as RunRow[] | undefined) ?? [];
    const last = rows[rows.length - 1];
    return json(200, {
      runs: rows.map((r) => ({
        id: r.id,
        siteId: site,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        summary: r.summary,
      })),
      nextCursor: page.more && last ? encodeCursor({ t: last.cursor_at, id: last.id }) : null,
    });
  } catch (e) {
    return failed(e);
  }
}
