/**
 * Two read-only tools over the hosted API (AG-08), for a registered agent:
 *
 *   list_pending_approvals   GET <base>/drafts?status=pending   the drafts waiting for a person's decision
 *   read_run_history         GET <base>/runs?site=               one site's run history (counts only)
 *
 * The operator configures both, by environment only: GAUGELINE_HOSTED_API (the API's address) and
 * GAUGELINE_AGENT_TOKEN (the agent's own `gla_` token, scopes read:pending and read:runs). No tool argument
 * names an address or a credential, and without both variables neither tool is offered.
 *
 * Every request goes through the core fetcher (ctx.fetcherFor): GET only, the private-address refusal, every
 * hop pinned to the configured origin, no redirect followed. The token is sent to that origin only and never
 * appears in a result, an error or a log line. Nothing here approves anything: assistants plan, people
 * approve, in the inbox.
 */
import { markUntrusted, redact, type Hop } from "@gaugeline/core";
import * as z from "zod";
import { ToolError, type ServerOptions, type ToolContext } from "../state.js";

export const HOSTED_API_ENV = "GAUGELINE_HOSTED_API";
export const AGENT_TOKEN_ENV = "GAUGELINE_AGENT_TOKEN";
const AGENT_TOKEN = /^gla_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;
const LOOPBACK = new Set(["127.0.0.1", "[::1]"]);
const MAX_ANSWER_BYTES = 1024 * 1024;
export const PAGE_MAX = 50;
const TITLE_MAX = 120;
const EXCERPT_MAX = 280;
/** Both token shapes Gaugeline mints: redacted again here, whatever the API did. */
const OUR_TOKENS = /\bgl[at]_[0-9a-f]{8}_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
const REASONS = new Set([
  "unknown-agent",
  "revoked",
  "disabled",
  "scope",
  "tool-not-allowed",
  "rate-limit",
  "cost-ceiling",
  "timeout",
  "kill-switch-agent",
  "kill-switch-global",
  "bad-input",
]);

export interface HostedConfig {
  /** The API's address, e.g. https://hosted.example/api/v1, with no trailing slash, query or credentials. */
  base: string;
  token: string;
}

/**
 * The hosted configuration from the environment: undefined when neither variable is set; an Error (that
 * never quotes the token) when only one is, or either is not valid. https only, except a loopback address.
 */
export function hostedFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): HostedConfig | undefined {
  const base = env[HOSTED_API_ENV];
  const token = env[AGENT_TOKEN_ENV];
  if (!base && !token) return undefined;
  if (!base || !token)
    throw new Error(`${HOSTED_API_ENV} and ${AGENT_TOKEN_ENV} go together: set both, or neither.`);
  if (!AGENT_TOKEN.test(token))
    throw new Error(`${AGENT_TOKEN_ENV} is not a registered agent's token (gla_...).`);
  const u = URL.canParse(base) ? new URL(base) : null;
  if (
    !u ||
    u.username !== "" ||
    u.password !== "" ||
    u.search !== "" ||
    u.hash !== "" ||
    !(u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname)))
  )
    throw new Error(
      `${HOSTED_API_ENV} needs an https address with no credentials or query, for example https://hosted.example/api/v1 (http only on 127.0.0.1).`,
    );
  return { base: `${u.origin}${u.pathname.replace(/\/+$/, "")}`, token };
}

export const hostedEnabled = (o: ServerOptions): boolean => o.hosted !== undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const pageInput = {
  limit: z.number().int().min(1).max(PAGE_MAX).optional().describe("Rows per page, 1 to 50."),
  cursor: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional()
    .describe("The nextCursor of the previous page."),
};
const siteId = z.string().regex(UUID, "must be a site id");

export const listPendingInput = {
  site: siteId.optional().describe("Only this site's drafts (a site id)."),
  ...pageInput,
};
export const runHistoryInput = {
  site: siteId.describe("The site whose runs to read (a site id of the agent's organisation)."),
  ...pageInput,
};

