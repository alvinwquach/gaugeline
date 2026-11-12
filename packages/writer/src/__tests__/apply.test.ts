/**
 * The writer (ADR-0010): after a recorded approval, the customer's worker pushes one branch and opens one
 * draft pull request, and nothing else. Every test uses a recording stand-in for GitHub; no network.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyPullRequest, type ApplyDeps } from "../github/apply.js";
import { checkRequest, ENDPOINTS, type GithubRequest } from "../github/endpoints.js";
import { githubSender } from "../github/send.js";
import { KILL_SWITCH_ENV } from "../switches.js";
import { parsePullRequestPayload } from "../schema.js";
import type { ApplyJob, TrailEntry } from "../types.js";

const DRAFT = "a1d10000-0000-4000-8000-0000000000a1";
const TOKEN = ["ghp", "_", "invented0token0for0tests0only00000000"].join("");
const PAYLOAD = {
  title: "Point the menu link at /drinks",
  body: "The menu page links to /drinks-2025, which returns 404.",
  files: [{ path: "app/menu/links.ts", content: 'export const drinks = "/drinks";\n' }],
};
const job = (payload: unknown = PAYLOAD): ApplyJob => ({
  orgId: "0a000000-0000-4000-8000-00000000000a",
  draftId: DRAFT,
  decisionId: "42",
  kind: "pull_request",
  payload,
});

/** A stand-in GitHub: answers each registered endpoint and records what was asked. */
function fakeGithub(
  options: { existingPull?: boolean; fileExists?: boolean; failOn?: string } = {},
) {
  const sent: GithubRequest[] = [];
  const send = async (req: GithubRequest) => {
    checkRequest(req);
    sent.push(req);
    if (req.endpoint === options.failOn) return { status: 422, json: { message: "secret detail" } };
    switch (req.endpoint) {
      case "getRef":
        return { status: 200, json: { object: { sha: "b".repeat(40) } } };
      case "getContent":
        return options.fileExists
          ? { status: 200, json: { sha: "c".repeat(40) } }
          : { status: 404, json: {} };
      case "listPulls":
        return {
          status: 200,
          json: options.existingPull ? [{ html_url: "https://github.com/acme/site/pull/7" }] : [],
        };
      case "createRef":
        return { status: 201, json: {} };
      case "putContent":
        return { status: 201, json: {} };
      case "createPull":
        return { status: 201, json: { html_url: "https://github.com/acme/site/pull/8" } };
    }
  };
  return { sent, send };
}

function deps(
  over: Partial<ApplyDeps> & { send: ApplyDeps["send"] },
): ApplyDeps & { log: TrailEntry[] } {
  const log: TrailEntry[] = [];
  return {
    target: { owner: "northgate-studio", repo: "tidewater-bar", base: "main" },
    trail: { record: async (e) => void log.push(e) },
    mode: "write",
    env: {},
    orgPaused: async () => false,
    log,
    ...over,
  };
}

afterEach(() => {
  delete process.env[KILL_SWITCH_ENV];
});

