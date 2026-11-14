/**
 * The runs API (/api/v1), as functions from a Web-standard Request to a Response: what a Next.js Route
 * Handler receives and returns, so the route files stay a line each and the tests need no server.
 *
 *   POST /runs               an upload (the CLI's result JSON); 201 with the run, or 200 for a repeated Idempotency-Key
 *   GET  /runs               ?site=&since=&limit=&cursor=  runs of the token's site, newest first
 *   GET  /runs/:id/findings  ?limit=&cursor=               the findings of one run
 *
 * Auth is a per-site Bearer token. The token names the site (and so the organisation); a `site` in the
 * request must be that site. Everything runs as service_role (db.ts). GET /runs also takes a registered
 * agent's token (`gla_...`, scope read:runs): agent-reads.ts answers that, as gaugeline_agent, never here.
 */
import { createHash } from "node:crypto";
import * as z from "zod";
import { decodeCursor, encodeCursor, isUuid } from "./cursor.js";
import { type Sql, type Tx, withService } from "./db.js";
import { json, problem, UNAUTHORIZED } from "./http.js";
import { MAX_BODY_BYTES, parseIdempotencyKey, parseUpload, type Upload } from "./schema.js";
import { agentBearer, getRunsForAgent } from "./agent-reads.js";
import { secretsInValue, stringsOf } from "./secrets.js";
import { type Authorised, authenticate, parseBearer } from "./tokens.js";

export interface ApiDeps {
  sql: Sql;
  /** The agent's own login (agent-db.ts), when GAUGELINE_AGENT_DATABASE_URL is set; never service_role. */
  agentSql?: Sql;
  /** GAUGELINE_AGENT_DATABASE_URL is set but its login was refused: agent reads answer 503 (deps.ts). */
  agentUnavailable?: boolean;
}

const FINDINGS_PER_INSERT = 1000;

/** Who is asking: the token's site, or the answer to send. */
async function authorise(
  req: Request,
  deps: ApiDeps,
): Promise<{ auth: Authorised; token: string } | Response> {
  const token = parseBearer(req.headers.get("authorization"));
  if (!token) return UNAUTHORIZED();
  const auth = await withService(deps.sql, (tx) => authenticate(tx, token));
  return auth ? { auth, token } : UNAUTHORIZED();
}

/** `site` in the query must be the token's own site: another site's token is not this one's to use. */
function checkSite(url: URL, auth: Authorised): Response | undefined {
  const site = url.searchParams.get("site");
  if (site === null) return undefined;
  if (!isUuid(site)) return problem(400, "invalid_site", "site must be a site id.");
  if (site.toLowerCase() !== auth.siteId)
    return problem(403, "wrong_site", "This token is for another site.");
  return undefined;
}

/** The body as text, or undefined when it is over the cap; never reads past the cap. */
async function readCapped(req: Request): Promise<string | undefined> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const failed = (e: unknown, what: string): Response => {
  // The error's code or name only: a database message can quote a row.
  const err = e as { code?: string; name?: string };
  console.error("runs api: the request failed", err.code ?? err.name ?? "error");
  return problem(500, "internal_error", `${what} Nothing was saved; try again.`);
};

