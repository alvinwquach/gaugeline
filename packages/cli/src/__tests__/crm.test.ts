import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR } from "@gaugeline/fixtures";
import { replayMcp, staticSite, type McpReplay } from "@gaugeline/testkit";
import { NO_TRANSPORT, SALESFORCE_READ_ONLY_URL } from "@gaugeline/core";
import { afterEach, describe, expect, it } from "vitest";
import { REPORT_FILE, main } from "../main.js";

const SITE = `${SITES_DIR}crm-leads`;
const HOST = "tideline-coaching.example";
const NOW = () => new Date("2026-11-10T18:00:00Z");
// Built at run time so no secret scanner sees a literal.
const TOKEN = ["00D", "invented", "org", "token", "0123456789abcdef"].join(".");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function workdir(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-crm-"));
  dirs.push(dir);
  if (config === undefined)
    cpSync(join(SITE, "gaugeline.crm.json"), join(dir, "gaugeline.crm.json"));
  else if (config !== null) writeFileSync(join(dir, "gaugeline.crm.json"), JSON.stringify(config));
  return dir;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" } as Record<string, string | undefined>,
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const site = (asked: string[] = []) =>
  staticSite(HOST, SITE, (url) => {
    asked.push(url.hostname);
    return Promise.reject(new Error(`unexpected request to ${url.hostname}`));
  });

type Result = {
  findings: { checkId: string; evidence: string }[];
  couldNotCheck: { id: string; reason: string }[];
  passed: string[];
  failed: string[];
};

describe("crm: end to end (CLI, recorded MCP responses)", () => {
  it("12 of 40 leads with a blank source are found, with the field and five record ids", async () => {
    const run = capture();
    run.io.env.SALESFORCE_MCP_ACCESS_TOKEN = TOKEN;
    let replay: McpReplay | undefined;
    const given: { server: string; env: Record<string, string | undefined> }[] = [];
    const code = await main([`https://${HOST}/`, "--no-open", "--json"], run.io, {
      version: "0.1.0",
      cwd: workdir(),
      now: NOW,
      fetcher: { transport: site() },
      crmTransport: (server, env) => {
        given.push({ server, env });
        return (replay = replayMcp("tideline-leads"));
      },
    });
    expect(code, run.err()).toBe(0);
    const result = JSON.parse(run.out()) as Result;
    expect(result.findings.find((f) => f.checkId === "crm-lead-source")?.evidence).toBe(
      "12 of 40 leads created since 2026-11-03 have an empty LeadSource. Example record ids: 00Q5e00000Tx002, 00Q5e00000Tx003, 00Q5e00000Tx007, 00Q5e00000Tx009, 00Q5e00000Tx012",
    );
    expect(result.findings.map((f) => f.checkId)).toContain("crm-field-names");
    // The transport got the validated read-only address and only the CRM's variable.
    expect(given).toEqual([
      { server: SALESFORCE_READ_ONLY_URL, env: { SALESFORCE_MCP_ACCESS_TOKEN: TOKEN } },
    ]);
    expect(replay?.seen.length).toBeLessThanOrEqual(8);
    expect(
      result.passed.filter((id) => id.startsWith("crm-lead") || id === "crm-went-quiet"),
    ).toEqual(expect.arrayContaining(["crm-went-quiet"]));
  });

  it("the token and the leads' details reach no output: stdout, stderr (--verbose), the JSON result and the HTML report", async () => {
    const cwd = workdir();
    const first = capture();
    first.io.env.SALESFORCE_MCP_ACCESS_TOKEN = TOKEN;
    const deps = {
      version: "0.1.0",
      cwd,
      now: NOW,
      fetcher: { transport: site() },
      crmTransport: () => replayMcp("tideline-leaky"),
    };
    await main([`https://${HOST}/`, "--no-open", "--verbose"], first.io, deps);
    const html = readFileSync(join(cwd, REPORT_FILE), "utf8");
    const second = capture();
    second.io.env.SALESFORCE_MCP_ACCESS_TOKEN = TOKEN;
    await main([`https://${HOST}/`, "--no-open", "--json"], second.io, deps);
    const seen = { stdout: first.out(), stderr: first.err(), json: second.out(), html };
    expect(seen.html.length).toBeGreaterThan(100);
    for (const [where, text] of Object.entries(seen)) {
      expect(text, where).not.toContain(TOKEN);
      expect(text, where).not.toMatch(
        /Rowan|Ellery|Okafor|Lindqvist|Vance|invented\.example|555-01|knee rehab/,
      );
    }
  });

  it("a gaugeline.crm.json that names a server that can write is exit 2 before anything is requested", async () => {
    const run = capture();
    const asked: string[] = [];
    let built = false;
    const code = await main([`https://${HOST}/`, "--no-open"], run.io, {
      version: "0.1.0",
      cwd: workdir({
        salesforce: { server: "https://api.salesforce.com/platform/mcp/v1/platform/sobject-all" },
      }),
      now: NOW,
      fetcher: { transport: site(asked) },
      crmTransport: () => ((built = true), replayMcp("tideline-leads")),
    });
    expect(code).toBe(2);
    expect(run.err()).toMatch(
      /gaugeline\.crm\.json: salesforce\.server: must be Salesforce's read-only objects server/,
    );
    expect(built).toBe(false);
    expect(asked).toEqual([]);
  });

  it("a token in the file is refused, not read", async () => {
    const run = capture();
    const code = await main([`https://${HOST}/`, "--no-open"], run.io, {
      version: "0.1.0",
      cwd: workdir({ salesforce: { accessToken: TOKEN } }),
      now: NOW,
      fetcher: { transport: site() },
    });
    expect(code).toBe(2);
    expect(run.err()).not.toContain(TOKEN);
  });

  it("with the file but no way to reach the server in this build, the lead checks say so and pass nothing", async () => {
    const run = capture();
    const code = await main([`https://${HOST}/`, "--no-open", "--json"], run.io, {
      version: "0.1.0",
      cwd: workdir(),
      now: NOW,
      fetcher: { transport: site() },
    });
    expect(code, run.err()).toBe(0);
    const result = JSON.parse(run.out()) as Result;
    const crm = result.couldNotCheck.filter(
      (c) => c.id.startsWith("crm-") && /lead-source|field-names|went-quiet/.test(c.id),
    );
    expect(crm.map((c) => c.id).sort()).toEqual([
      "crm-field-names",
      "crm-lead-source",
      "crm-went-quiet",
    ]);
    for (const c of crm) expect(c.reason).toBe(NO_TRANSPORT);
    for (const id of ["crm-lead-source", "crm-field-names", "crm-went-quiet"])
      expect(result.passed).not.toContain(id);
  });

  it("without gaugeline.crm.json the lead checks are not run: nothing passed, nothing requested", async () => {
    const run = capture();
    let built = false;
    const code = await main([`https://${HOST}/`, "--no-open", "--json"], run.io, {
      version: "0.1.0",
      cwd: workdir(null),
      now: NOW,
      fetcher: { transport: site() },
      crmTransport: () => ((built = true), replayMcp("tideline-leads")),
    });
    expect(code, run.err()).toBe(0);
    const result = JSON.parse(run.out()) as Result;
    for (const id of ["crm-lead-source", "crm-field-names", "crm-went-quiet"]) {
      expect(result.passed).not.toContain(id);
      expect(result.failed).not.toContain(id);
      expect(result.findings.map((f) => f.checkId)).not.toContain(id);
      expect(result.couldNotCheck.map((c) => c.id)).not.toContain(id);
    }
    expect(built).toBe(false);
  });
});