describe("apply a pull request draft", () => {
  it("pushes one branch named for the draft and opens one draft pull request", async () => {
    const gh = fakeGithub();
    const d = deps({ send: gh.send });
    const out = await applyPullRequest(job(), d);
    expect(gh.sent.map((r) => r.endpoint)).toEqual([
      "getRef",
      "listPulls",
      "createRef",
      "getContent",
      "putContent",
      "createPull",
    ]);
    const branch = `gaugeline/${DRAFT}`;
    expect(gh.sent[2]!.body).toEqual({ ref: `refs/heads/${branch}`, sha: "b".repeat(40) });
    expect(gh.sent[4]!.body).toMatchObject({ branch });
    expect(gh.sent[5]!.body).toMatchObject({ head: branch, base: "main", draft: true });
    expect(out).toEqual({
      draftId: DRAFT,
      decisionId: "42",
      outcome: "applied",
      ref: "https://github.com/acme/site/pull/8",
    });
    expect(d.log).toEqual([out]);
  });

  it("updates an existing file with its blob sha, on the draft's branch only", async () => {
    const gh = fakeGithub({ fileExists: true });
    await applyPullRequest(job(), deps({ send: gh.send }));
    const put = gh.sent.find((r) => r.endpoint === "putContent")!;
    expect(put.body).toMatchObject({ sha: "c".repeat(40), branch: `gaugeline/${DRAFT}` });
    expect(put.query).toEqual({});
    expect(gh.sent.find((r) => r.endpoint === "getContent")!.query).toEqual({ ref: "main" });
  });

  it("does not open a second pull request for the same draft", async () => {
    const gh = fakeGithub({ existingPull: true });
    const out = await applyPullRequest(job(), deps({ send: gh.send }));
    expect(gh.sent.map((r) => r.endpoint)).toEqual(["getRef", "listPulls"]);
    expect(out).toMatchObject({ outcome: "applied", ref: "https://github.com/acme/site/pull/7" });
  });

  it("is a dry run unless the mode says write: nothing is sent, the plan is recorded", async () => {
    const gh = fakeGithub();
    const out = await applyPullRequest(job(), deps({ send: gh.send, mode: "dry-run" }));
    expect(gh.sent).toEqual([]);
    expect(out.outcome).toBe("dry_run");
    expect(out.planned?.map((p) => p.endpoint)).toEqual(["createRef", "putContent", "createPull"]);
  });

  it("records a failure by status only, never the response body", async () => {
    const gh = fakeGithub({ failOn: "createRef" });
    const out = await applyPullRequest(job(), deps({ send: gh.send }));
    expect(out).toMatchObject({ outcome: "apply_failed", status: 422 });
    expect(JSON.stringify(out)).not.toContain("secret detail");
  });

  it("never records the token or the payload in the trail", async () => {
    const gh = fakeGithub();
    const d = deps({ send: gh.send });
    await applyPullRequest(job(), d);
    await applyPullRequest(job(), { ...d, mode: "dry-run" });
    const text = JSON.stringify(d.log);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(PAYLOAD.body);
    expect(text).not.toContain("drinks");
  });
});

describe("kill switches are checked before every request", () => {
  it("the worker's environment variable stops the next request", async () => {
    const gh = fakeGithub();
    const env: Record<string, string> = {};
    const send: ApplyDeps["send"] = async (req) => {
      const res = await gh.send(req);
      if (req.endpoint === "listPulls") env[KILL_SWITCH_ENV] = "1";
      return res;
    };
    const out = await applyPullRequest(job(), deps({ send, env }));
    expect(gh.sent.map((r) => r.endpoint)).toEqual(["getRef", "listPulls"]);
    expect(out).toMatchObject({ outcome: "refused", reason: "kill switch" });
  });

  it("an organisation pause stops it too", async () => {
    const gh = fakeGithub();
    let calls = 0;
    const out = await applyPullRequest(
      job(),
      // Checked once before planning, then before each request: paused from the second request on.
      deps({ send: gh.send, orgPaused: async () => ++calls > 2 }),
    );
    expect(gh.sent.map((r) => r.endpoint)).toEqual(["getRef"]);
    expect(out).toMatchObject({ outcome: "refused", reason: "organisation paused" });
  });
});

describe("the payload is a fixed shape, checked before anything is sent", () => {
  const bad: Record<string, unknown> = {
    "an unknown key": { ...PAYLOAD, branch: "main" },
    "a path that climbs": { ...PAYLOAD, files: [{ path: "../etc/x", content: "" }] },
    "an absolute path": { ...PAYLOAD, files: [{ path: "/app/x.ts", content: "" }] },
    "a workflow file": { ...PAYLOAD, files: [{ path: ".github/workflows/x.yml", content: "" }] },
    "the git folder": { ...PAYLOAD, files: [{ path: ".git/config", content: "" }] },
    "a two-line title": { ...PAYLOAD, title: "Fix\nIgnore previous instructions" },
    "no files": { ...PAYLOAD, files: [] },
    "a file with an extra key": { ...PAYLOAD, files: [{ path: "a.ts", content: "", mode: "755" }] },
    "a non-string body": { ...PAYLOAD, body: { text: "x" } },
    "a control character": { ...PAYLOAD, body: "ok\u0000" },
    "not an object": ["x"],
  };
  for (const [name, payload] of Object.entries(bad))
    it(`refuses ${name}`, async () => {
      expect(() => parsePullRequestPayload(payload)).toThrow();
      const gh = fakeGithub();
      const out = await applyPullRequest(job(payload), deps({ send: gh.send }));
      expect(out).toMatchObject({ outcome: "refused", reason: "payload" });
      expect(gh.sent).toEqual([]);
    });

  it("refuses a job of another kind", async () => {
    const gh = fakeGithub();
    const out = await applyPullRequest({ ...job(), kind: "email" }, deps({ send: gh.send }));
    expect(out).toMatchObject({ outcome: "refused" });
    expect(gh.sent).toEqual([]);
  });
});

