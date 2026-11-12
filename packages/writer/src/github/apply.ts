/**
 * Apply one approved pull_request draft (ADR-0010, X70): read the base branch, push one branch named for
 * the draft, commit the files to it, and open one draft pull request. It stops at the first kill switch,
 * refusal or failed request, and appends exactly one entry to the trail. It never writes to the base
 * branch and has no way to: the registry only accepts the draft's own branch.
 *
 * The job is a claim, not proof. Before anything is sent the writer reads the approval row itself (over
 * the worker's own connection, `deps.approvals`) and checks, in this order: the kill switches, that the
 * approval exists and is an approval, that it is the job's draft, organisation, site and kind, that the
 * payload hashes to the approval's hash, that nothing was recorded after it that withdraws it, and that
 * it is under 72 hours old. Then the payload's shape, the paths, and the registry (ADR-0010 part 3).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { checkDraftPayload, isAllowedPath } from "../kinds.js";
import { stopReason, type Mode, type Switches } from "../switches.js";
import type { Approvals, ApplyJob, Trail, TrailEntry } from "../types.js";
import { checkRequest, RegistryError, type GithubRequest } from "./endpoints.js";
import type { Send } from "./send.js";
import { prBody, prTitle } from "./text.js";

export interface GithubTarget {
  /** The organisation this worker serves. A job for another organisation is refused. */
  orgId: string;
  /** The one site this repository belongs to. A job for another site is refused. */
  siteId: string;
  /** From the worker's configuration for the site, never from the payload. */
  owner: string;
  repo: string;
  base: string;
  /**
   * Optional: the only places the writer may put a file (`content/`, `docs/menu.md`; a trailing "/" is a
   * folder). Without it only the deny-list in kinds.ts applies. Set it: it is what keeps a draft out of
   * the code that your CI runs with your secrets.
   */
  allowedPrefixes?: readonly string[];
}

export interface ApplyDeps extends Switches {
  target: GithubTarget;
  send: Send;
  trail: Trail;
  /** Where the approval row is read. Required: a job with no approval row is refused, whoever queued it. */
  approvals: Approvals;
  /** "dry-run" (the default in the worker's configuration) sends nothing and records the plan. */
  mode: Mode;
  /** The clock, for the 72-hour expiry. Defaults to the system clock. */
  now?: () => Date;
}

