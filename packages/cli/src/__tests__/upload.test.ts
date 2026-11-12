import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type FixtureServer } from "../../../core/src/__tests__/helpers/server.js";
import { main } from "../main.js";
import { FLAGS } from "../flags.js";

const servers: FixtureServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TOKEN = ["glt", "0a1b2c3d", "y".repeat(43)].join("_");

async function hosted(status: number, message = "The token is not valid.") {
  const seen: { url?: string; auth?: string; key?: string; body: string }[] = [];
  const s = await startServer({}, (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        url: req.url,
        auth: req.headers.authorization,
        key: req.headers["idempotency-key"] as string | undefined,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(status < 300 ? { id: "r" } : { code: "x", message }));
    });
  });
  servers.push(s);
  return { origin: s.origin, seen };
}

async function run(fixture: string, flags: string[], env: Record<string, string> = {}) {
  const site = await startFixture(fixture);
  const cwd = mkdtempSync(join(tmpdir(), "gaugeline-upload-"));
  dirs.push(cwd);
  const out: string[] = [];
  const err: string[] = [];
  try {
    const io = {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1", ...env },
    };
    const code = await main([site.origin, "--allow-private", "--no-open", ...flags], io, { cwd });
    return { code, out: out.join(""), err: err.join(""), origin: site.origin };
  } finally {
    await site.close();
  }
}

describe("--upload: e2e (CLI, a stand-in hosted API as the receiver)", () => {
  it("posts the run's result to <address>/runs with the token, after the run", async () => {
    const api = await hosted(201);
    const r = await run("quick-start", ["--upload"], {
      GAUGELINE_TOKEN: TOKEN,
      GAUGELINE_UPLOAD_URL: `${api.origin}/api/v1`,
    });
    expect(api.seen).toHaveLength(1);
    const s = api.seen[0]!;
    expect(s.url).toBe("/api/v1/runs");
    expect(s.auth).toBe(`Bearer ${TOKEN}`);
    expect(s.key).toMatch(/^gl-[0-9a-f]{32}$/);
    const body = JSON.parse(s.body) as { schema: number; url: string; findings: unknown[] };
    expect(body.schema).toBe(2);
    expect(body.url).toContain(r.origin);
    expect(body.findings.length).toBeGreaterThan(0);
    expect(r.err).toMatch(/Uploaded \d+ findings? to 127\.0\.0\.1\.\n/);
    expect(`${r.out}${r.err}`).not.toContain(TOKEN);
  });

  it("nothing is sent without --upload, even with the token and address set", async () => {
    const api = await hosted(201);
    await run("clean", [], {
      GAUGELINE_TOKEN: TOKEN,
      GAUGELINE_UPLOAD_URL: `${api.origin}/api/v1`,
    });
    expect(api.seen).toHaveLength(0);
  });

  it("an upload failure never changes the exit code: refused, unreachable, no token, no address", async () => {
    const baseline = await run("quick-start", ["--ci"]);
    expect(baseline.code).toBe(1);
    const clean = await run("clean", ["--ci"]);
    expect(clean.code).toBe(0);
    const refused = await hosted(401);
    const cases: Array<[Record<string, string>, RegExp]> = [
      [
        { GAUGELINE_TOKEN: TOKEN, GAUGELINE_UPLOAD_URL: `${refused.origin}/api/v1` },
        /Could not upload: 127\.0\.0\.1 answered 401: The token is not valid\.\n/,
      ],
      [
        { GAUGELINE_TOKEN: TOKEN, GAUGELINE_UPLOAD_URL: "http://127.0.0.1:1/api/v1" },
        /Could not upload: 127\.0\.0\.1 could not be reached/,
      ],
      [{ GAUGELINE_UPLOAD_URL: `${refused.origin}/api/v1` }, /Not uploaded: set GAUGELINE_TOKEN/],
      [{ GAUGELINE_TOKEN: TOKEN }, /Not uploaded: set GAUGELINE_UPLOAD_URL/],
    ];
    for (const [env, line] of cases) {
      for (const [fixture, expected] of [
        ["quick-start", 1],
        ["clean", 0],
      ] as const) {
        const r = await run(fixture, ["--ci", "--upload"], env);
        expect(r.code, `${fixture} ${JSON.stringify(Object.keys(env))}`).toBe(expected);
        expect(r.err).toMatch(line);
        expect(r.err).not.toContain(TOKEN);
      }
    }
  }, 60_000);

  it("--json still prints only JSON on stdout; the upload's line goes to stderr", async () => {
    const api = await hosted(201);
    const r = await run("clean", ["--json", "--upload"], {
      GAUGELINE_TOKEN: TOKEN,
      GAUGELINE_UPLOAD_URL: `${api.origin}/api/v1`,
    });
    expect(() => JSON.parse(r.out)).not.toThrow();
    expect(r.err).toContain("Uploaded 0 findings to 127.0.0.1.");
  });

  it("a result that contains the value of a key in the environment is not sent", async () => {
    const api = await hosted(201);
    // The result's address starts with the checked origin: let a variable named like a key hold that.
    const r = await run("quick-start", ["--upload"], {
      GAUGELINE_TOKEN: TOKEN,
      GAUGELINE_UPLOAD_URL: `${api.origin}/api/v1`,
      MY_SERVICE_API_KEY: "http://127.0.0.1:",
    });
    expect(api.seen).toHaveLength(0);
    expect(r.err).toContain(
      "Not uploaded: the result contains the value of MY_SERVICE_API_KEY, so nothing was sent.",
    );
  });

  it("--upload is a flag of the check, and it is the only upload flag (the address is an environment variable)", () => {
    const upload = FLAGS.filter((f) => f.name.startsWith("upload"));
    expect(upload.map((f) => f.name)).toEqual(["upload"]);
    expect(upload[0]!.type).toBe("boolean");
    expect(upload[0]!.commands).toContain("check");
  });
});