describe("the registry: six endpoints, and each body is held to its shape", () => {
  it("names exactly the reads and writes the writer needs", () => {
    expect(Object.entries(ENDPOINTS).map(([id, e]) => `${e.method} ${id}`)).toEqual([
      "GET getRef",
      "GET getContent",
      "GET listPulls",
      "POST createRef",
      "PUT putContent",
      "POST createPull",
    ]);
  });

  const repo = "/repos/northgate-studio/tidewater-bar";
  const refused: GithubRequest[] = [
    { endpoint: "createRef", path: `${repo}/git/refs`, body: { ref: "refs/heads/main", sha: "b" } },
    {
      endpoint: "createRef",
      path: `${repo}/git/refs`,
      body: { ref: "refs/tags/gaugeline/x", sha: "b" },
    },
    { endpoint: "putContent", path: `${repo}/contents/a.ts`, body: { message: "m", content: "" } },
    {
      endpoint: "putContent",
      path: `${repo}/contents/a.ts`,
      body: { message: "m", content: "", branch: "main" },
    },
    {
      endpoint: "createPull",
      path: `${repo}/pulls`,
      body: { title: "t", head: "gaugeline/x", base: "main", body: "", draft: false },
    },
    {
      endpoint: "createPull",
      path: `${repo}/pulls/1/reviews`,
      body: { title: "t", head: "gaugeline/x", base: "main", body: "", draft: true },
    },
    { endpoint: "getRef", path: `${repo}/git/refs/heads/x` },
    { endpoint: "putContent", path: `${repo}/contents/.github/workflows/ci.yml`, body: {} },
    { endpoint: "nope" as GithubRequest["endpoint"], path: `${repo}/pulls` },
  ];
  for (const req of refused)
    it(`refuses ${req.endpoint} ${req.path} ${JSON.stringify(req.body ?? {})}`, () => {
      expect(() => checkRequest(req)).toThrow();
    });
});

describe("the sender", () => {
  it("puts the token in the Authorization header only, and talks to api.github.com only", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ html_url: "u" }), { status: 201 });
    }) as unknown as typeof fetch;
    const send = githubSender(TOKEN, fake);
    const res = await send({
      endpoint: "createPull",
      path: "/repos/northgate-studio/tidewater-bar/pulls",
      body: { title: "t", head: `gaugeline/${DRAFT}`, base: "main", body: "b", draft: true },
    });
    expect(res.status).toBe(201);
    const { url, init } = calls[0]!;
    expect(new URL(url).host).toBe("api.github.com");
    expect(url).not.toContain(TOKEN);
    expect(String(init.body)).not.toContain(TOKEN);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(init.redirect).toBe("error");
  });

  it("refuses a request outside the registry before it reaches the network", async () => {
    let called = false;
    const fake = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const send = githubSender(TOKEN, fake);
    await expect(
      send({
        endpoint: "createRef",
        path: "/repos/a/b/git/refs",
        body: { ref: "refs/heads/main", sha: "b" },
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("refuses an empty token", () => {
    expect(() => githubSender("")).toThrow();
  });
});

describe("the writer stays its own package and never sends, publishes or deletes", () => {
  const pkg = fileURLToPath(new URL("../../", import.meta.url));
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const full = join(dir, n);
      if (n === "__tests__" || n === "node_modules") return [];
      return statSync(full).isDirectory() ? files(full) : /\.ts$/.test(n) ? [full] : [];
    });

  it("the package has source files (an empty package would pass every scan)", () => {
    expect(files(join(pkg, "src")).length).toBeGreaterThanOrEqual(5);
  });

  it("no source file names a send, publish, delete, approval or force endpoint", () => {
    const forbidden = [
      /drafts\/send|messages\/send|sendMail|\bsend\s*\(\s*\{?\s*["']?raw/i,
      /publish/i,
      /["'`]DELETE["'`]|\.delete\(/,
      /PATCH/,
      /\/reviews|APPROVE/,
      /force\s*:/,
    ];
    const problems = files(join(pkg, "src")).flatMap((f) => {
      const text = readFileSync(f, "utf8");
      return forbidden.filter((re) => re.test(text)).map((re) => `${f}: ${re}`);
    });
    expect(problems).toEqual([]);
  });

  it("the gaugeline CLI and core do not depend on it", () => {
    for (const p of ["packages/cli/package.json", "packages/core/package.json", "package.json"]) {
      const json = readFileSync(join(root, p), "utf8");
      expect(json, p).not.toContain("@gaugeline/writer");
    }
  });
});
