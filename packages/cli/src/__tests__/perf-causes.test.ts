import { startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * The framework-cause checks (PERF-03), through the built bin: Quillfeather Bakery is an invented bakery whose page
 * has a 3D scene that starts at load, a lazy and oversized first image, an animation that moves layout and no
 * fallback for a small phone. The passing copy has none of them.
 */
const sites: Fixture[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
});

const IDS = [
  "perf-webgl-autostart",
  "perf-lcp-image",
  "perf-animation-reflow",
  "perf-no-lowend-fallback",
];
type Out = { findings: { checkId: string; severity: string; evidence: string }[] };

async function run(name: string) {
  const site = await startFixture(name);
  sites.push(site);
  const r = await runBin([site.origin, "--allow-private", "--no-open", "--json"]);
  expect(r.stderr).not.toContain("Unknown option");
  const all = (JSON.parse(r.stdout) as Out).findings;
  return { all: all.filter((f) => IDS.includes(f.checkId)), site };
}

describe("framework causes: end to end", () => {
  it("finds all four on the bakery, each with its own evidence", async () => {
    const { all } = await run("framework-causes");
    // Highest severity first, then in registration order (sorted by id).
    expect(all.map((f) => [f.checkId, f.severity])).toEqual([
      ["perf-animation-reflow", "medium"],
      ["perf-lcp-image", "medium"],
      ["perf-webgl-autostart", "medium"],
      ["perf-no-lowend-fallback", "low"],
    ]);
    const by = Object.fromEntries(all.map((f) => [f.checkId, f.evidence]));
    expect(by["perf-webgl-autostart"]).toContain("new THREE.WebGLRenderer is called");
    expect(by["perf-lcp-image"]).toContain("is lazy-loaded");
    expect(by["perf-lcp-image"]).toContain("asked for at 3840 pixels wide but shown 800 wide");
    expect(by["perf-animation-reflow"]).toContain("animate layout properties (left)");
    expect(by["perf-animation-reflow"]).toContain("1 script has an animation loop");
    expect(by["perf-no-lowend-fallback"]).toContain("a 3D scene and an autoplaying video");
  });

  it("finds nothing on the passing copy", async () => {
    const { all } = await run("framework-causes-clean");
    expect(all).toEqual([]);
  });

  it("asks only GET or HEAD, and reads the site's own scripts once", async () => {
    const { site } = await run("framework-causes");
    expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
    const js = site.requests.filter((q) => q.path === "/js/scene.js" && q.method === "GET");
    expect(js).toHaveLength(1);
  });
});