class Stop extends Error {
  constructor(readonly entry: Partial<TrailEntry>) {
    super("stop");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** How long an approval stays good (ADR-0010 part 2: proposed 72 hours, uncited). */
export const APPROVAL_TTL_MS = 72 * 60 * 60 * 1000;
/** A dry run has not read the base branch yet: this stands in for its commit so the plan can be checked. */
const PLACEHOLDER_SHA = "0".repeat(40);

const OWNER = /^[A-Za-z0-9-]{1,39}$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const BASE = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

/**
 * True when the configured target is plain names: no dot segment, no slash in an owner or repo. A base
 * branch's every segment must start with a letter, digit or underscore (BASE), so it has no dot segment.
 */
function validTarget(t: GithubTarget): boolean {
  const dots = (s: string) => s.split("/").some((p) => p === "." || p === "..");
  return (
    UUID.test(t.orgId) &&
    UUID.test(t.siteId) &&
    OWNER.test(t.owner) &&
    REPO_NAME.test(t.repo) &&
    !dots(t.repo) &&
    t.base.length <= 200 &&
    BASE.test(t.base)
  );
}

/** Two SHA-256 hex digests are equal, compared in constant time. Anything not lower-case hex is not equal. */
function sameDigest(a: string, b: string): boolean {
  if (!HEX64.test(a) || !HEX64.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

interface PullRequestPayload {
  title: string;
  body: string;
  files: { path: string; content: string }[];
}

interface Plan {
  getBase: GithubRequest;
  list: GithubRequest;
  createRef: GithubRequest;
  puts: { path: string; request: GithubRequest }[];
  createPull: GithubRequest;
}

function plan(
  p: PullRequestPayload,
  t: GithubTarget,
  branch: string,
  draftId: string,
  baseSha: string,
): Plan {
  const repo = `/repos/${t.owner}/${t.repo}`;
  const message = `Gaugeline: approved draft ${draftId}`;
  return {
    getBase: { endpoint: "getRef", path: `${repo}/git/ref/heads/${t.base}` },
    list: {
      endpoint: "listPulls",
      path: `${repo}/pulls`,
      query: { head: `${t.owner}:${branch}`, state: "all" },
    },
    createRef: {
      endpoint: "createRef",
      path: `${repo}/git/refs`,
      body: { ref: `refs/heads/${branch}`, sha: baseSha },
    },
    puts: p.files.map((f) => {
      const path = f.path.split("/").map(encodeURIComponent).join("/");
      return {
        path,
        request: {
          endpoint: "putContent",
          path: `${repo}/contents/${path}`,
          body: { message, content: Buffer.from(f.content, "utf8").toString("base64"), branch },
        },
      };
    }),
    createPull: {
      endpoint: "createPull",
      path: `${repo}/pulls`,
      body: {
        title: prTitle(p.title),
        head: branch,
        base: t.base,
        body: prBody(p.body),
        draft: true,
      },
    },
  };
}

export async function applyPullRequest(job: ApplyJob, deps: ApplyDeps): Promise<TrailEntry> {
  const head = { draftId: job.draftId, decisionId: job.decisionId };
  const finish = async (rest: Partial<TrailEntry>): Promise<TrailEntry> => {
    const entry = { ...head, ...rest } as TrailEntry;
    await deps.trail.record(entry);
    return entry;
  };
  const refused = (reason: string) => finish({ outcome: "refused", reason });
  const { target } = deps;

  if (job.kind !== "pull_request" || !UUID.test(job.draftId)) return refused("kind");
  if (!validTarget(target)) return refused("target");

  const stopped = await stopReason(deps);
  if (stopped) return refused(stopped);

  // The approval row, read here, is the authority; the job only says which one to read.
  let approval;
  try {
    approval = await deps.approvals.find(job.decisionId);
  } catch {
    approval = null;
  }
  if (!approval || (approval.decision !== "approved" && approval.decision !== "edited")) {
    return refused("approval");
  }
  if (approval.decisionId !== job.decisionId || approval.draftId !== job.draftId) {
    return refused("draft");
  }
  if (approval.orgId !== job.orgId || job.orgId !== target.orgId) return refused("org");
  if (approval.siteId !== job.siteId || job.siteId !== target.siteId) return refused("site");
  if (approval.kind !== job.kind) return refused("kind");
  const computed = createHash("sha256").update(job.payloadText, "utf8").digest("hex");
  if (
    !sameDigest(computed, approval.payloadSha256) ||
    !sameDigest(job.payloadSha256, approval.payloadSha256)
  ) {
    return refused("hash");
  }
  if (approval.later.some((d) => d === "declined" || d === "withdrawn"))
    return refused("withdrawn");
  const decidedAt = approval.decidedAt.getTime();
  const expires = Math.min(
    decidedAt + APPROVAL_TTL_MS,
    approval.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY,
  );
  const now = (deps.now ?? (() => new Date()))().getTime();
  if (!(now < expires)) return refused("expired");

  // The payload must match the kind's fixed shape: the same schema the inbox checked before it recorded
  // the approval.
  let parsed: unknown;
  try {
    parsed = JSON.parse(job.payloadText);
  } catch {
    return refused("payload");
  }
  const check = checkDraftPayload("pull_request", parsed);
  if (!check.ok) return refused("payload");
  const payload = check.value as unknown as PullRequestPayload;
  if (!payload.files.every((f) => isAllowedPath(f.path, target.allowedPrefixes))) {
    return refused("path");
  }

  const branch = `gaugeline/${job.draftId}`;
  const dry = plan(payload, target, branch, job.draftId, PLACEHOLDER_SHA);
  const writes = [dry.createRef, ...dry.puts.map((p) => p.request), dry.createPull];
  // The plan is checked against the registry now, in every mode: a dry run that passes is a write that
  // will not be refused for its shape.
  try {
    for (const r of [dry.getBase, dry.list, ...writes]) checkRequest(r);
  } catch (e) {
    if (e instanceof RegistryError) return refused("registry");
    throw e;
  }
  if (deps.mode !== "write") {
    return finish({
      outcome: "dry_run",
      planned: writes.map((w) => ({ endpoint: w.endpoint, path: w.path })),
    });
  }

  /** Check the switches, send, and stop on anything but the expected status. */
  const call = async (req: GithubRequest, ok: number[]) => {
    const why = await stopReason(deps);
    if (why) throw new Stop({ outcome: "refused", reason: why });
    const res = await deps.send(req);
    if (!ok.includes(res.status)) throw new Stop({ outcome: "apply_failed", status: res.status });
    return res;
  };
  const field = (json: unknown, ...keys: string[]): string | undefined => {
    let v: unknown = json;
    for (const k of keys)
      v = typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined;
    return typeof v === "string" ? v : undefined;
  };

  try {
    const baseRef = await call(dry.getBase, [200]);
    const sha = field(baseRef.json, "object", "sha");
    if (!sha) throw new Stop({ outcome: "apply_failed", status: baseRef.status });
    // The same draft is never opened twice: a pull request from its branch, open or since closed, is the
    // result. (A closed one is not reopened by a replay; the draft was decided once.)
    const earlier = await call(dry.list, [200]);
    const existing = Array.isArray(earlier.json) ? field(earlier.json[0], "html_url") : undefined;
    if (existing) return await finish({ outcome: "applied", ref: existing });

    const live = plan(payload, target, branch, job.draftId, sha);
    await call(live.createRef, [201]);
    for (const put of live.puts) {
      const current = await call(
        {
          endpoint: "getContent",
          path: `/repos/${target.owner}/${target.repo}/contents/${put.path}`,
          query: { ref: target.base },
        },
        [200, 404],
      );
      const blob = current.status === 200 ? field(current.json, "sha") : undefined;
      await call(
        { ...put.request, body: { ...put.request.body, ...(blob ? { sha: blob } : {}) } },
        [200, 201],
      );
    }
    const pull = await call(live.createPull, [201]);
    return await finish({ outcome: "applied", ref: field(pull.json, "html_url") });
  } catch (e) {
    if (e instanceof Stop) return finish(e.entry);
    if (e instanceof RegistryError) return finish({ outcome: "refused", reason: "registry" });
    throw e;
  }
}
