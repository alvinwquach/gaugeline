/**
 * Apply one approved pull_request draft (ADR-0010, X70): read the base branch, push one branch named for
 * the draft, commit the files to it, and open one draft pull request. It stops at the first kill switch,
 * refusal or failed request, and appends exactly one entry to the trail. It never writes to the base
 * branch and has no way to: the registry only accepts the draft's own branch.
 */
import { PayloadError, parsePullRequestPayload, type PullRequestPayload } from "../schema.js";
import { stopReason, type Switches } from "../switches.js";
import type { ApplyJob, Trail, TrailEntry } from "../types.js";
import type { GithubRequest } from "./endpoints.js";
import type { Send } from "./send.js";

export interface GithubTarget {
  /** From the worker's configuration for the site, never from the payload. */
  owner: string;
  repo: string;
  base: string;
}

export interface ApplyDeps extends Switches {
  target: GithubTarget;
  send: Send;
  trail: Trail;
  /** "dry-run" (the default in the worker's configuration) sends nothing and records the plan. */
  mode: "dry-run" | "write";
}

class Stop extends Error {
  constructor(readonly entry: Partial<TrailEntry>) {
    super("stop");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function plan(p: PullRequestPayload, repo: string, branch: string, base: string, draftId: string) {
  const commitMessage = `Gaugeline: approved draft ${draftId}`;
  const writes: GithubRequest[] = [
    {
      endpoint: "createRef",
      path: `${repo}/git/refs`,
      body: { ref: `refs/heads/${branch}`, sha: "" },
    },
    ...p.files.map((f): GithubRequest => ({
      endpoint: "putContent",
      path: `${repo}/contents/${f.path.split("/").map(encodeURIComponent).join("/")}`,
      query: {},
      body: {
        message: commitMessage,
        content: Buffer.from(f.content, "utf8").toString("base64"),
        branch,
      },
    })),
    {
      endpoint: "createPull",
      path: `${repo}/pulls`,
      body: { title: p.title, head: branch, base, body: p.body, draft: true },
    },
  ];
  return writes;
}

export async function applyPullRequest(job: ApplyJob, deps: ApplyDeps): Promise<TrailEntry> {
  const head = { draftId: job.draftId, decisionId: job.decisionId };
  const finish = async (rest: Partial<TrailEntry>): Promise<TrailEntry> => {
    const entry = { ...head, ...rest } as TrailEntry;
    await deps.trail.record(entry);
    return entry;
  };

  if (job.kind !== "pull_request" || !UUID.test(job.draftId)) {
    return finish({ outcome: "refused", reason: "kind" });
  }
  let payload: PullRequestPayload;
  try {
    payload = parsePullRequestPayload(job.payload);
  } catch (e) {
    if (e instanceof PayloadError) return finish({ outcome: "refused", reason: "payload" });
    throw e;
  }
  const { owner, repo: name, base } = deps.target;
  const repo = `/repos/${owner}/${name}`;
  const branch = `gaugeline/${job.draftId}`;
  const writes = plan(payload, repo, branch, base, job.draftId);

  const stopped = await stopReason(deps);
  if (stopped) return finish({ outcome: "refused", reason: stopped });
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
    const baseRef = await call(
      { endpoint: "getRef", path: `${repo}/git/ref/heads/${base}` },
      [200],
    );
    const sha = field(baseRef.json, "object", "sha");
    if (!sha) throw new Stop({ outcome: "apply_failed", status: baseRef.status });
    // The same draft is never opened twice: an open pull request from its branch is the result.
    const open = await call(
      {
        endpoint: "listPulls",
        path: `${repo}/pulls`,
        query: { head: `${owner}:${branch}`, state: "open" },
      },
      [200],
    );
    const existing = Array.isArray(open.json) ? field(open.json[0], "html_url") : undefined;
    if (existing) return await finish({ outcome: "applied", ref: existing });

    const [createRef, ...rest] = writes;
    await call({ ...createRef!, body: { ...createRef!.body, sha } }, [201]);
    const createPull = rest.pop()!;
    for (const put of rest) {
      const filePath = put.path.slice(`${repo}/contents/`.length);
      const current = await call(
        { endpoint: "getContent", path: `${repo}/contents/${filePath}`, query: { ref: base } },
        [200, 404],
      );
      const blob = current.status === 200 ? field(current.json, "sha") : undefined;
      await call({ ...put, body: { ...put.body, ...(blob ? { sha: blob } : {}) } }, [200, 201]);
    }
    const pull = await call(createPull, [201]);
    return await finish({ outcome: "applied", ref: field(pull.json, "html_url") });
  } catch (e) {
    if (e instanceof Stop) return finish(e.entry);
    throw e;
  }
}
