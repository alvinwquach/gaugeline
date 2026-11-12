import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFixture, type Fixture } from "@gaugeline/fixtures";
import { jsonOf, textOf } from "./helpers.js";

const bin = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const fixtures: Fixture[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
});

/** The built bin over stdio, as an assistant starts it. Needs `pnpm build`, like the CLI's own end-to-end tests. */
async function spawnServer(args: string[] = []) {
  expect(existsSync(bin), "run pnpm build first: the built bin is under test").toBe(true);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("npm_config_")) env[k] = v;
  const client = new Client({ name: "e2e", version: "0" });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [bin, ...args],
      env,
      stderr: "ignore",
    }),
  );
  return client;
}

describe("gaugeline-mcp over stdio (built bin)", () => {
  it("prints help and a version without starting a server", () => {
    const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Read-only");
    expect(help.stdout).not.toMatch(/--owner-consent/);
    const bad = spawnSync(process.execPath, [bin, "--nope"], { encoding: "utf8" });
    expect(bad.status).toBe(2);
  });

  it("lists six tools and checks a fixture site end to end", async () => {
    const fixture = await startFixture("tampered");
    fixtures.push(fixture);
    const client = await spawnServer([
      "--allow-private",
      "--root",
      process.cwd(),
      "--plan-base",
      fixture.origin,
    ]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compare_runs",
      "draft_fix",
      "explain_finding",
      "list_checks",
      "plan_check",
      "run_check",
    ]);
    const run = jsonOf<{ runId: string; findings: { id: string }[] }>(
      await client.callTool({ name: "run_check", arguments: { url: `${fixture.origin}/` } }),
    );
    expect(run.findings.length).toBeGreaterThan(0);
    expect([...fixture.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
    const draft = jsonOf<{ applied: boolean }>(
      await client.callTool({ name: "draft_fix", arguments: { findingId: run.findings[0]?.id } }),
    );
    expect(draft.applied).toBe(false);
  }, 60000);

  it("refuses the same fixture when started without --allow-private", async () => {
    const fixture = await startFixture("clean");
    fixtures.push(fixture);
    const client = await spawnServer();
    const r = textOf(
      await client.callTool({ name: "run_check", arguments: { url: `${fixture.origin}/` } }),
    );
    // Refused before a socket opens: a could-not-check entry, and the fixture saw nothing.
    expect(r.isError || JSON.parse(r.text).couldNotCheck.length > 0).toBe(true);
    expect(fixture.total).toBe(0);
  }, 60000);
});
