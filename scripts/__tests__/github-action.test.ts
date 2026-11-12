import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixture } from "@gaugeline/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  MARKER,
  buildComment,
  commentTarget,
  decide,
  run,
  summarise,
  upsertComment,
} from "../action/gaugeline-action.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bin = join(root, "packages/cli/dist/index.js");
const dir = mkdtempSync(join(tmpdir(), "gaugeline-action-"));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

/** A SARIF log with just what the action reads: levels, titles, evidence, suppressions. */
const result = (level: string, title: string, evidence: string, muted = false) => ({
  ruleId: "x",
  level,
  message: { text: `${title}\nEvidence: ${evidence}` },
  properties: { evidence },
  ...(muted ? { suppressions: [{ kind: "external" }] } : {}),
});
const sarif = (...results: object[]) =>
  JSON.stringify({
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "Gaugeline" } }, results }],
  });

const SAMPLE = sarif(
  result("note", "A photo has no description", "<img src=/menu.jpg>"),
  result("error", "Links on this page go nowhere", '"Prices" | /prices returned 404'),
  result("warning", "The page title is short", "title is 4 characters"),
  result("error", "Muted one", "muted", true),
);

describe("the comment", () => {
  it("body snapshot: one marker, a summary, findings worst first, pipes escaped, muted ones left out", () => {
    expect(buildComment(SAMPLE, { url: "https://brightside-preview.example/", failOn: "high" }))
      .toBe(`<!-- gaugeline-action -->
### Gaugeline checked https://brightside-preview.example/

1 to fix first, 1 to fix soon, 1 worth knowing.

| Level | Finding | Evidence |
| --- | --- | --- |
| Fix this first | Links on this page go nowhere | "Prices" \\| /prices returned 404 |
| Fix soon | The page title is short | title is 4 characters |
| Worth knowing | A photo has no description | <img src=/menu.jpg> |

Fails the job on: "Fix this first" findings. This comment is edited on every run.
`);
  });

  it("says so when there is nothing, and counts what it does not list", () => {
    expect(buildComment(sarif(), { url: "https://a.example/", failOn: "never" })).toContain(
      "Nothing to look at.",
    );
    const many = sarif(...Array.from({ length: 14 }, (_, i) => result("note", `n${i}`, "e")));
    expect(buildComment(many, { url: "https://a.example/", failOn: "high" })).toContain(
      "...and 4 more",
    );
  });

  it("is found by its marker: the first run posts, the next run edits, nothing is added twice", async () => {
    const calls: { method: string; url: string }[] = [];
    let stored: { id: number; body: string }[] = [{ id: 7, body: "an unrelated comment" }];
    const fakeFetch = (async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      if (method === "GET") return Response.json(stored);
      const body = JSON.parse(init?.body ?? "{}").body as string;
      if (method === "POST") stored = [...stored, { id: 8, body }];
      else stored = stored.map((c) => (c.id === 8 ? { id: 8, body } : c));
      return Response.json({}, { status: method === "POST" ? 201 : 200 });
    }) as unknown as typeof fetch;
    const base = { repo: "studio/brightside", pr: 12, token: "t", fetch: fakeFetch };
    expect(await upsertComment({ ...base, body: `${MARKER}\nfirst` })).toMatchObject({
      done: true,
    });
    expect(await upsertComment({ ...base, body: `${MARKER}\nsecond` })).toMatchObject({
      done: true,
      why: "edited the earlier comment",
    });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect(calls.find((c) => c.method === "PATCH")?.url).toContain("/issues/comments/8");
    expect(stored.filter((c) => c.body.includes(MARKER))).toHaveLength(1);
    expect(stored.find((c) => c.id === 8)?.body).toContain("second");
  });

  it("a refused write is reported, not thrown", async () => {
    const f = (async (_u: string, init?: { method?: string }) =>
      init?.method === undefined
        ? Response.json([])
        : new Response("no", { status: 403 })) as unknown as typeof fetch;
    expect(await upsertComment({ body: MARKER, repo: "a/b", pr: 1, token: "t", fetch: f })).toEqual(
      { done: false, why: "GitHub answered 403" },
    );
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(
      await upsertComment({ body: MARKER, repo: "a/b", pr: 1, token: "t", fetch: boom }),
    ).toEqual({
      done: false,
      why: "offline",
    });
  });
});

describe("whether the job fails", () => {
  const s = (high: number, medium: number) => ({
    high,
    medium,
    low: 0,
    total: high + medium,
    rows: [],
  });
  it("high: only Fix this first. medium: also Fix soon. never: no finding fails it", () => {
    expect(decide({ exit: 1, failOn: "high", summary: s(1, 0) }).fail).toBe(true);
    expect(decide({ exit: 0, failOn: "high", summary: s(0, 3) }).fail).toBe(false);
    expect(decide({ exit: 0, failOn: "medium", summary: s(0, 3) }).fail).toBe(true);
    expect(decide({ exit: 0, failOn: "never", summary: s(5, 5) }).fail).toBe(false);
  });
  it("a check that could not run (exit 2, or no SARIF) always fails, whatever fail-on says", () => {
    expect(decide({ exit: 2, failOn: "never", summary: s(0, 0) }).fail).toBe(true);
    expect(decide({ exit: 0, failOn: "never", summary: undefined }).fail).toBe(true);
  });
  it("counts what the SARIF holds", () => {
    expect(summarise(SAMPLE)).toMatchObject({ high: 1, medium: 1, low: 1, total: 3 });
  });
});

