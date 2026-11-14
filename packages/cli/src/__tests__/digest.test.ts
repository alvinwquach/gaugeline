// check-community: allow-email (invented addresses at reserved example domains, used by the test)
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, expectedOutput } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../main.js";

const RUNS = join(SITES_DIR, "..", "runs", "digest-week");
const KEY = "re_planted_digest_7f6e5d";

function capture(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1", ...env },
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

async function receiver(status = 200) {
  const got: { headers: IncomingMessage["headers"]; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => {
      got.push({ headers: req.headers, body: data });
      res.writeHead(status, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${port}/in`, got };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-digest-"));
  cpSync(RUNS, join(dir, "runs"), { recursive: true });
  rmSync(join(dir, "runs", "README.md"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("digest: e2e (CLI)", () => {
  it("gaugeline digest --runs runs prints the weekly digest guide's Output block and writes both files", async () => {
    const cwd = workdir();
    const run = capture();
    const code = await main(
      ["digest", "--runs", "runs", "--time-zone", "America/Los_Angeles"],
      run.io,
      {
        cwd,
      },
    );
    expect(code).toBe(0);
    expect(run.out().trimEnd()).toBe(expectedOutput("guides/weekly-digest", "Example"));
    expect(readFileSync(join(cwd, "gaugeline-digest.md"), "utf8")).toBe(run.out());
    expect(readFileSync(join(cwd, "gaugeline-digest.html"), "utf8")).toContain(
      "<strong>This week: 1 new thing to fix, 1 fixed and 2 older ones still open.</strong>",
    );
    expect(run.err()).toBe("Digest written to ./gaugeline-digest.md and ./gaugeline-digest.html\n");
  });

  it("nothing is sent unless sending is configured; a configured webhook gets it once", async () => {
    const hook = await receiver();
    const cwd = workdir();
    await main(["digest", "--runs", "runs"], capture().io, { cwd });
    expect(hook.got).toEqual([]);
    const run = capture({ GAUGELINE_WEBHOOK: hook.url });
    await main(["digest", "--runs", "runs"], run.io, { cwd });
    expect(hook.got).toHaveLength(1);
    const body = JSON.parse(hook.got[0]?.body ?? "{}") as { kind: string; verdict: string };
    expect(body.kind).toBe("gaugeline-digest");
    expect(body.verdict).toBe(
      "This week: 1 new thing to fix, 1 fixed and 2 older ones still open.",
    );
    expect(hook.got[0]?.body).not.toContain("a1b2c3d4");
    expect(run.err()).toContain("Sent the digest to the webhook.\n");
  });

  it("emails it through Resend when configured; the planted key appears in no output or file", async () => {
    const api = await receiver(200);
    const cwd = workdir();
    const run = capture({
      GAUGELINE_EMAIL: "owner@harbour-books.example",
      RESEND_API_KEY: KEY,
      GAUGELINE_EMAIL_FROM: "Digest <digest@harbour-books.example>",
    });
    await main(["digest", "--runs", "runs"], run.io, { cwd, emailEndpoint: api.url });
    expect(api.got).toHaveLength(1);
    expect(api.got[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    const sent = JSON.parse(api.got[0]?.body ?? "{}") as { subject: string; to: string[] };
    expect(sent.subject).toBe(
      "harbour-books.example: This week: 1 new thing to fix, 1 fixed and 2 older ones still open.",
    );
    expect(sent.to).toEqual(["owner@harbour-books.example"]);
    expect(run.err()).toContain("Emailed the digest.\n");
    for (const text of [
      run.out(),
      run.err(),
      readFileSync(join(cwd, "gaugeline-digest.md"), "utf8"),
      readFileSync(join(cwd, "gaugeline-digest.html"), "utf8"),
    ])
      expect(text).not.toContain(KEY);
  });

  it("a missing folder, a file that isn't a run and an unknown time zone stop it (exit 2)", async () => {
    const cwd = workdir();
    let run = capture();
    expect(await main(["digest", "--runs", "nope"], run.io, { cwd })).toBe(2);
    expect(run.err()).toContain("is not a folder of saved runs.");
    run = capture();
    expect(
      await main(["digest", "--runs", "runs", "--time-zone", "Mars/Olympus"], run.io, { cwd }),
    ).toBe(2);
    expect(run.err()).toContain('--time-zone: "Mars/Olympus" is not a time zone.');
    writeFileSync(join(cwd, "runs", "notes.json"), "{}");
    run = capture();
    expect(await main(["digest", "--runs", "runs"], run.io, { cwd })).toBe(2);
    expect(run.err()).toMatch(/notes\.json is not a saved Gaugeline run/);
    run = capture();
    expect(await main(["digest"], run.io, { cwd })).toBe(2);
    expect(run.err()).toContain("gaugeline digest needs the folder of saved runs");
    expect(existsSync(join(cwd, "gaugeline-digest.md"))).toBe(false);
  });

  it("gaugeline digest --help prints the digest usage", async () => {
    const run = capture();
    expect(await main(["digest", "--help"], run.io, {})).toBe(0);
    expect(run.out()).toContain("Usage: gaugeline digest --runs <folder> [options]");
    expect(run.out()).toContain("--time-zone <value>");
    expect(run.out()).not.toContain("--slack");
  });
});