/** One GET to the configured API, pinned to its origin, with no redirect followed. */
async function getJson(ctx: ToolContext, path: string, query: URLSearchParams): Promise<unknown> {
  const cfg = ctx.options.hosted;
  if (!cfg) throw new ToolError("The hosted API is not configured on this server.");
  const url = `${cfg.base}${path}?${query.toString()}`;
  let hop: Hop | undefined;
  try {
    const hops = await ctx.fetcherFor(url, new URL(cfg.base).origin).get(url, {
      headers: { authorization: `Bearer ${cfg.token}`, accept: "application/json" },
      headersSameOrigin: true,
      anonymous: true,
      maxRedirects: 0,
      maxBytes: MAX_ANSWER_BYTES,
      fresh: true,
    });
    hop = hops.at(-1);
  } catch {
    // Fixed words: a fetch error can carry an address, never the token, but nothing of it is needed here.
    throw new ToolError("The hosted API could not be reached. Nothing was changed.");
  }
  if (!hop || hop.status === 0)
    throw new ToolError("The hosted API could not be reached. Nothing was changed.");
  if (hop.status >= 300 && hop.status < 400)
    throw new ToolError(
      "The hosted API answered with a redirect, which is not followed. Check GAUGELINE_HOSTED_API.",
    );
  let body: unknown;
  try {
    body = hop.truncated ? undefined : JSON.parse(hop.body ?? "");
  } catch {
    body = undefined;
  }
  if (hop.status === 200 && body !== undefined) return body;
  const reason = (body as { reason?: unknown } | undefined)?.reason;
  if (
    (hop.status === 401 || hop.status === 403 || hop.status === 429) &&
    REASONS.has(String(reason))
  )
    throw new ToolError(`The hosted API refused this agent: ${String(reason)}.`);
  if (hop.status === 404) throw new ToolError("Not found for this agent.");
  if (hop.status === 400) throw new ToolError("The hosted API refused the query as not valid.");
  throw new ToolError(`The hosted API answered with status ${hop.status}. Nothing was changed.`);
}

const text = (v: unknown): string =>
  typeof v === "object" && v !== null && typeof (v as { text?: unknown }).text === "string"
    ? (v as { text: string }).text
    : "";
/** An agent's words, as another agent receives them: redacted, cleaned, cut and labelled. */
const untrusted = (v: unknown, source: string, maxChars: number) =>
  markUntrusted(redact(text(v)).replace(OUR_TOKENS, "gl_[redacted]"), { source, maxChars });

const draftShape = z.object({
  id: z.string().regex(UUID),
  siteId: z.string().regex(UUID),
  kind: z.enum(["pull_request", "email", "sanity_draft"]),
  title: z.unknown(),
  excerpt: z.unknown(),
  payloadSha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string().regex(ISO),
  expiresAt: z.string().regex(ISO),
  findingIds: z.array(z.string().regex(UUID)).max(50),
});
const cursorShape = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/)
  .nullable();
const pendingShape = z.object({
  drafts: z.array(draftShape).max(PAGE_MAX),
  nextCursor: cursorShape,
});

const query = (args: { site?: string; limit?: number; cursor?: string }, pending: boolean) => {
  const q = new URLSearchParams();
  if (pending) q.set("status", "pending");
  if (args.site) q.set("site", args.site.toLowerCase());
  if (args.limit !== undefined) q.set("limit", String(args.limit));
  if (args.cursor !== undefined) q.set("cursor", args.cursor);
  return q;
};

const NOT_UNDERSTOOD = "The hosted API's answer was not in the expected shape; nothing is shown.";

export async function listPendingApprovals(
  args: z.infer<z.ZodObject<typeof listPendingInput>>,
  ctx: ToolContext,
) {
  const parsed = pendingShape.safeParse(await getJson(ctx, "/drafts", query(args, true)));
  if (!parsed.success) throw new ToolError(NOT_UNDERSTOOD);
  return {
    drafts: parsed.data.drafts.map((d) => ({
      id: d.id,
      siteId: d.siteId,
      kind: d.kind,
      title: untrusted(d.title, "draft title", TITLE_MAX),
      excerpt: untrusted(d.excerpt, "draft excerpt", EXCERPT_MAX),
      payloadSha256: d.payloadSha256,
      createdAt: d.createdAt,
      expiresAt: d.expiresAt,
      findingIds: d.findingIds,
    })),
    nextCursor: parsed.data.nextCursor,
    note: "Read-only. A person approves, edits or declines each draft in the inbox; this server cannot.",
  };
}

const count = z.number().int().min(0).max(1_000_000);
const runShape = z.object({
  id: z.string().regex(UUID),
  startedAt: z.string().regex(ISO),
  finishedAt: z.string().regex(ISO).nullable(),
  summary: z.record(z.string(), z.unknown()),
});
const runsShape = z.object({ runs: z.array(runShape).max(PAGE_MAX), nextCursor: cursorShape });
const countOf = (v: unknown): number | null => (count.safeParse(v).success ? (v as number) : null);

export async function readRunHistory(
  args: z.infer<z.ZodObject<typeof runHistoryInput>>,
  ctx: ToolContext,
) {
  const parsed = runsShape.safeParse(await getJson(ctx, "/runs", query(args, false)));
  if (!parsed.success) throw new ToolError(NOT_UNDERSTOOD);
  return {
    siteId: args.site.toLowerCase(),
    // Counts only: a run's summary also holds the address and check ids the upload named, which are not
    // needed to see a trend and are not passed on.
    runs: parsed.data.runs.map((r) => ({
      id: r.id,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      counts: {
        high: countOf(r.summary.high),
        medium: countOf(r.summary.medium),
        low: countOf(r.summary.low),
        total: countOf(r.summary.total),
      },
    })),
    nextCursor: parsed.data.nextCursor,
  };
}
