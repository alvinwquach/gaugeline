import { PLANTED, startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * ai-key-in-js (AI-10), through the built bin: Larkspur Yoga is an invented studio whose booking helper
 * calls a model provider from the browser with a key in its code. The fixed copy calls the studio's own route.
 */
const sites: Fixture[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
});
async function run(name: string) {
  const site = await startFixture(name);
  sites.push(site);
  const r = await runBin([site.origin, "--allow-private", "--no-open", "--json"]);
  return { r, site };
}
type Out = { findings: { checkId: string; evidence: string }[] };
const ours = (stdout: string) =>
  (JSON.parse(stdout) as Out).findings.filter((f) => f.checkId === "ai-key-in-js");

describe("ai-key-in-js: end to end", () => {
  it("finds the provider and the file in a script file and an inline script, and prints no key", async () => {
    const { r } = await run("ai-key-in-js");
    expect(r.stderr).not.toContain("Unknown option");
    const evidence = ours(r.stdout).map((f) => f.evidence);
    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toMatch(/^Groq key in inline script 1 on \/ at byte \d+$/);
    expect(evidence[1]).toMatch(/^OpenAI key in \/assets\/helper\.js at byte \d+$/);
    for (const planted of [PLANTED["ai-openai-project"], PLANTED["ai-groq"]]) {
      for (const part of [planted?.slice(0, 8), planted?.slice(-6)]) {
        expect(part).toBeTruthy();
        expect(r.stdout).not.toContain(part);
        expect(r.stderr).not.toContain(part);
      }
    }
  });

  it("finds nothing on the fixed copy, which calls the studio's own route", async () => {
    const { r } = await run("ai-key-in-js-clean");
    expect(r.stderr).not.toContain("Unknown option");
    expect(ours(r.stdout)).toEqual([]);
  });

  it("asks only by GET or HEAD, and never the provider's address or a route the page calls with the key", async () => {
    const { site } = await run("ai-key-in-js");
    expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
    expect(site.requests.filter((q) => /^\/(?:api|v1)\b/.test(q.path))).toEqual([]);
  });
});
