/**
 * What POST /runs accepts: the versioned JSON `gaugeline <address> --json` prints (core's result schema,
 * the same zod objects), checked again here against the limits of the tables it is stored in. Findings
 * and evidence lines only: the result has no field for page content, and a field it does not know is
 * refused, so a body cannot carry one.
 */
import * as z from "zod";
import { fingerprint, resultSchema } from "@gaugeline/core";

/** One upload, whole: over this it is refused before it is parsed. 10,000 findings fit with room to spare. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_FINDINGS = 10_000;
const MAX_LIST = 1000;
const MAX_TITLE = 300;
const MAX_EVIDENCE = 1000;
const MAX_URL = 2048;
/** The run's summary column holds at most 16 KB; stay well under. */
const SUMMARY_BUDGET = 15_000;

// Schema 1 is the published result.v1.json: schema 2 without couldNotCheck and sampled.
const resultV1 = resultSchema
  .omit({ couldNotCheck: true, sampled: true, schema: true })
  .extend({ schema: z.literal(1) });
const resultV2 = resultSchema;

export interface UploadFinding {
  checkId: string;
  severity: "high" | "medium" | "low";
  title: string;
  /** One line, at most 1000 characters. */
  evidence: string;
  url: string;
  /** core's fingerprint(): the join key between runs. */
  fingerprint: string;
}

export interface Upload {
  schema: 1 | 2;
  /** The address the run checked. */
  url: string;
  startedAt: string;
  findings: UploadFinding[];
  /** Counts and the short lists the runs table keeps (the findings are stored as rows). */
  summary: Record<string, unknown>;
}

export type Parsed =
  | { ok: true; value: Upload }
  | { ok: false; status: 400 | 413 | 422; code: string; message: string };

const fail = (
  status: 400 | 413 | 422,
  code: string,
  message: string,
): { ok: false; status: 400 | 413 | 422; code: string; message: string } => ({
  ok: false,
  status,
  code,
  message,
});

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const CHECK_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;

export function parseUpload(body: unknown): Parsed {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return fail(
      400,
      "invalid_body",
      "The body must be one JSON object: the output of `gaugeline <address> --json`.",
    );
  const schema = (body as { schema?: unknown }).schema;
  if (schema !== 1 && schema !== 2)
    return fail(
      422,
      "unsupported_schema",
      `This API accepts result schema 1 and 2, what \`gaugeline <address> --json\` prints; the body says ${
        typeof schema === "number" ? `schema ${schema}` : "no schema number"
      }.`,
    );
  const list = (body as { findings?: unknown }).findings;
  if (Array.isArray(list) && list.length > MAX_FINDINGS)
    return fail(
      413,
      "too_many_findings",
      `One upload holds at most 10,000 findings (this one has ${list.length}); nothing was stored.`,
    );
  const parsed = (schema === 1 ? resultV1 : resultV2).safeParse(body);
  if (!parsed.success) {
    // The path and the rule, never the value that broke it.
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`);
    return fail(400, "invalid_body", `The body is not a valid result: ${issues.join("; ")}.`);
  }
  // Schema 1 has no couldNotCheck or sampled: an empty list and no counts.
  const r = {
    couldNotCheck: [],
    sampled: {},
    ...parsed.data,
  } as z.infer<typeof resultV2> & { schema: 1 | 2 };
  const at = Date.parse(r.startedAt);
  if (!Number.isFinite(at) || at < Date.UTC(1900, 0, 1) || at >= Date.UTC(10000, 0, 1))
    return fail(400, "invalid_body", "startedAt: must be a time between the years 1900 and 9999.");
  const limit = checkLimits(r);
  if (limit) return fail(422, "invalid_body", limit);

  const findings: UploadFinding[] = r.findings.map((f) => ({
    checkId: f.checkId,
    severity: f.severity,
    title: oneLine(f.title).slice(0, MAX_TITLE),
    evidence: oneLine(f.evidence).slice(0, MAX_EVIDENCE),
    url: f.url,
    fingerprint: fingerprint({ checkId: f.checkId, url: f.url, evidence: f.evidence }),
  }));
  return {
    ok: true,
    value: {
      schema: r.schema,
      url: r.url,
      startedAt: r.startedAt,
      findings,
      summary: buildSummary(r, findings),
    },
  };
}

/** The limits the tables hold, as a message; undefined when the result fits. Never echoes a value. */
function checkLimits(r: z.infer<typeof resultV2>): string | undefined {
  if (r.url.length > MAX_URL) return "url: longer than 2048 characters.";
  for (const [i, f] of r.findings.entries()) {
    if (!CHECK_ID.test(f.checkId))
      return `findings.${i}.checkId: a check id is lower-case letters, digits and hyphens, up to 100 characters.`;
    if (oneLine(f.title) === "") return `findings.${i}.title: must not be empty.`;
    if (f.url.length > MAX_URL) return `findings.${i}.url: longer than 2048 characters.`;
  }
  for (const key of ["passed", "failed"] as const)
    if (r[key].length > MAX_LIST) return `${key}: more than ${MAX_LIST} entries.`;
  if (r.couldNotCheck.length > MAX_LIST) return `couldNotCheck: more than ${MAX_LIST} entries.`;
  if (Object.keys(r.sampled).length > 100) return "sampled: more than 100 entries.";
  for (const id of [...r.passed, ...r.failed, ...r.couldNotCheck.map((c) => c.id)])
    if (id.length > 100)
      return "a check id in passed, failed or couldNotCheck is longer than 100 characters.";
  return undefined;
}

function buildSummary(
  r: z.infer<typeof resultV2>,
  findings: UploadFinding[],
): Record<string, unknown> {
  const count = (s: UploadFinding["severity"]) => findings.filter((f) => f.severity === s).length;
  const summary = {
    schema: r.schema,
    url: r.url,
    high: count("high"),
    medium: count("medium"),
    low: count("low"),
    total: findings.length,
    passed: r.passed.length,
    failed: r.failed.slice(0, 100),
    couldNotCheck: r.couldNotCheck.slice(0, 20).map((c) => ({
      id: c.id,
      reason: oneLine(c.reason).slice(0, 200),
    })),
    sampled: r.sampled,
  };
  // The column has a hard limit: drop the long lists, longest first, until it fits.
  const size = () => Buffer.byteLength(JSON.stringify(summary));
  while (size() > SUMMARY_BUDGET && summary.couldNotCheck.length > 0) summary.couldNotCheck.pop();
  while (size() > SUMMARY_BUDGET && summary.failed.length > 0) summary.failed.pop();
  if (size() > SUMMARY_BUDGET) summary.sampled = {};
  return summary;
}

/** The Idempotency-Key header: 1 to 255 printable ASCII characters, or none. */
export function parseIdempotencyKey(
  header: string | null,
): { ok: true; key: string | null } | { ok: false } {
  if (header === null) return { ok: true, key: null };
  return /^[\x21-\x7e]{1,255}$/.test(header) ? { ok: true, key: header } : { ok: false };
}
