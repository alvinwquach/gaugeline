import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * ai-crawlers-directives (AI-14), through the built bin: Larkspur Family Law is an invented practice that wants AI
 * assistants to read its site. A header and a meta tag keep some away; the block copy still publishes llms.txt.
 */
const sites: Fixture[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

type Out = { findings: { checkId: string; severity: string; evidence: string; url: string }[] };
async function run(name: string, withConfig = true) {
  const site = await startFixture(name);
  sites.push(site);
  const cwd = mkdtempSync(join(tmpdir(), "gaugeline-ai-directives-"));
  dirs.push(cwd);
  if (withConfig)
    cpSync(join(SITES_DIR, name, "gaugeline.ai.json"), join(cwd, "gaugeline.ai.json"));
  const r = await runBin([site.origin, "--allow-private", "--no-open", "--json"], {}, { cwd });
  expect(r.stderr).not.toContain("Unknown option");
  const all = (JSON.parse(r.stdout) as Out).findings;
  return { r, ours: all.filter((f) => f.checkId === "ai-crawlers-directives"), all, site };
}

describe("ai-crawlers-directives: end to end", () => {
  it("allow with noai in the header and a noindex meta tag for one crawler: one finding naming both, and robots.txt is not blamed", async () => {
    const { ours, all } = await run("ai-directives");
    expect(ours).toHaveLength(1);
    expect(ours[0]?.severity).toBe("medium");
    expect(ours[0]?.evidence).toMatch(
      /^gaugeline\.ai\.json says to allow every AI crawler; for \/, the X-Robots-Tag header says noai and noimageai for GPTBot \(OpenAI\), .+ and the ClaudeBot meta tag says noindex for ClaudeBot \(Anthropic\)$/,
    );
    expect(all.some((f) => f.checkId === "ai-crawlers-intent")).toBe(false);
  });

  it("block with robots.txt blocking every crawler and llms.txt still published: a finding about the file", async () => {
    const { ours, site } = await run("ai-directives-block");
    expect(ours.map((f) => f.evidence)).toEqual([
      "gaugeline.ai.json says to block every AI crawler, and the site publishes /llms.txt, a guide written for AI assistants",
    ]);
    expect(ours[0]?.url).toBe(`${site.origin}/llms.txt`);
  });

  it("allow with no signal on the page: no finding", async () => {
    const { ours } = await run("ai-directives-clean");
    expect(ours).toEqual([]);
  });

  it("without gaugeline.ai.json there is no intent, so nothing is compared", async () => {
    const { ours } = await run("ai-directives", false);
    expect(ours).toEqual([]);
  });

  it("asks only by GET or HEAD", async () => {
    const { site } = await run("ai-directives");
    expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
  });
});