describe("where a comment can be written", () => {
  const event = (pr: object) => {
    const path = join(dir, `event-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify({ pull_request: pr }));
    return path;
  };
  const env = (over: Record<string, string>) => ({
    GITHUB_TOKEN: "t",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REPOSITORY: "studio/brightside",
    ...over,
  });
  it("a pull request in the same repository: yes", () => {
    const p = event({ number: 3, head: { repo: { fork: false, full_name: "studio/brightside" } } });
    expect(commentTarget(env({ GITHUB_EVENT_PATH: p }))).toEqual({
      ok: true,
      repo: "studio/brightside",
      pr: 3,
    });
  });
  it("a pull request from a fork: no (its token is read-only)", () => {
    const p = event({ number: 3, head: { repo: { fork: true, full_name: "someone/brightside" } } });
    expect(commentTarget(env({ GITHUB_EVENT_PATH: p }))).toMatchObject({ ok: false });
  });
  it("no token, or a push: no", () => {
    expect(commentTarget({ ...env({}), GITHUB_TOKEN: "" })).toMatchObject({ ok: false });
    expect(commentTarget(env({ GITHUB_EVENT_NAME: "push" }))).toMatchObject({ ok: false });
  });
});

describe("action.yml", () => {
  const text = readFileSync(join(root, "action.yml"), "utf8");
  const action = parse(text) as {
    inputs: Record<string, { default?: string; required?: boolean }>;
    runs: { using: string; steps: { run?: string; uses?: string }[] };
  };
  it("takes url, fail-on and comment, with the defaults the docs state", () => {
    expect(action.inputs.url?.required).toBe(true);
    expect(action.inputs["fail-on"]?.default).toBe("high");
    expect(action.inputs.comment?.default).toBe("true");
    expect(action.runs.using).toBe("composite");
  });
  it("pins every action it uses by a 40-character commit, with the version beside it", () => {
    const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const m of uses) {
      expect(m[1], m[0]).toMatch(/@[0-9a-f]{40}$/);
      expect(m[2], m[0]).toMatch(/# v\d/);
    }
  });
  it("never puts an input into a script: values arrive through env", () => {
    for (const step of action.runs.steps) expect(step.run ?? "").not.toMatch(/\$\{\{/);
  });
});

describe("the action against a fixture (the built CLI)", () => {
  let site: Awaited<ReturnType<typeof startFixture>>;
  beforeAll(async () => {
    site = await startFixture("deploy-preview-dentist");
  });
  afterAll(async () => {
    await site.close();
  });

  const base = (name: string, over: Record<string, string> = {}) => {
    const out = join(dir, `${name}-output.txt`);
    writeFileSync(out, "");
    return {
      out,
      env: {
        INPUT_URL: `${site.origin}/`,
        INPUT_ALLOW_PRIVATE: "true",
        INPUT_SARIF_FILE: join(dir, `${name}.sarif`),
        GITHUB_OUTPUT: out,
        GAUGELINE_ACTION_BIN: JSON.stringify([process.execPath, bin]),
        NO_COLOR: "1",
        ...over,
      } as Record<string, string>,
    };
  };

  it("fails on a high finding, writes the SARIF, and posts one comment on a pull request", async () => {
    const eventPath = join(dir, "pr-event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: {
          number: 9,
          head: { repo: { fork: false, full_name: "studio/brightside" } },
        },
      }),
    );
    const sent: { method: string; body?: string }[] = [];
    const f = (async (_u: string, init?: { method?: string; body?: string }) => {
      sent.push({ method: init?.method ?? "GET", ...(init?.body ? { body: init.body } : {}) });
      return init?.method ? Response.json({}, { status: 201 }) : Response.json([]);
    }) as unknown as typeof fetch;
    const { env, out } = base("high", {
      GITHUB_TOKEN: "t",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "studio/brightside",
    });
    const r = await run(env, { log: () => undefined, fetch: f });
    expect(r.failed).toBe(true);
    expect(JSON.parse(readFileSync(env.INPUT_SARIF_FILE as string, "utf8")).version).toBe("2.1.0");
    expect(readFileSync(out, "utf8")).toMatch(/failed=true\nsarif-file=.*\.sarif\nhigh=[1-9]\d*\n/);
    const posts = sent.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]?.body ?? "{}").body).toContain("Links on this page go nowhere");
  }, 60000);

  it("fail-on never: the same findings, the job passes", async () => {
    const { env } = base("never", { INPUT_FAIL_ON: "never", INPUT_COMMENT: "false" });
    expect((await run(env, { log: () => undefined })).failed).toBe(false);
  }, 60000);

  it("a pull request from a fork has no token to write with: no comment is tried, and the check still reports", async () => {
    const eventPath = join(dir, "fork-event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: {
          number: 9,
          head: { repo: { fork: true, full_name: "someone/brightside" } },
        },
      }),
    );
    const notes: string[] = [];
    let fetched = 0;
    const f = (async () => {
      fetched += 1;
      return Response.json([]);
    }) as unknown as typeof fetch;
    const { env } = base("fork", {
      GITHUB_TOKEN: "t",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "studio/brightside",
    });
    const r = await run(env, { log: (l) => notes.push(l), fetch: f });
    expect(fetched).toBe(0);
    expect(notes.join("\n")).toContain("fork");
    expect(r.failed).toBe(true);
  }, 60000);

  it("an empty url or a bad fail-on fails with a sentence, before anything is requested", async () => {
    const notes: string[] = [];
    const a = await run({ INPUT_URL: "" }, { log: (l) => notes.push(l) });
    const b = await run(
      { INPUT_URL: "https://a.example/", INPUT_FAIL_ON: "sometimes" },
      { log: (l) => notes.push(l) },
    );
    expect([a.failed, b.failed]).toEqual([true, true]);
    expect(notes.join("\n")).toContain('fail-on accepts high, medium or never, not "sometimes"');
  });
});
