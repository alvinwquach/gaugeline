import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type FixtureServer } from "../../../core/src/__tests__/helpers/server.js";
import { main } from "../main.js";

const servers: FixtureServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function receiver(status: number) {
  const got: string[] = [];
  const s = await startServer({}, (req: IncomingMessage, res: ServerResponse) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      got.push(req.url ?? "");
      res.writeHead(status).end();
    });
  });
  servers.push(s);
  return { origin: s.origin, got };
}

async function run(fixture: string, flags: string[], env: Record<string, string> = {}) {
  const site = await startFixture(fixture);
  const cwd = mkdtempSync(join(tmpdir(), "gaugeline-notify-"));
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
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    await site.close();
  }
}

describe("notifications: e2e (CLI, a fixture server as the receiver)", () => {
  it("one channel answers 500: the others deliver, the exit code is unchanged, and only the host is printed", async () => {
    const ok = await receiver(200);
    const bad = await receiver(500);
    const r = await run(
      "quick-start",
      [
        "--slack",
        `${ok.origin}/services/T1/B1/SECRETSLACK`,
        "--discord",
        `${bad.origin}/api/webhooks/1/SECRETDISCORD`,
        "--report-url",
        "https://reports.example/r/1",
      ],
      { GAUGELINE_WEBHOOK: `${ok.origin}/hook/SECRETHOOK` },
    );
    expect(r.code).toBe(0);
    expect(r.err).toContain("Sent to Slack.\n");
    expect(r.err).toContain("Could not send to Discord: 127.0.0.1 answered 500.\n");
    expect(r.err).toContain("Sent to the webhook.\n");
    expect(`${r.out}${r.err}`).not.toMatch(/SECRET|\/services\/|\/api\/webhooks\/|\/hook\//);
    expect(ok.got.sort()).toEqual(["/hook/SECRETHOOK", "/services/T1/B1/SECRETSLACK"]);
  });

  it("--ci keeps its exit code whatever the sends do", async () => {
    const bad = await receiver(500);
    const r = await run("quick-start", ["--ci", "--webhook", `${bad.origin}/x`]);
    // quick-start has a fix-first finding: --ci exits 1 for that, not for the failed send.
    expect(r.code).toBe(1);
  });

  it("--notify-on high with nothing to fix first sends nothing and says so on stderr", async () => {
    const hook = await receiver(200);
    const r = await run("clean", ["--notify-on", "high", "--webhook", `${hook.origin}/x`]);
    expect(hook.got).toEqual([]);
    expect(r.err).toContain("Nothing sent: --notify-on high and nothing needs fixing first.\n");
  });

  it("--notify-on with another value exits 2", async () => {
    const r = await run("clean", ["--notify-on", "sometimes"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--notify-on accepts any, high or always, not "sometimes".');
  });
});
