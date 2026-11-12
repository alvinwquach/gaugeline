import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const FILE = "examples/workflows/vercel-gate.yml";
const text = readFileSync(root(FILE), "utf8");

type Doc = Record<string, unknown>;
const doc = parse(text) as Doc;
const job = (doc["jobs"] as Record<string, Doc>)["gate"]!;
const steps = job["steps"] as Doc[];

describe("examples/workflows/vercel-gate.yml (X51: hold a Vercel deploy on Gaugeline's result)", () => {
  it("runs on deployment_status, the event Vercel's GitHub integration sends, and nothing else", () => {
    // "on" parses as the key "on" in YAML 1.2 (the yaml package); a 1.1 parser would read it as true.
    const on = doc["on"] as Doc;
    expect(Object.keys(on)).toEqual(["deployment_status"]);
  });

  it("only looks at a successful Preview deployment, so production is never gated by this job", () => {
    const cond = String(job["if"]);
    expect(cond).toContain("github.event.deployment_status.state == 'success'");
    expect(cond).toContain("github.event.deployment.environment == 'Preview'");
    expect(cond).not.toMatch(/Production/);
  });

  it("runs deploy-gate with --block on the address the event carries, through the environment", () => {
    const run = steps.map((s) => String(s["run"] ?? "")).join("\n");
    expect(run).toContain('npx --yes gaugeline deploy-gate "$TARGET_URL" --block');
    const env = steps.find((s) => s["env"])?.["env"] as Record<string, string>;
    expect(env["TARGET_URL"]).toBe("${{ github.event.deployment_status.target_url }}");
    // The address is never pasted into the script text.
    expect(run).not.toContain("${{");
  });

  it("passes the exit code through: no continue-on-error, no || true, no remapped exit", () => {
    expect(text).not.toMatch(/continue-on-error/);
    expect(text).not.toMatch(/\|\|\s*true\b/);
    expect(text).not.toMatch(/exit (3|4|5|255)\b/);
    expect(job["continue-on-error"]).toBeUndefined();
  });

  it("reads the bypass secret from secrets only and never echoes it", () => {
    expect(text).toContain(
      "GAUGELINE_VERCEL_BYPASS: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}",
    );
    for (const l of text.split("\n")) {
      expect(l).not.toMatch(/\becho\b/);
      expect(l).not.toMatch(/\bset -x\b/);
    }
    expect(text).not.toMatch(/sk_(live|test)_|ghp_|vercel_[A-Za-z0-9]{10,}/);
  });

  it("has read-only permissions and holds no Vercel token: Gaugeline writes nothing to Vercel", () => {
    expect(doc["permissions"]).toEqual({ contents: "read" });
    expect(text).not.toMatch(/VERCEL_TOKEN|vercel (deploy|promote|--prod)|api\.vercel\.com/);
  });

  it("never uses a probing flag; the gate stays public GET and HEAD only", () => {
    expect(text).not.toMatch(/--owner-consent|--routes|--allow-private/);
  });

  it("pins every action to a full commit SHA with its version in a comment, on Node 22 or newer", () => {
    const uses = text.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses) expect(l).toMatch(/@[0-9a-f]{40}\s+#\s*v\d+(\.\d+)*/);
    const node = steps.find((s) => String(s["uses"] ?? "").includes("setup-node"));
    expect(
      Number((node?.["with"] as Record<string, unknown>)["node-version"]),
    ).toBeGreaterThanOrEqual(22);
  });

  it("tells the reader to make the job a required status check, which is what holds the merge", () => {
    expect(text).toMatch(/required status check/i);
  });
});
