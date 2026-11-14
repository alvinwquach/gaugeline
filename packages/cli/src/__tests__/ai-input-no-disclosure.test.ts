import { startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * ai-input-no-disclosure (AI-13), through the built bin: Juniper Street Dental is an invented practice whose question
 * box sends what a visitor types to a model provider. The passing copy says an AI assistant writes the answers.
 */
const sites: Fixture[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
});

type Out = { findings: { checkId: string; severity: string; evidence: string }[] };
async function run(name: string) {
  const site = await startFixture(name);
  sites.push(site);
  const r = await runBin([site.origin, "--allow-private", "--no-open", "--json"]);
  expect(r.stderr).not.toContain("Unknown option");
  const ours = (JSON.parse(r.stdout) as Out).findings.filter(
    (f) => f.checkId === "ai-input-no-disclosure",
  );
  return { r, ours, site };
}

describe("ai-input-no-disclosure: end to end", () => {
  it("finds the question box that sends input to an AI host with no words about it, and prints no page text", async () => {
    const { r, ours } = await run("ai-disclosure");
    expect(ours.map((f) => [f.severity, f.evidence])).toEqual([
      [
        "medium",
        "a script on / sends what a visitor types to api.openai.com, and nothing on the page says an AI answers",
      ],
    ]);
    expect(r.stdout).not.toContain("Ask the front desk");
  });

  it("finds nothing on the passing copy, which says an AI assistant writes the answers", async () => {
    const { ours } = await run("ai-disclosure-told");
    expect(ours).toEqual([]);
  });

  it("asks only by GET or HEAD, and never the provider's address", async () => {
    const { site } = await run("ai-disclosure");
    expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
    expect(site.requests.filter((q) => q.path.startsWith("/v1"))).toEqual([]);
  });
});