export async function postRun(req: Request, deps: ApiDeps): Promise<Response> {
  try {
    const who = await authorise(req, deps);
    if (who instanceof Response) return who;
    const { auth, token } = who;
    const wrongSite = checkSite(new URL(req.url), auth);
    if (wrongSite) return wrongSite;
    const key = parseIdempotencyKey(req.headers.get("idempotency-key"));
    if (!key.ok)
      return problem(
        400,
        "invalid_idempotency_key",
        "Idempotency-Key is 1 to 255 printable characters.",
      );

    const text = await readCapped(req);
    if (text === undefined)
      return problem(
        413,
        "body_too_large",
        `The body is over ${MAX_BODY_BYTES / (1024 * 1024)} MB; nothing was stored.`,
      );
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return problem(400, "invalid_json", "The body is not valid JSON.");
    }
    // Every string of the body as it decodes (values, and keys), checked before anything else reads it.
    const strings = stringsOf(body);
    if (strings.some((x) => x.includes("\u0000")))
      return problem(
        400,
        "invalid_body",
        "The body contains a NUL character (\\u0000), which cannot be stored.",
      );
    // Findings and evidence lines only: no keys. The scan is for key shapes and for the token just
    // presented, never for the server's own environment (that would let any token holder guess at it).
    // The refusal does not say which one it was, and never echoes the value.
    if (secretsInValue(strings, { PRESENTED_TOKEN: token }).length > 0)
      return problem(
        422,
        "secret_in_body",
        "The upload contains something that looks like a key or a token, so nothing was stored. Findings and evidence lines only: no keys.",
      );
    const parsed = parseUpload(body);
    if (!parsed.ok) return problem(parsed.status, parsed.code, parsed.message);

    const hash = createHash("sha256").update(text).digest("hex");
    const outcome = await withService(deps.sql, (tx) =>
      storeRun(tx, auth, parsed.value, key.key, hash),
    );
    if (outcome.kind === "conflict")
      return problem(
        409,
        "idempotency_key_reused",
        "That Idempotency-Key was used for a different body. Use a new key for a new upload.",
      );
    const body2 = {
      id: outcome.id,
      siteId: auth.siteId,
      startedAt: outcome.startedAt,
      findings: outcome.findings,
    };
    return outcome.kind === "replay"
      ? json(200, body2, { "idempotent-replayed": "true" })
      : json(201, body2);
  } catch (e) {
    return failed(e, "The upload could not be stored.");
  }
}

export type Stored =
  | { kind: "created" | "replay"; id: string; startedAt: string; findings: number }
  | { kind: "conflict" };

