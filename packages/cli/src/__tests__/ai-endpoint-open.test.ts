import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * ai-endpoint-open (AI-12), a probing check, through the built bin: Cedar Row Tea Room is an invented tea room whose
 * menu helper talks to a model. One route lists its models to anyone, one shows the provider's error text.
 */
const sites: Fixture[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

type Out = { findings: { checkId: string; severity: string; evidence: string }[] };
async function run(name: string, files: readonly string[], more: string[] = []) {
  const site = await startFixture(name);
  sites.push(site);
  const cwd = mkdtempSync(join(tmpdir(), "gaugeline-ai-endpoints-"));
  dirs.push(cwd);
  for (const f of files) cpSync(join(SITES_DIR, name, f), join(cwd, f));
  const r = await runBin(
    [site.origin, "--allow-private", "--no-open", "--json", ...more],
    {},
    { cwd },
  );
  expect(r.stderr).not.toContain("Unknown option");
  const ours = (JSON.parse(r.stdout) as Out).findings.filter(
    (f) => f.checkId === "ai-endpoint-open",
  );
  return { r, ours, site };
}
const BOTH = ["gaugeline.ai.json", "gaugeline.consent.json"];
const paths = (site: Fixture) => site.requests.map((q) => `${q.method} ${q.path}`);

describe("ai-endpoint-open: end to end", () => {
  it("with consent and a modelEndpoints list, finds the open model list and the verbose error, and prints no text from either", async () => {
    const { r, ours } = await run("ai-endpoints", BOTH);
    expect(ours.map((f) => [f.severity, f.evidence])).toEqual([
      ["high", "/v1/models answers 200 and lists 2 models to anyone, with no login"],
      [
        "medium",
        "/api/chat answers 401 with the provider's own error text: a provider error type, a provider message, a key fragment",
      ],
    ]);
    for (const secret of ["tea-room-small", "Ab12", "dashboard"]) {
      expect(r.stdout).not.toContain(secret);
      expect(r.stderr).not.toContain(secret);
    }
    expect(r.stderr).toContain("Probing checks are on (gaugeline.consent.json)");
  });

  it("asks exactly the listed routes, once each, by GET, and nothing else of the kind", async () => {
    const { site } = await run("ai-endpoints", BOTH);
    const asked = paths(site).filter((p) => /\/(?:v1|api)\//.test(p));
    expect(asked.sort()).toEqual(["GET /api/assist", "GET /api/chat", "GET /v1/models"]);
    expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
  });

  it("without consent it asks none of the routes", async () => {
    const { ours, site } = await run("ai-endpoints", ["gaugeline.ai.json"]);
    expect(ours).toEqual([]);
    expect(paths(site).filter((p) => /\/(?:v1|api)\//.test(p))).toEqual([]);
  });

  it("with consent but no modelEndpoints list it asks none of the routes", async () => {
    const { ours, site } = await run("ai-endpoints", ["gaugeline.consent.json"]);
    expect(ours).toEqual([]);
    expect(paths(site).filter((p) => /\/(?:v1|api)\//.test(p))).toEqual([]);
  });

  it("finds nothing on the passing copy, whose routes answer 401, 405 and 403", async () => {
    const { ours } = await run("ai-endpoints-closed", BOTH);
    expect(ours).toEqual([]);
  });
});
