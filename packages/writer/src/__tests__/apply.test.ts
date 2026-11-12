/**
 * The writer (ADR-0010): after a recorded approval, the customer's worker pushes one branch and opens one
 * draft pull request, and nothing else. Every test uses a recording stand-in for GitHub; no network.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyPullRequest, type ApplyDeps } from "../github/apply.js";
import { DEFAULT_MODE, KILL_SWITCH_ENV, resolveMode } from "../switches.js";
import { checkDraftPayload } from "../kinds.js";
import { DRAFT, PAYLOAD, TOKEN, deps, fakeGithub, job, sha256 } from "./helpers.js";

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
    expect(put.query).toBeUndefined();
    expect(gh.sent.find((r) => r.endpoint === "getContent")!.query).toEqual({ ref: "main" });
  });

  it("does not open a second pull request for the same draft", async () => {
    const gh = fakeGithub({ existingPull: true });
    const out = await applyPullRequest(job(), deps({ send: gh.send }));
    expect(gh.sent.map((r) => r.endpoint)).toEqual(["getRef", "listPulls"]);
    expect(out).toMatchObject({ outcome: "applied", ref: "https://github.com/acme/site/pull/7" });
  });

  it("treats a pull request from the draft's branch that was since closed as already applied", async () => {
    // The replay after the pull request was closed and the branch deleted must not open a second one.
    const gh = fakeGithub({ closedPull: true });
    const d = deps({ send: gh.send });
    const out = await applyPullRequest(job(), d);
    expect(gh.sent.map((r) => r.endpoint)).toEqual(["getRef", "listPulls"]);
    expect(gh.sent[1]!.query).toMatchObject({ state: "all" });
    expect(out).toMatchObject({ outcome: "applied", ref: "https://github.com/acme/site/pull/7" });
    expect(d.log).toEqual([out]);
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

describe("the default is a dry run", () => {
  it("the mode a configuration gets when it says nothing is dry-run", () => {
    expect(DEFAULT_MODE).toBe("dry-run");
    expect(resolveMode(undefined)).toBe("dry-run");
    expect(resolveMode(null)).toBe("dry-run");
  });

  it("only the exact word write turns writing on; any other value is a dry run", () => {
    expect(resolveMode("write")).toBe("write");
    for (const v of [
      "Write",
      "WRITE",
      " write",
      "write ",
      "true",
      "1",
      "",
      "dry-run",
      "yes",
      1,
      true,
      {},
    ])
      expect(resolveMode(v), String(v)).toBe("dry-run");
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
    "the same path twice": {
      ...PAYLOAD,
      files: [
        { path: "content/a.md", content: "one" },
        { path: "content/a.md", content: "two" },
      ],
    },
    "a file with an extra key": { ...PAYLOAD, files: [{ path: "a.ts", content: "", mode: "755" }] },
    "a non-string body": { ...PAYLOAD, body: { text: "x" } },
    "a control character": { ...PAYLOAD, body: "ok\u0000" },
    "not an object": ["x"],
  };
  for (const [name, payload] of Object.entries(bad))
    it(`refuses ${name}`, async () => {
      expect(checkDraftPayload("pull_request", payload).ok).toBe(false);
      const gh = fakeGithub();
      const j = job(payload);
      const out = await applyPullRequest(j, deps({ send: gh.send }, j));
      expect(out).toMatchObject({ outcome: "refused", reason: "payload" });
      expect(gh.sent).toEqual([]);
    });

  it("refuses a payload that is not the one approved (its hash differs)", async () => {
    const gh = fakeGithub();
    const swapped = { ...job(), payloadText: JSON.stringify({ ...PAYLOAD, title: "Swapped" }) };
    const out = await applyPullRequest(swapped, deps({ send: gh.send }));
    expect(out).toMatchObject({ outcome: "refused", reason: "hash" });
    expect(gh.sent).toEqual([]);
  });

  it("refuses a job of another kind", async () => {
    const gh = fakeGithub();
    const out = await applyPullRequest({ ...job(), kind: "email" }, deps({ send: gh.send }));
    expect(out).toMatchObject({ outcome: "refused" });
    expect(gh.sent).toEqual([]);
  });

  it("refuses another kind even when its approval row agrees and the payload has a pull request's shape", async () => {
    const gh = fakeGithub();
    const j = job(PAYLOAD, { kind: "email" });
    const out = await applyPullRequest(j, deps({ send: gh.send }, j));
    expect(out).toMatchObject({ outcome: "refused", reason: "kind" });
    expect(gh.sent).toEqual([]);
  });

  it("refuses payload text that is not JSON, even with a matching approval hash", async () => {
    const gh = fakeGithub();
    const text = "{not json";
    const j = job(PAYLOAD, { payloadText: text, payloadSha256: sha256(text) });
    const out = await applyPullRequest(j, deps({ send: gh.send }, j));
    expect(out).toMatchObject({ outcome: "refused", reason: "payload" });
    expect(gh.sent).toEqual([]);
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

describe("docs/hosted/writer.md", () => {
  it("shows the real dry-run entry for the bar's menu link", async () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const page = readFileSync(join(root, "docs/hosted/writer.md"), "utf8");
    const shown = /```json\n([\s\S]*?)\n```/.exec(page)![1]!;
    const out = await applyPullRequest(job(), deps({ send: fakeGithub().send, mode: "dry-run" }));
    expect(JSON.parse(shown)).toEqual(out);
  });
});