const ISO = `to_char(started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * The run and all its findings, or nothing: one transaction (the caller's), one advisory lock per key.
 * The one way a run is written: POST /runs and the nightly worker (G36) both call it.
 */
export async function storeRun(
  tx: Tx,
  auth: Pick<Authorised, "orgId" | "siteId">,
  upload: Upload,
  key: string | null,
  requestHash: string,
): Promise<Stored> {
  if (key !== null) {
    // Two uploads with one key at once take turns, so the second sees the first's row.
    await tx`select pg_advisory_xact_lock(hashtextextended(${`${auth.siteId}:${key}`}, 0))`;
    const seen = await tx`select k.request_hash, k.run_id, r.summary,
        ${tx.unsafe(ISO.replaceAll("started_at", "r.started_at"))} as started
      from public.idempotency_keys k join public.runs r on r.id = k.run_id
      where k.site_id = ${auth.siteId} and k.key = ${key}`;
    const hit = seen[0];
    if (hit)
      return hit.request_hash === requestHash
        ? {
            kind: "replay",
            id: hit.run_id as string,
            startedAt: hit.started as string,
            findings: Number((hit.summary as { total?: number }).total ?? 0),
          }
        : { kind: "conflict" };
  }
  const runs = await tx`insert into public.runs (org_id, site_id, started_at, finished_at, summary)
    values (${auth.orgId}, ${auth.siteId}, ${upload.startedAt}::timestamptz, now(),
      ${tx.json(upload.summary as Parameters<Tx["json"]>[0])})
    returning id, ${tx.unsafe(ISO)} as started`;
  const run = runs[0]!;
  const rows = upload.findings.map((f) => ({
    org_id: auth.orgId,
    site_id: auth.siteId,
    run_id: run.id as string,
    check_id: f.checkId,
    severity: f.severity,
    title: f.title,
    evidence: f.evidence,
    url: f.url,
    fingerprint: f.fingerprint,
  }));
  // Chunks stay under Postgres's limit of 65,535 parameters in one statement.
  for (let i = 0; i < rows.length; i += FINDINGS_PER_INSERT)
    await tx`insert into public.findings ${tx(rows.slice(i, i + FINDINGS_PER_INSERT))}`;
  if (key !== null)
    await tx`insert into public.idempotency_keys (org_id, site_id, key, request_hash, run_id)
      values (${auth.orgId}, ${auth.siteId}, ${key}, ${requestHash}, ${run.id as string})`;
  return {
    kind: "created",
    id: run.id as string,
    startedAt: run.started as string,
    findings: rows.length,
  };
}

/** A time Postgres can hold and the API means: between the years 1900 and 9999 (UTC). */
const inRange = (iso: string): boolean => {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= Date.UTC(1900, 0, 1) && t < Date.UTC(10000, 0, 1);
};

const listQuery = z.object({
  since: z.iso
    .datetime({ offset: true })
    .refine(inRange, "must be a time between the years 1900 and 9999")
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export async function getRuns(req: Request, deps: ApiDeps): Promise<Response> {
  if (agentBearer(req.headers.get("authorization"))) return getRunsForAgent(req, deps);
  try {
    const who = await authorise(req, deps);
    if (who instanceof Response) return who;
    const { auth } = who;
    const url = new URL(req.url);
    const wrongSite = checkSite(url, auth);
    if (wrongSite) return wrongSite;
    const q = listQuery.safeParse({
      since: url.searchParams.get("since") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
    });
    if (!q.success)
      return problem(
        400,
        "invalid_query",
        `Bad query: ${q.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}.`,
      );
    const cursor = q.data.cursor === undefined ? null : decodeCursor(q.data.cursor, "runs");
    if (q.data.cursor !== undefined && !cursor)
      return problem(400, "invalid_cursor", "cursor is not one this API gave you.");
    const { since, limit } = q.data;
    const rows = await withService(
      deps.sql,
      (tx) => tx`select id, started_at::text as t, ${tx.unsafe(ISO)} as started,
          to_char(finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as finished, summary
        from public.runs
        where site_id = ${auth.siteId}
          ${since ? tx`and started_at > ${since}::timestamptz` : tx``}
          ${cursor ? tx`and (started_at, id) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : tx``}
        order by started_at desc, id desc limit ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return json(200, {
      runs: page.map((r) => ({
        id: r.id,
        siteId: auth.siteId,
        startedAt: r.started,
        finishedAt: r.finished,
        summary: r.summary,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ t: last.t as string, id: last.id as string })
          : null,
    });
  } catch (e) {
    return failed(e, "The runs could not be read.");
  }
}

const findingsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
  cursor: z.string().optional(),
});

export async function getRunFindings(
  req: Request,
  runId: string,
  deps: ApiDeps,
): Promise<Response> {
  try {
    const who = await authorise(req, deps);
    if (who instanceof Response) return who;
    const { auth } = who;
    // Another site's run, and one that does not exist, look the same.
    const notFound = () => problem(404, "not_found", "No such run for this site.");
    if (!isUuid(runId)) return notFound();
    const url = new URL(req.url);
    const q = findingsQuery.safeParse({
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
    });
    if (!q.success)
      return problem(
        400,
        "invalid_query",
        `Bad query: ${q.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}.`,
      );
    const cursor = q.data.cursor === undefined ? null : decodeCursor(q.data.cursor, "findings");
    if (q.data.cursor !== undefined && !cursor)
      return problem(400, "invalid_cursor", "cursor is not one this API gave you.");
    const { limit } = q.data;
    const found = await withService(deps.sql, async (tx) => {
      const run =
        await tx`select 1 from public.runs where id = ${runId} and site_id = ${auth.siteId}`;
      if (run.length === 0) return null;
      return tx`select id, check_id, severity, title, evidence, url, fingerprint
        from public.findings where run_id = ${runId} and site_id = ${auth.siteId}
          ${cursor ? tx`and id > ${cursor.id}::uuid` : tx``}
        order by id limit ${limit + 1}`;
    });
    if (found === null) return notFound();
    const page = found.slice(0, limit);
    const last = page[page.length - 1];
    return json(200, {
      findings: page.map((f) => ({
        id: f.id,
        checkId: f.check_id,
        severity: f.severity,
        title: f.title,
        evidence: f.evidence,
        url: f.url,
        fingerprint: f.fingerprint,
      })),
      nextCursor:
        found.length > limit && last
          ? encodeCursor({ t: "findings", id: last.id as string })
          : null,
    });
  } catch (e) {
    return failed(e, "The findings could not be read.");
  }
}
