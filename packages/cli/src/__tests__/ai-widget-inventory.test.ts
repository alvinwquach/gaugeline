import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITES_DIR, startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * ai-widget-inventory (AI-11), through the built bin: Harbour Lane Physio is an invented clinic whose page loads an
 * Intercom chat and a Chatbase AI assistant. gaugeline.ai.json lists what the owner allows.
 */
const sites: Fixture[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

type Out = { findings: { checkId: string; severity: string; evidence: string }[] };
async function run(name: string, config?: unknown) {
  const site = await startFixture(name);
  sites.push(site);
  const cwd = mkdtempSync(join(tmpdir(), "gaugeline-widgets-"));
  dirs.push(cwd);
  if (config !== undefined) writeFileSync(join(cwd, "gaugeline.ai.json"), JSON.stringify(config));
  const r = await runBin([site.origin, "--allow-private", "--no-open", "--json"], {}, { cwd });
  expect(r.stderr).not.toContain("Unknown option");
  const ours = (JSON.parse(r.stdout) as Out).findings.filter(
    (f) => f.checkId === "ai-widget-inventory",
  );
  return { r, ours, site };
}

describe("ai-widget-inventory: end to end", () => {
  it("with the fixture's own gaugeline.ai.json, flags the AI assistant that is not on the list", async () => {
    const site = await startFixture("ai-widgets");
    sites.push(site);
    const cwd = mkdtempSync(join(tmpdir(), "gaugeline-widgets-"));
    dirs.push(cwd);
    cpSync(join(SITES_DIR, "ai-widgets", "gaugeline.ai.json"), join(cwd, "gaugeline.ai.json"));
    const r = await runBin([site.origin, "--allow-private", "--no-open", "--json"], {}, { cwd });
    const ours = (JSON.parse(r.stdout) as Out).findings.filter(
      (f) => f.checkId === "ai-widget-inventory",
    );
    expect(ours.map((f) => [f.severity, f.evidence])).toEqual([
      [
        "medium",
        "Chatbase (AI assistant, www.chatbase.co) loads on / and is not in the aiWidgets list in gaugeline.ai.json",
      ],
    ]);
  });

  it("with no list, lists both widgets in one low finding", async () => {
    const { ours } = await run("ai-widgets");
    expect(ours).toHaveLength(1);
    expect(ours[0]?.severity).toBe("low");
    expect(ours[0]?.evidence).toContain(
      "Intercom (chat, widget.intercom.io) and Chatbase (AI assistant, www.chatbase.co)",
    );
  });

  it("with both on the list, finds nothing", async () => {
    const { ours } = await run("ai-widgets", {
      aiWidgets: { allowed: ["intercom", "chatbase.co"] },
    });
    expect(ours).toEqual([]);
  });

  it("finds nothing on the page with no widget, and never asks the widget's host", async () => {
    const { ours, site } = await run("ai-widgets-clean", { aiWidgets: { allowed: [] } });
    expect(ours).toEqual([]);
    expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
  });

  it("a settings file with a bad aiWidgets entry is refused, naming the file", async () => {
    const site = await startFixture("ai-widgets");
    sites.push(site);
    const cwd = mkdtempSync(join(tmpdir(), "gaugeline-widgets-"));
    dirs.push(cwd);
    writeFileSync(
      join(cwd, "gaugeline.ai.json"),
      JSON.stringify({ aiWidgets: { allowed: ["https://x.example/y"] } }),
    );
    const r = await runBin([site.origin, "--allow-private", "--no-open", "--json"], {}, { cwd });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("gaugeline.ai.json");
  });
});
