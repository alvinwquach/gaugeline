import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CheckRegistry,
  createCommentSender,
  defineCheck,
  type Finding,
  type PageSnapshot,
} from "@gaugeline/core";
import { main } from "../main.js";
import {
  html,
  startServer,
  type FixtureServer,
} from "../../../core/src/__tests__/helpers/server.js";
import {
  routeTo,
  startServer as startGithub,
  type Hit,
} from "../../../core/src/pr-comment/__tests__/send-helpers.js";

/**
 * `--pr-comment` through main(), on an invented studio's preview: the checks are small rules defined here, so the
 * findings are known in advance. GitHub is a server on a loopback address; the sender's request is routed to it.
 * Nothing here reaches GitHub or uses a real token.
 */

const TOKEN = "demo-token-A1b2C3d4E5f6G7h8I9j0";
const GOLDEN = fileURLToPath(new URL("./golden/pr-comment.golden.txt", import.meta.url));

let site: FixtureServer;
beforeAll(async () => {
  site = await startServer({
    "/": html(
      "<html><head><title>Brightside Dental</title></head><body><h1>Smile</h1></body></html>",
    ),
  });
});
afterAll(async () => {
  await site.close();
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
function folder(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-prc-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

/** A rule that reports one fixed finding. */
function rule(id: string, severity: Finding["severity"], title: string) {
  return defineCheck<PageSnapshot>({
    id,
    area: "Visitors",
    severity,
    title,
    what: "w",
    why: "y",
    fix: "f",
    tech: "t",
    size: "S",
    done: "d",
    estimateChanges: "e",
    run: (page) => [
      { checkId: id, severity, title, evidence: `${id} on the page`, url: page.finalUrl },
    ],
  });
}
const registryOf = (...checks: ReturnType<typeof rule>[]) => {
  const r = new CheckRegistry();
  for (const c of checks) r.register(c);
  return r;
};
const SAMPLE = [
  rule("menu-link-broken", "high", "The menu link gives a 404"),
  rule("title-missing", "medium", "A page has no title"),
  rule("title-long", "medium", "A title is too long"),
  rule("image-heavy", "low", "An image is very large"),
];

const created = (res: ServerResponse) => {
  res.writeHead(201, { "content-type": "application/json" }).end('{"id":1}');
};

interface Options {
  args?: string[];
  rules?: ReturnType<typeof rule>[];
  /** What GitHub answers. Default: 201. */
  github?: (res: ServerResponse, hit: Hit) => void;
  /** Overrides of the workflow environment; undefined removes a key. */
  env?: Record<string, string | undefined>;
  dir?: string;
  event?: string;
}

async function run(o: Options = {}) {
  const dir = o.dir ?? folder();
  writeFileSync(
    join(dir, "event.json"),
    o.event ?? JSON.stringify({ pull_request: { number: 12 } }),
  );
  const gh = await startGithub((_req, res, hit) => (o.github ?? ((r) => created(r)))(res, hit));
  const siteBefore = site.log.length;
  let out = "";
  let err = "";
  const env: Record<string, string | undefined> = {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REPOSITORY: "brightside-studio/site",
    GITHUB_EVENT_PATH: join(dir, "event.json"),
    GITHUB_TOKEN: TOKEN,
    ...o.env,
  };
  const io = {
    stdout: { write: (s: string) => ((out += s), true) },
    stderr: { write: (s: string) => ((err += s), true) },
    env,
  };
  const r = routeTo(gh.port);
  const code = await main(
    [site.origin, "--allow-private", "--no-open", "--pr-comment", ...(o.args ?? [])],
    io,
    {
      registry: registryOf(...(o.rules ?? SAMPLE)),
      cwd: dir,
      now: () => new Date("2026-11-14T12:00:00Z"),
      prComment: { send: createCommentSender({ request: r.request }) },
    },
  );
  await gh.close();
  return {
    code,
    out,
    err,
    posts: gh.hits,
    requests: r.seen,
    siteMethods: site.log.slice(siteBefore).map((l) => l.method),
    dir,
  };
}

describe("--pr-comment: integration", () => {
  it("posts exactly one comment to the pull request, with the token in one header, and says so on stderr", async () => {
    const r = await run();
    expect(r.posts).toHaveLength(1);
    expect(r.requests.map((q) => `${q.options.method} ${q.url.href}`)).toEqual([
      "POST https://api.github.com/repos/brightside-studio/site/issues/12/comments",
    ]);
    expect(r.posts[0]).toMatchObject({
      method: "POST",
      path: "/repos/brightside-studio/site/issues/12/comments",
    });
    expect(r.posts[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const sent = JSON.parse(r.posts[0]!.body) as { body: string };
    expect(Object.keys(sent)).toEqual(["body"]);
    expect(sent.body).toContain("### Gaugeline: 4 findings");
    expect(r.err).toContain("Posted one summary comment on pull request #12.");
    expect(r.code).toBe(0);
  });

  it("the token reaches no output, no error and no comment, whatever GitHub answers", async () => {
    // Success is the path a line that echoed the token would most likely sit on, so it is checked first.
    for (const status of [201, 403, 404, 422, 500]) {
      for (const args of [[], ["--json"]]) {
        const r = await run({
          args,
          github: (res, hit) =>
            res
              .writeHead(status, { "content-type": "application/json" })
              .end(JSON.stringify({ echo: hit.headers })),
        });
        expect(r.posts, String(status)).toHaveLength(1);
        for (const text of [r.out, r.err, r.posts[0]!.body]) {
          expect(text, String(status)).not.toContain(TOKEN);
          expect(text, String(status)).not.toContain(Buffer.from(TOKEN).toString("base64"));
        }
      }
    }
  });

  it("the run still only reads the site: GET and HEAD, and the one POST went to GitHub", async () => {
    const r = await run();
    expect(r.siteMethods.length).toBeGreaterThan(0);
    for (const m of r.siteMethods) expect(["GET", "HEAD"]).toContain(m);
    expect(r.posts).toHaveLength(1);
  });

  it("does not change the exit code: --ci still exits 1 on a Fix this first finding, 0 otherwise", async () => {
    expect((await run({ args: ["--ci"] })).code).toBe(1);
    expect((await run({ args: ["--ci"], rules: SAMPLE.slice(1) })).code).toBe(0);
    const failing = await run({ args: ["--ci"] });
    expect(JSON.parse(failing.posts[0]!.body).body).toContain(
      "CLI exit code 1: 1 finding fails this run (--ci).",
    );
  });

  it("keeps --json clean: stdout is the result alone, the line goes to stderr", async () => {
    const r = await run({ args: ["--json"] });
    expect(() => JSON.parse(r.out)).not.toThrow();
    expect(r.out).not.toContain("summary comment");
    expect(r.err).toContain("Posted one summary comment");
  });

  it("sends nothing without the flag", async () => {
    const dir = folder();
    writeFileSync(join(dir, "event.json"), JSON.stringify({ pull_request: { number: 12 } }));
    const gh = await startGithub((_q, res) => created(res));
    let err = "";
    const r = routeTo(gh.port);
    await main(
      [site.origin, "--allow-private", "--no-open"],
      {
        stdout: { write: () => true },
        stderr: { write: (s: string) => ((err += s), true) },
        env: {
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REPOSITORY: "brightside-studio/site",
          GITHUB_EVENT_PATH: join(dir, "event.json"),
          GITHUB_TOKEN: TOKEN,
        },
      },
      {
        registry: registryOf(...SAMPLE),
        cwd: dir,
        prComment: { send: createCommentSender({ request: r.request }) },
      },
    );
    await gh.close();
    expect(gh.hits).toEqual([]);
    expect(r.seen).toEqual([]);
    expect(err).not.toContain("comment");
  });
});

describe("--pr-comment: versus main's baseline", () => {
  it("with a baseline saved from main, says how many findings are new and tags them", async () => {
    const dir = folder();
    // What main looked like: two of the four findings, written by the existing --baseline.
    await run({
      dir,
      args: ["--baseline", "main.json"],
      rules: SAMPLE.slice(0, 2),
      env: { GITHUB_EVENT_NAME: "push" },
    });
    const r = await run({ dir, args: ["--baseline", "main.json"] });
    const body = (JSON.parse(r.posts[0]!.body) as { body: string }).body;
    expect(body).toContain("### Gaugeline: 4 findings");
    expect(body).toContain(
      "**Compared with the baseline file:** 2 new, 2 already in the baseline file.",
    );
    expect(body.split("\n").filter((l) => /, new$/.test(l))).toHaveLength(2);
  });

  it("with no baseline, says there is none to compare with", async () => {
    const body = (JSON.parse((await run()).posts[0]!.body) as { body: string }).body;
    expect(body).toContain(
      "**Compared with the baseline file:** no baseline file to compare with.",
    );
  });

  it("a baseline file that does not exist yet is written, and the comment says there is none", async () => {
    const r = await run({ args: ["--baseline", "fresh.json"] });
    expect(r.err).toContain("Baseline written to fresh.json");
    expect(JSON.parse(r.posts[0]!.body).body).toContain("no baseline file to compare with");
  });
});

describe("--pr-comment: when nothing is posted", () => {
  const none = (r: Awaited<ReturnType<typeof run>>) => {
    expect(r.posts).toEqual([]);
    expect(r.requests).toEqual([]);
  };

  it("an event that is not a pull_request: no request, one plain line", async () => {
    for (const GITHUB_EVENT_NAME of ["push", "pull_request_target", "deployment_status", ""]) {
      const r = await run({ env: { GITHUB_EVENT_NAME } });
      none(r);
      expect(r.err).toContain("No comment posted: this run is not a pull_request event.");
      expect(r.code).toBe(0);
    }
  });

  it("no GITHUB_TOKEN: no request, one plain line naming the permission", async () => {
    const r = await run({ env: { GITHUB_TOKEN: undefined } });
    none(r);
    expect(r.err).toContain("No comment posted: GITHUB_TOKEN is not set.");
    expect(r.err).toContain("pull-requests: write");
  });

  it("an event file that is missing, not JSON, or names no pull request", async () => {
    for (const event of ["not json", "{}", '{"pull_request":{"number":"12"}}', "[]"]) {
      const r = await run({ event });
      none(r);
      expect(r.err).toContain("No comment posted: the event file does not name a pull request.");
    }
    const missing = await run({ env: { GITHUB_EVENT_PATH: "/nonexistent/event.json" } });
    none(missing);
    expect(missing.err).toContain("the event file does not name a pull request");
    const unset = await run({ env: { GITHUB_EVENT_PATH: undefined } });
    none(unset);
  });

  it("a repository that is not owner/name", async () => {
    const r = await run({ env: { GITHUB_REPOSITORY: "../evil" } });
    none(r);
    expect(r.err).toContain("GITHUB_REPOSITORY is not owner/name");
  });
});

describe("--pr-comment: when GitHub says no", () => {
  const answers: Array<[number, Record<string, string>, string]> = [
    [403, {}, "could not post the comment (read-only token)"],
    [403, { "retry-after": "30" }, "could not post the comment (rate limited)"],
    [401, {}, "could not post the comment (token not accepted)"],
    [404, {}, "could not post the comment (pull request not found, or the token cannot see it)"],
    [422, {}, "could not post the comment (GitHub did not accept it)"],
    [500, {}, "could not post the comment (GitHub is not answering)"],
    [
      302,
      { location: "https://evil.example/" },
      "could not post the comment (unexpected redirect, not followed)",
    ],
  ];
  for (const [status, headers, line] of answers)
    it(`${status}${headers["retry-after"] ? " with retry-after" : ""}: one plain line, one request, the check's result unchanged`, async () => {
      const r = await run({
        args: ["--ci"],
        github: (res) =>
          res.writeHead(status, { "content-type": "application/json", ...headers }).end("{}"),
      });
      expect(r.err).toContain(line);
      expect(r.posts).toHaveLength(1);
      expect(r.requests).toHaveLength(1);
      // The same exit code as without the flag: 1 with --ci and a "Fix this first" finding.
      expect(r.code).toBe(1);
    });

  it("a fork's read-only token never fails the check", async () => {
    const r = await run({
      github: (res) =>
        res
          .writeHead(403, { "content-type": "application/json" })
          .end('{"message":"Resource not accessible by integration"}'),
    });
    expect(r.err).toContain("could not post the comment (read-only token)");
    expect(r.err).not.toContain("Resource not accessible");
    expect(r.code).toBe(0);
  });
});

describe("--pr-comment: end to end, a sample run to the comment", () => {
  const MAIN = [
    rule("menu-link-broken", "high", "The menu link gives a 404"),
    rule("title-missing", "medium", "A page has no title"),
    rule("image-heavy", "low", "An image is very large"),
  ];
  const PR = [
    ...MAIN,
    rule(
      "cms-token-in-client-code",
      "high",
      "A content-system token is in code that is sent to the browser",
    ),
    rule("title-long", "medium", "A title is too long"),
  ];

  it("matches the golden comment (docs/ci.md shows the same text)", async () => {
    const dir = folder();
    // Main already had a broken menu link, a missing title and a heavy image; this pull request adds a token in
    // client code and a long title. The known "Fix this first" finding does not fail the run; the new one does.
    await run({
      dir,
      args: ["--baseline", "main.json"],
      rules: MAIN,
      env: { GITHUB_EVENT_NAME: "push" },
    });
    const r = await run({ dir, args: ["--ci", "--baseline", "main.json"], rules: PR });
    expect(r.code).toBe(1);
    const body = (JSON.parse(r.posts[0]!.body) as { body: string }).body;
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(GOLDEN, body);
    expect(body).toBe(readFileSync(GOLDEN, "utf8"));
  });

  it("says one finding fails when three known 'Fix this first' findings sit beside one new one", async () => {
    const dir = folder();
    const known = [
      rule("known-a", "high", "Known A"),
      rule("known-b", "high", "Known B"),
      rule("known-c", "high", "Known C"),
    ];
    await run({
      dir,
      args: ["--baseline", "main.json"],
      rules: known,
      env: { GITHUB_EVENT_NAME: "push" },
    });
    const r = await run({
      dir,
      args: ["--ci", "--baseline", "main.json"],
      rules: [...known, rule("fresh-d", "high", "Fresh D")],
    });
    const body = (JSON.parse(r.posts[0]!.body) as { body: string }).body;
    expect(r.code).toBe(1);
    expect(body).toContain("| Fix this first | 4 |");
    expect(body).toContain("CLI exit code 1: 1 finding fails this run (--ci).");
  });

  it("says one finding fails when a 'Fix soon' finding is set to block and nothing is 'Fix this first'", async () => {
    const dir = folder({
      "gaugeline.config.json": JSON.stringify({ checks: { "title-long": "block" } }),
    });
    const r = await run({
      dir,
      args: ["--ci"],
      rules: [rule("title-long", "medium", "A title is too long")],
    });
    const body = (JSON.parse(r.posts[0]!.body) as { body: string }).body;
    expect(r.code).toBe(1);
    expect(body).toContain("| Fix this first | 0 |");
    expect(body).toContain("CLI exit code 1: 1 finding fails this run (--ci).");
  });

  it("says CLI exit code 0 without --ci, however many findings, so a stricter job never makes it false", async () => {
    const body = (JSON.parse((await run({ rules: PR })).posts[0]!.body) as { body: string }).body;
    expect(body).toContain("CLI exit code 0.");
    expect(body).not.toMatch(/^Exit code/m);
  });
});

describe("--pr-comment is for a plain check", () => {
  it("handoff, brief, audit and launch refuse it as an unknown option and send nothing", async () => {
    for (const argv of [
      ["handoff", site.origin, "--pr-comment"],
      ["brief", site.origin, "--pr-comment"],
      ["audit", site.origin, "--pack", "--pr-comment"],
      ["launch", site.origin, "--pr-comment"],
    ]) {
      const gh = await startGithub((_q, res) => created(res));
      let err = "";
      const code = await main(
        [...argv, "--allow-private", "--no-open"],
        {
          stdout: { write: () => true },
          stderr: { write: (s: string) => ((err += s), true) },
          env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_TOKEN: TOKEN },
        },
        { registry: registryOf(...SAMPLE), cwd: folder() },
      );
      await gh.close();
      expect(code, argv.join(" ")).toBe(2);
      expect(err).toContain("Unknown option --pr-comment");
      expect(gh.hits).toEqual([]);
    }
  });
});

describe("the one caller of the sender", () => {
  it("passes it no request or resolve option: those exist for tests, and production uses node:https and DNS", () => {
    const code = readFileSync(
      fileURLToPath(new URL("../pr-comment.ts", import.meta.url)),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code.match(/createCommentSender\(/g)).toHaveLength(1);
    expect(code).toMatch(/createCommentSender\(\)/);
    // And no other CLI source file builds a sender or names the sender's request types.
    const main = readFileSync(fileURLToPath(new URL("../main.ts", import.meta.url)), "utf8");
    expect(main).not.toMatch(/createCommentSender|RequestFn|NameResolver/);
  });
});
